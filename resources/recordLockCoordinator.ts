import { performance } from 'node:perf_hooks';
import { Packr } from 'msgpackr';
import harperLogger from '../utility/logging/harper_logger.ts';
import { ClientError, LockUnavailableError } from '../utility/errors/hdbError.ts';
import { MAX_LOCK_LEASE_MS, MIN_LOCK_LEASE_MS } from './recordLock.ts';

/**
 * Cluster-wide record locks (harper#483, Phase 1): amortized per-record ownership.
 * Design note: `docs/record-lock-ownership.md`.
 *
 * `Table.lock()` acquires the node's rocksdb-js key lock first, which bounds this process to one
 * outstanding acquisition per key; only then does it run the cluster step here. That step has three
 * levels at three very different rates:
 *
 * - **The home map** — `(generation, homes[])`, published by an operator through harper-pro and
 *   handed to core through `transport.homeMap()`. It is immutable for the life of its generation:
 *   core never computes it, never advances it, and never proceeds without it.
 * - **The home node** — within a generation, a key's arbiter is a rendezvous hash over `homes[]`
 *   (§4.4). One arbiter per key is trivially exclusive, so there is no grant state machine at all:
 *   no deferral queues, no `(tsR, nodeId)` tiebreak, no synthesized grants, no split votes, no
 *   revocation protocol between peers.
 * - **The delegation** — the exclusive right to admit critical sections on one key for a bounded
 *   time. While one is live, `lock()`/`unlock()` are pure Phase 0: the local key lock and **zero
 *   cluster messages**. Releasing the application lock does not release the delegation, so a node
 *   writing the same record repeatedly pays one round and then nothing.
 *
 * Two properties carry the safety argument, and both are enforced rather than assumed:
 *
 * - **One delegate per key per home.** A home never has two live delegations for a key, and a
 *   successor delegation is issued only after the predecessor's has been recalled-and-drained or has
 *   provably expired on the home's own clock plus skew. Every expiry decision on both sides is made
 *   on that side's monotonic clock; no remote timestamp is ever compared against a local one.
 * - **A delegation bounds every handle it admitted.** An admission may not outlive its delegation, so
 *   recall revokes capability rather than merely closing the door (§6): the commit-time lease fence
 *   in `DatabaseTransaction` rejects a staged write whose handle has expired, and a recall expires
 *   those handles before the release is acknowledged.
 *
 * `nodeId` here is the globally stable node NAME. It is deliberately not the audit entry's `nodeId`:
 * `nodeIdMapping.ts` hands out per-node short ids (0 is always local), so the same node has different
 * ids on different nodes and any ordering built on them would order the same pair differently on two
 * nodes.
 *
 * What this file does NOT yet implement, deliberately: the successor-freshness fence of §7 — the
 * inherited `(origin → position)` dependency set on the release entry, and the recovery barrier.
 * That is harper#2542. Until it lands, a delegation handoff carries exclusion but not the
 * clean-handoff freshness §2 states, which is why the feature stays gated off (`replication.recordLocks`)
 * and why no core build registers a transport.
 */

/** Margin a home adds to a delegation it issued, so the delegate always stops admitting first. */
export const LOCK_LEASE_SKEW_MS = 5_000;
/**
 * How long a delegation runs, independent of any one caller's lock lease. It MUST be longer than the
 * longest lease it will admit, or the amortization does not exist: a delegation sized to the caller's
 * lease has no room left for the next lock, so every repeat `lock()` renews and pays a round trip —
 * exactly the cost this design is built to remove.
 */
export const DELEGATION_LEASE_MS = MAX_LOCK_LEASE_MS + 60_000;
/**
 * Below this an admission map is too small for its dead entries to matter, so the expiry sweep in
 * `#pruneAdmissions` does not run at all; above it the map may reach twice the live set first.
 */
const ADMISSION_SWEEP_FLOOR = 64;
const TICK_INTERVAL_MS = 100;
const WARN_INTERVAL_MS = 60_000;
/**
 * Bounds the grants ONE TABLE's coordinator can accumulate — a home may never forget a delegation
 * before its expiry, so the only bound available is a refusal to issue more. There is one coordinator
 * per table, so the process-wide exposure is this times the number of tables under lock pressure; a
 * true process-level bound is harper#2581 and is sized with the enablement measurements.
 */
const MAX_DELEGATIONS_PER_TABLE = 10_000;
/** Bounds what a single peer can make one table's home retain, so one node cannot exhaust it. */
const MAX_DELEGATIONS_PER_REQUESTER = 2_000;
/** Bounds expiry work per tick, so a burst of expiries cannot stall the event loop. */
const MAX_EXPIRIES_PER_TICK = 256;
const MAX_NODE_NAME_LENGTH = 255;
/** A node whose identity resolved to one of these is not distinctive enough to be a ring member. */
const NON_DISTINCTIVE_NODE_NAMES = new Set(['127.0.0.1', '::1', 'localhost', '0.0.0.0']);

/**
 * The only control entry left. `lockRequest`/`lockGrant` belonged to the Ricart–Agrawala rule the
 * design note replaces; they never shipped enabled, so their nibbles were retired rather than
 * migrated (`auditStore.ts`). Delegation request/grant/recall are unicast over the transport, not
 * entries — only the release stays on the replicated log, because it is what orders a handoff behind
 * the delegate's own data writes.
 */
export type LockControlType = 'lockRelease';

/**
 * The operator-agreed map a key's home is derived from. Supplied by harper-pro; core never computes
 * it and never advances it. Immutable for the life of a generation — nothing a node observes changes
 * it, which is why no agreement protocol runs here (§4).
 */
export interface LockHomeMap {
	/** Monotonic per database. Part of the fencing token, so it must never go backwards. */
	generation: number;
	/** The nodes that may home a key. Order is irrelevant — the ring hashes each name independently. */
	homes: string[];
	/**
	 * This node's durably persisted, monotonic incarnation counter as a home (§5.1). A random value
	 * makes a stale reply identifiable but not ORDERABLE: a home that restarts and re-issues counter 1
	 * after having issued counter 50 would let a delayed counter-50 write defeat its successor.
	 */
	homeIncarnation: number;
}

/**
 * A delegation's fencing token, ordered lexicographically as
 * `(generation, homeIncarnation, counter)`. Comparable across homes only within a generation, which
 * is all that is needed: a key has exactly one home per generation.
 */
export type FencingToken = readonly [generation: number, homeIncarnation: number, counter: number];

export function compareTokens(a: FencingToken, b: FencingToken): number {
	return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

export interface LockControlEntry {
	type: LockControlType;
	/** The locked record's id. Control entries carry it here, never as the audit entry's recordId. */
	key: any;
	/** Node that held the delegation being released. */
	requester: string;
	/**
	 * The released delegation's whole fencing token. The counter alone is NOT enough to identify it: a
	 * home that restarts, or whose coordinator is recreated, begins counting again, so a delayed
	 * release from a previous incarnation would match a live grant's counter and clear it while its
	 * delegate is still admitting.
	 */
	token: FencingToken;
}

/**
 * What a home replies to a delegation request. One shape rather than a discriminated union: the
 * repo compiles with `strict: false`, where TypeScript does not narrow a union on a boolean literal,
 * so a union here would type-check the denial fields as absent on every branch and then not enforce
 * it. `granted` says which half is populated.
 */
export interface DelegationReply {
	granted: boolean;
	/** Granted only. */
	token?: FencingToken;
	/** Granted only. How long the delegate may admit for, as a DURATION — never a remote clock reading. */
	leaseMs?: number;
	/**
	 * Denied only. `contended` is retryable within the caller's own wait budget; `generation` means
	 * refresh the home map; `quarantine` means the home is inside its §4.3 restart interval and cannot
	 * be waited out by any legal caller, so it converts to 503 rather than burning the wait budget.
	 */
	reason?: 'contended' | 'generation' | 'capacity' | 'not-home' | 'quarantine';
	/** Denied with `generation`, so a stale requester can re-derive the ring without another round trip. */
	generation?: number;
	retryAfterMs?: number;
}

export interface DelegationRequest {
	key: any;
	/** The asking node. Established by the transport, never read from an untrusted payload. */
	requester: string;
	generation: number;
	leaseMs: number;
}

export interface DelegationRecall {
	key: any;
	token: FencingToken;
}

/**
 * Supplied by harper-pro. Core never computes cluster topology; it only refuses to promise a
 * cluster-wide lock that this contract cannot back.
 */
export interface ClusterLockTransport {
	/**
	 * The operator-agreed home map for the database, or undefined while none is available — before the
	 * node has the current generation, or while peers disagree about its digest. Core fails closed on
	 * undefined rather than guessing a ring.
	 *
	 * **One obligation core cannot check, and relies on** (§4.3): a generation change is
	 * operator-sequenced, so `g+1` may only be answered here once the control plane's one-shot
	 * activation record is active — every old home quiesced (each acknowledgement bound to the
	 * acknowledger's `homeIncarnation`, so a restart during the drain invalidates it) or externally
	 * fenced, then `DELEGATION_LEASE_MS + skew` elapsed. Core cannot observe what happened on other
	 * nodes; the operator can.
	 *
	 * The other interval — a restart of *this* process — is core's own, because a generation does not
	 * advance on a restart and there is no external event to hang it on. See `#grantableAfterMono`.
	 */
	homeMap(database: string): LockHomeMap | undefined;
	/**
	 * Overrides core's cold-start grant quarantine (§4.3). Set it only where a previous incarnation
	 * of this process provably issued nothing — a fresh database, a first start, or a test. Omitted
	 * means core enforces the full `DELEGATION_LEASE_MS + skew` from process start.
	 */
	grantableAfterMono?: number;
	/**
	 * Whether this worker thread owns lock coordination for the process. Coordinator state is
	 * per-thread while the key lock it arbitrates is process-wide, so a second thread running its own
	 * delegations would arbitrate against a different view. Core fails closed off the owner thread.
	 */
	ownsCoordination(): boolean;
	/** Ask `node` (the key's home) for a delegation. Unicast; rejects if the node is unreachable. */
	requestDelegation(
		node: string,
		database: string,
		table: string,
		request: DelegationRequest
	): Promise<DelegationReply>;
	/** Home → delegate. Resolves once the delegate has drained and stopped admitting. */
	recallDelegation(node: string, database: string, table: string, recall: DelegationRecall): Promise<void>;
	/** Emit a control entry. Optional: core writes it to the table's transaction log when omitted. */
	writeControl?(table: string, entry: LockControlEntry): Promise<void> | void;
	/**
	 * Assigned at registration so a transport can push a received entry in directly. `author` is the
	 * node the entry was written by, established by the transport, not read from the payload.
	 */
	onControlEntry?(database: string, table: string, entry: LockControlEntry, author: string): void;
	/** Assigned at registration. Inbound delegation request from a peer, for a key this node homes. */
	onDelegationRequest?(database: string, table: string, request: DelegationRequest): Promise<DelegationReply>;
	/** Assigned at registration. Inbound recall from a key's home. */
	onDelegationRecall?(database: string, table: string, recall: DelegationRecall): Promise<void>;
}

// A private structure dictionary, so a control payload can never contribute to — or depend on — the
// table's own, and never passes through schema projection (see writeLockControlEntry in Table.ts).
// Record mode stays ON deliberately: the reader is the receiving table's decoder (via
// `auditRecord.getValue`), which repurposes a range of positive fixints as structure ids. A payload
// packed without record mode writes an integer record key of 64..127 as a bare fixint, which that
// decoder then reads as a structure header and the whole entry fails to decode.
let controlStructures: unknown[] = [];
let controlPackr = new Packr({ structures: controlStructures });

export function encodeLockControlPayload(entry: LockControlEntry): Uint8Array {
	const [generation, homeIncarnation, counter] = entry.token;
	return controlPackr.pack([entry.key, entry.requester, generation, homeIncarnation, counter]);
}

function isNodeName(value: unknown): value is string {
	return typeof value === 'string' && value.length > 0 && value.length <= MAX_NODE_NAME_LENGTH;
}

function isDuration(value: unknown, min: number, max: number): value is number {
	return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
}

/**
 * Accept exactly what `ordered-binary` encodes, because that is what `keyIdOf` runs on the key.
 * Refusing a shape the encoder handles makes the home answer `not-home` for a key nobody holds, and
 * the requester retries that to its own 423. A `Uint8Array` returns from the unpack as a `Buffer`
 * and a small `bigint` as a `number`; both encode to the same stored key, which is the identity at
 * issue rather than the JS value.
 */
function isEncodableKey(value: unknown): boolean {
	const type = typeof value;
	if (type === 'string' || type === 'bigint' || type === 'number' || type === 'boolean') return true;
	if (value === null || value instanceof Uint8Array) return true;
	return Array.isArray(value) && (value as unknown[]).every(isEncodableKey);
}

/**
 * Decode a received control payload, or undefined when it is not one this version understands. The
 * tuple length is validated exactly: a future version that grows the payload must bump the type
 * rather than widen this one, since a partially-understood release would clear a delegation on terms
 * the sender did not intend.
 */
export function decodeLockControlPayload(type: unknown, value: unknown): LockControlEntry | undefined {
	if (type !== 'lockRelease') return undefined;
	let tuple: unknown;
	try {
		tuple = value instanceof Uint8Array ? controlPackr.unpack(value) : value;
	} catch {
		return undefined;
	}
	if (!Array.isArray(tuple) || tuple.length !== 5) return undefined;
	try {
		return decodeTuple(tuple);
	} catch {
		// isEncodableKey recurses; a deeply nested array in a peer or replayed payload would otherwise
		// raise a RangeError into the replicated apply loop instead of being dropped as malformed.
		return undefined;
	}
}

function decodeTuple(tuple: unknown[]): LockControlEntry | undefined {
	const [key, requester, generation, homeIncarnation, counter] = tuple as [unknown, unknown, unknown, unknown, unknown];
	if (!isEncodableKey(key) || !isNodeName(requester)) return undefined;
	for (const part of [generation, homeIncarnation, counter])
		if (typeof part !== 'number' || !Number.isFinite(part)) return undefined;
	return {
		type: 'lockRelease',
		key,
		requester,
		token: [generation, homeIncarnation, counter] as FencingToken,
	};
}

/**
 * Rendezvous (highest-random-weight) hash: a key's home is the node with the greatest score for that
 * key. Chosen over a modulo of a key hash because a generation change moves only the keys homed on a
 * departing node, rather than re-homing the whole space — which matters because every re-homed key
 * pays the §7.2 recovery path on its next lock.
 *
 * The hash is FNV-1a over the member name and the key's stable id. It does not need to be
 * cryptographic: it is not a defense against anything, only a deterministic agreement between nodes
 * that already agree on `homes`.
 */
function scoreFor(member: string, keyId: string): number {
	let hash = 0x811c9dc5;
	for (let i = 0; i < member.length; i++) {
		hash ^= member.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	// A separator that cannot appear in either operand, so ("ab","c") and ("a","bc") cannot collide.
	hash ^= 0xff;
	hash = Math.imul(hash, 0x01000193);
	for (let i = 0; i < keyId.length; i++) {
		hash ^= keyId.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return hash >>> 0;
}

/**
 * The string the ring hashes for a key. §4.4 scopes it by database and table: hashing the record id
 * alone would home id `42` in every table of every database on the same node, concentrating unrelated
 * hot keys on one arbiter. The separator cannot appear in a name or a stringified key id.
 */
export function ringKeyFor(database: string, table: string, keyId: unknown): string {
	return `${database}\u0000${table}\u0000${String(keyId)}`;
}

export function homeFor(keyId: string, homes: string[]): string | undefined {
	let best: string | undefined;
	let bestScore = -1;
	for (const home of homes) {
		const score = scoreFor(home, keyId);
		// Ties break on the name so every node picks the same home from the same set.
		if (score > bestScore || (score === bestScore && best !== undefined && home > best)) {
			bestScore = score;
			best = home;
		}
	}
	return best;
}

/** A delegation this node holds: the right to admit critical sections on one key. */
interface Delegation {
	key: any;
	token: FencingToken;
	/** Monotonic deadline on THIS node. A delegate stops admitting here. */
	expiresMono: number;
	/** Set by a recall. No new admission may start, but live ones are drained first. */
	recalled: boolean;
	/**
	 * Every admission this delegation is still answerable for, by id. An entry stays here after its
	 * caller unlocks: §6 revokes CAPABILITY, not admission. A caller that staged a write and then
	 * called `unlock()` has nothing left to wait on, but its write is still uncommitted and would land
	 * after the successor was admitted — so surrender has to fence it, which means keeping its revoker
	 * until its own lease runs out or authority is lost.
	 *
	 * Addressed by id through `#admissions` rather than owned by the delegation OBJECT, so a handle
	 * survives a renewal with its delegation and is revoked with it when authority is actually lost.
	 */
	admissions: Map<number, Admission>;
	/**
	 * How many of those admissions have not unlocked yet. A drain waits for THIS to reach zero — an
	 * unlocked-but-staged write is revoked rather than waited for (harper#2580).
	 */
	holding: number;
	/** `admissions.size` at which the next full expiry sweep runs; see `#pruneAdmissions`. */
	sweepAtSize: number;
	/** Resolvers waiting for the drain to finish, so recall can reply once rather than poll. */
	drained?: (() => void)[];
}

/** One `lock()` admitted under a delegation. */
interface Admission {
	/** Fences the handle's write capability. A no-op until `registerAdmission` supplies the real one. */
	revoke: () => void;
	/** Monotonic deadline of the handle's OWN lease, after which it fences itself and can be dropped. */
	expiresMono: number;
	/** False once the caller unlocked: it no longer blocks a drain, but is still revocable. */
	holding: boolean;
}

/** A delegation this node issued as a key's home. */
interface HomeGrant {
	key: any;
	delegate: string;
	token: FencingToken;
	/**
	 * Monotonic deadline on THIS node, set to the delegate's lease PLUS skew. The home always outwaits
	 * the delegate, so it can never re-grant a key the previous delegate still believes it holds.
	 */
	expiresMono: number;
	recalling?: Promise<void>;
}

export interface LockRound {
	/** The identity to stamp the holder's writes with. */
	tsR: number;
	/** The monotonic reading the admission's lease is measured from. */
	mintedMono: number;
	/**
	 * Identifies THIS admission for the life of the handle it produced. The caller hands it back on
	 * registration and on release. An id rather than the delegation's token, because the token changes
	 * on renewal while the admission does not: addressing by token made a renewed delegation lose
	 * track of handles it was still responsible for.
	 */
	admissionId: number;
}

export interface LockCoordinatorOptions {
	database: string;
	table: string;
	/** This node's globally stable name. */
	nodeId: string;
	transport: ClusterLockTransport;
	/**
	 * Emit one control entry. Core passes the transport's own `writeControl` when it has one and its
	 * transaction-log writer otherwise, since writing to the local log IS the send.
	 */
	writeControl: (entry: LockControlEntry) => Promise<void> | void;
	/** Stable map key for a record id; core passes `writeKeyId`. */
	keyIdOf: (key: any) => unknown;
	/** Mints the holder's stamp; core passes the primary store's monotonic timestamp. */
	nextTimestamp: () => number;
	/** Monotonic clock. Every expiry decision is made on this. */
	monotonic?: () => number;
	skewMs?: number;
	/**
	 * The coordinator this one replaces, when a transport is re-registered (a component reload is
	 * enough). Its live authority is MOVED here rather than discarded: the transport changed, but the
	 * handles it admitted did not, and a successor that started with an empty grant table could hand
	 * the same key to another node with no lease time elapsed. That is the "a home may never forget a
	 * grant before its expiry" rule (§8) applied across the swap rather than only within one
	 * coordinator's life. §11 of the design note calls for exactly this — carry live authority across,
	 * or fence and settle every outstanding handle before granting; carrying it across costs nothing.
	 */
	adopt?: LockCoordinator;
	/**
	 * Overrides the cold-start grant quarantine (§4.3). Pass `-Infinity` only where a previous
	 * incarnation provably issued nothing — a fresh database, or a test. Required when `monotonic` is
	 * an injected clock whose readings do not count from process start. See `#grantableAfterMono`.
	 */
	grantableAfterMono?: number;
	/** False in tests, which drive `tick()` themselves. */
	autoTick?: boolean;
}

/**
 * What a coordinator closed WITHOUT a successor leaves for its eventual replacement, per table.
 *
 * `close()` drops the grant table, but the delegations those grants authorize are still live on other
 * nodes until their own deadlines — closing is a local event that no peer observes. A replacement
 * built before then must not grant those keys again, and must not restart the counter into tokens the
 * closed coordinator already issued. `#grantableAfterMono` covers the same hazard across a process
 * RESTART; this covers it across an unregister and re-register inside one process, which a
 * process-start reading cannot see.
 */
const retiredCoordinators = new Map<string, { grantableAfterMono: number; counter: number }>();

/**
 * The highest home-map generation this thread has acted under, per DATABASE — the scope the generation
 * itself has, not the per-table scope a token is compared at. A generation is the high-order component
 * of every fencing token (§5.1), so going backwards re-mints tokens that order BELOW ones already
 * handed out, and a delayed write under the newer generation then defeats its successor. Refusing it
 * database-wide is strictly stronger than refusing it per table and costs nothing: one rolled-back
 * publish is one event. The map is operator-published, so the rollback route is a configuration
 * restore or a partial publish rather than a protocol bug — which is why it is refused here rather
 * than assumed away. Remembering it across a restart, and across threads, is harper-pro's half.
 */
const highestGeneration = new Map<string, number>();

const tickingCoordinators = new Set<LockCoordinator>();
let tickTimer: ReturnType<typeof setInterval> | undefined;
function ensureTicking() {
	if (tickTimer || tickingCoordinators.size === 0) return;
	tickTimer = setInterval(() => {
		for (const coordinator of tickingCoordinators) {
			try {
				coordinator.tick();
			} catch (error) {
				warnOnce('lock coordinator tick failed', error);
			}
		}
		if (tickingCoordinators.size === 0) {
			clearInterval(tickTimer);
			tickTimer = undefined;
		}
	}, TICK_INTERVAL_MS);
	tickTimer.unref?.();
}

/** Stands in until `registerAdmission` supplies the handle's real revoker. */
function noRevoke() {}

/**
 * Rate-limit rather than latch. These messages report a transport, writer or revoker that failed, and
 * a latch for the life of the process would show an operator the first occurrence and then hide a
 * fault that persists for days. One per message per window is enough to keep a hot loop from flooding
 * the log while still showing that the condition is ongoing.
 */
const warnedMessages = new Map<string, number>();
function warnOnce(message: string, detail?: unknown) {
	const now = performance.now();
	const last = warnedMessages.get(message);
	if (last !== undefined && now - last < WARN_INTERVAL_MS) return;
	warnedMessages.set(message, now);
	harperLogger.warn?.(message, detail);
}

export class LockCoordinator {
	readonly database: string;
	readonly table: string;
	readonly nodeId: string;
	readonly transport: ClusterLockTransport;
	#writeControl: (entry: LockControlEntry) => Promise<void> | void;
	#keyIdOf: (key: any) => unknown;
	#nextTimestamp: () => number;
	#monotonic: () => number;
	#skewMs: number;
	#autoTick: boolean;
	/** Whoever this coordinator's authority was handed to, for replies that land after the swap. */
	#successor: LockCoordinator | undefined;
	/** Set when this coordinator's state was moved to a successor, so `close()` must not expire it. */
	#handedOff = false;
	/**
	 * Monotonic reading before which this coordinator may not grant as a home — the §4.3 restart
	 * quarantine, and core's own to enforce.
	 *
	 * A coordinator that started cold has no record of the delegations a previous incarnation issued,
	 * and those can still be admitting on their holders. Nothing external bounds them: the home map is
	 * immutable, so its generation does not advance merely because a process or a worker restarted. The
	 * only instant core can prove nothing else was granting under is this coordinator's own
	 * construction, so the quarantine runs `DELEGATION_LEASE_MS + skew` from there — by which point
	 * every delegation a previous incarnation could have issued has expired. It costs availability on
	 * this node's own share of the ring and nothing elsewhere: keys homed on other nodes are acquired
	 * immediately, and `adopt` plus the retirement record waive it wherever a predecessor's authority
	 * is actually known.
	 *
	 * A deployment that can prove a previous incarnation issued nothing overrides it through
	 * `ClusterLockTransport.grantableAfterMono`. Generation CHANGES need nothing here: the
	 * delegate-side generation check in `#liveDelegation` is what stops the old delegate.
	 */
	#grantableAfterMono: number;
	/** Keys this node holds a delegation for. */
	#delegations = new Map<unknown, Delegation>();
	/**
	 * Every live admission, by id, and the delegation answerable for it. Coordinator-level rather than
	 * per-delegation so a release can find its admission after the delegation was renewed or replaced.
	 */
	#admissions = new Map<number, Delegation>();
	#nextAdmissionId = 1;
	/** Keys this node homes, and who holds each one. */
	#grants = new Map<unknown, HomeGrant>();
	/** Per-requester counts, so one peer cannot fill the home's table on its own. */
	#grantsByRequester = new Map<string, number>();
	#counter = 0;
	/**
	 * Closed coordinators must not keep admitting. `close()` sets this AND expires every delegation,
	 * because a handle already handed out checks only its own lease — clearing the table alone would
	 * let a successor coordinator (a re-registered transport) grant the same key with no lease time
	 * elapsed.
	 */
	#closed = false;
	// A latched warning would make a permanently misrouted deployment look like a quiet cluster.
	#droppedOffOwner = 0;
	#lastOffOwnerWarn = 0;

	constructor(options: LockCoordinatorOptions) {
		if (!isNodeName(options.nodeId) || NON_DISTINCTIVE_NODE_NAMES.has(options.nodeId))
			throw new LockUnavailableError(
				`Cluster record locks need a distinctive node name to derive a key's home from, but this node identifies as "${options.nodeId}". Set node.hostname to this node's name in system.hdb_nodes.`
			);
		this.database = options.database;
		this.table = options.table;
		this.nodeId = options.nodeId;
		this.transport = options.transport;
		this.#writeControl = options.writeControl;
		this.#keyIdOf = options.keyIdOf;
		this.#nextTimestamp = options.nextTimestamp;
		this.#monotonic = options.monotonic ?? (() => performance.now());
		this.#skewMs = options.skewMs ?? LOCK_LEASE_SKEW_MS;
		this.#autoTick = options.autoTick !== false;
		// Anchored at construction, which is the only instant core can prove nothing else was granting
		// under: process start is wrong (`performance.now()` is process-wide inside a worker too, so a
		// replacement coordinating thread would read an uptime far past it) and so is thread start (a
		// thread can take coordination ownership long after it booted). `adopt` and the retirement
		// record below waive or carry the horizon wherever a predecessor's authority is actually known.
		this.#grantableAfterMono = options.grantableAfterMono ?? this.#monotonic() + DELEGATION_LEASE_MS + this.#skewMs;
		options.adopt?.handOffTo(this);
		// After the handoff, which sets both for the adopted case: a predecessor that closed without one
		// left its outstanding authority here instead, and this coordinator inherits its bounds.
		const retired = retiredCoordinators.get(this.#retirementKey());
		if (retired) {
			this.#counter = Math.max(this.#counter, retired.counter);
			this.#grantableAfterMono = Math.max(this.#grantableAfterMono, retired.grantableAfterMono);
		}
	}

	/**
	 * Move this coordinator's live authority to the coordinator replacing it. Called from the
	 * successor's constructor, before `close()`, so nothing is dropped in between. Both coordinators
	 * run in the same thread for the same node, so the delegations and grants are still this node's —
	 * only the transport object underneath them changed.
	 */
	handOffTo(successor: LockCoordinator): void {
		if (this.#handedOff) return;
		this.#handedOff = true;
		// Kept so an acquisition still awaiting a home's reply can install it on whoever holds this
		// node's authority when the reply lands, rather than on a coordinator nothing consults.
		this.#successor = successor;
		for (const [keyId, delegation] of this.#delegations) successor.#delegations.set(keyId, delegation);
		for (const [keyId, grant] of this.#grants) successor.#grants.set(keyId, grant);
		for (const [requester, count] of this.#grantsByRequester) successor.#grantsByRequester.set(requester, count);
		// The admission index moves with the delegations it points into. Without it a handle admitted
		// on the predecessor could never be released through the successor — `release` addresses the
		// admission, so the entry would sit on the delegation forever and no recall could drain it.
		for (const [admissionId, delegation] of this.#admissions) successor.#admissions.set(admissionId, delegation);
		// Neither counter may restart. A repeated token would compare equal to one the predecessor
		// already issued for a different delegation; a repeated admission id would address the wrong
		// admission in the map just carried over.
		successor.#counter = Math.max(successor.#counter, this.#counter);
		successor.#nextAdmissionId = Math.max(successor.#nextAdmissionId, this.#nextAdmissionId);
		// The successor holds the full record of what THIS coordinator had outstanding, so it need not
		// wait on that. It must still wait out the cold-start quarantine, which bounds what a previous
		// incarnation of the PROCESS granted — neither coordinator can see those, and a transport swap
		// is not evidence about them.
		successor.#grantableAfterMono = Math.max(successor.#grantableAfterMono, this.#grantableAfterMono);
		this.#delegations.clear();
		this.#grants.clear();
		this.#grantsByRequester.clear();
		this.#admissions.clear();
		if (successor.#delegations.size > 0 || successor.#grants.size > 0) successor.#startTicking();
	}

	/**
	 * For `cluster_status`: delegations held, delegations issued, live admissions, admissions still
	 * revocable, misrouted calls. `revocable` counts the ones an unlock left fenceable as well, so the
	 * retention `#pruneAdmissions` bounds is visible rather than inferred from `admitted`.
	 */
	get stats(): {
		delegations: number;
		granted: number;
		admitted: number;
		revocable: number;
		droppedOffOwner: number;
	} {
		let admitted = 0;
		let revocable = 0;
		for (const delegation of this.#delegations.values()) {
			admitted += delegation.holding;
			revocable += delegation.admissions.size;
		}
		return {
			delegations: this.#delegations.size,
			granted: this.#grants.size,
			admitted,
			revocable,
			droppedOffOwner: this.#droppedOffOwner,
		};
	}

	/**
	 * Admit a critical section for a key whose native lock this thread already holds. Resolves with
	 * the stamp and the monotonic reading the lease runs from; rejects 423 when no delegation could be
	 * obtained in time, or 503 when the guarantee cannot be established at all.
	 *
	 * The amortization is the first branch: a live, un-recalled delegation with enough time left costs
	 * zero cluster messages.
	 */
	async acquire(key: any, leaseMs: number, waitMs: number): Promise<LockRound> {
		// `Table.lock()` captures a coordinator and only reaches here after the native key lock, which
		// can wait the caller's whole timeout — long enough for a transport swap to close what it
		// captured. Authority moved to the successor rather than away, so run there instead of
		// rejecting a caller that is already holding the key.
		const authority = this.#authority();
		if (authority !== this) return authority.acquire(key, leaseMs, waitMs);
		if (this.#closed) throw new LockUnavailableError('Cluster record lock coordination was closed for this table');
		if (!this.transport.ownsCoordination())
			throw new LockUnavailableError(
				'Cluster record lock coordination is not owned by this worker thread; retry so the request reaches the coordinating thread'
			);
		const keyId = this.#keyIdOf(key);
		const deadlineMono = this.#monotonic() + waitMs;

		for (;;) {
			const homeMap = this.transport.homeMap(this.database);
			// No agreed map means no agreed ring, and a ring guessed from whoever looks reachable is
			// exactly the asymmetric-partition failure a single arbiter exists to remove.
			if (!homeMap || !this.#generationIsCurrent(homeMap.generation))
				throw new LockUnavailableError(
					`No agreed record lock home map for ${this.database}; cluster record locks are unavailable until one is established`
				);
			const delegation = this.#liveDelegation(keyId, leaseMs, homeMap.generation);
			if (delegation) return this.#admit(delegation, leaseMs);

			const home = homeFor(this.#ringKey(keyId), homeMap.homes);
			if (!home)
				throw new LockUnavailableError(`The record lock home map for ${this.database} names no nodes to home a key on`);

			// Anchored before the send: the home starts its own clock when it grants, so measuring the
			// delegation from the reply's arrival would hand a delayed reply more time than the home is
			// holding the key for.
			const requestedAtMono = this.#monotonic();
			const reply =
				home === this.nodeId
					? this.#grantLocally(keyId, key, homeMap, leaseMs)
					: await this.#requestRemotely(home, keyId, key, homeMap, leaseMs, deadlineMono);

			// A transport swap can land while a request is in flight. The grant is authority for this
			// NODE, and the successor is this node now — installing it here would leave a delegation
			// nothing consults, admitting a caller that no recall can reach.
			const authority = this.#authority();
			if (authority.#closed)
				throw new LockUnavailableError('Cluster record lock coordination was closed for this table');

			// A reply that claims a grant without a usable token is a broken transport, not a delegation.
			if (reply.granted && reply.token && isDuration(reply.leaseMs, MIN_LOCK_LEASE_MS, DELEGATION_LEASE_MS)) {
				// The generation can advance across the await. A grant minted under a superseded one is
				// authority for a ring that no longer exists: the key may be homed elsewhere now, and that
				// home can already have granted it to another node. `#liveDelegation` rejects a stale
				// token on the NEXT pass, which is too late — this pass would have admitted on it first.
				if (reply.token[0] !== authority.transport.homeMap(this.database)?.generation) {
					// Hand it back rather than let the old home hold a key nobody is using for a full lease.
					authority.#releaseUnclaimedGrant(key, reply.token);
				} else {
					const installed = authority.#installDelegation(keyId, key, reply.token, reply.leaseMs, requestedAtMono);
					// A reply that outlived its own delegation grants nothing; fall through and ask again
					// rather than admitting on authority the home has already expired.
					if (installed && !installed.recalled && installed.expiresMono - authority.#monotonic() >= leaseMs)
						return authority.#admit(installed, leaseMs);
				}
			} else if (reply.granted)
				throw new LockUnavailableError(
					`The home node for this key on ${this.database}.${this.table} returned a delegation with no usable token`
				);
			if (reply.reason === 'capacity')
				throw new LockUnavailableError(`Too many record lock delegations in flight on ${this.database}`);
			if (reply.reason === 'quarantine')
				throw new LockUnavailableError(
					`The home node for this key on ${this.database}.${this.table} restarted and cannot grant until the delegations its previous incarnation issued have expired`
				);
			if (reply.reason === 'not-home')
				// The home disagrees about the ring. Re-reading the map on the next pass is the fix;
				// if it is genuinely stale on our side we will converge, and if not we run out of wait.
				warnOnce('record lock home disagreed about the ring', { database: this.database, table: this.table });

			const remaining = deadlineMono - this.#monotonic();
			if (remaining <= 0) throw new ClientError('Record is locked and was not released in time', 423);
			await delay(Math.min(reply.retryAfterMs ?? 25, remaining)).promise;
			if (this.#closed) {
				// Same swap, landing in the backoff instead. Carry the remaining wait so the deadline the
				// caller asked for is preserved across the hop.
				const successor = this.#authority();
				if (successor === this)
					throw new LockUnavailableError('Cluster record lock coordination was closed for this table');
				return successor.acquire(key, leaseMs, Math.max(0, deadlineMono - this.#monotonic()));
			}
		}
	}

	/**
	 * End this node's admission for a key. The delegation is deliberately KEPT: that is the
	 * amortization, and the next `lock()` on this node costs nothing. Returns the durable release
	 * write only when the delegation is actually being given up.
	 */
	release(key: any, admissionId: number): Promise<void> | void {
		const keyId = this.#keyIdOf(key);
		// Addressed by admission, not by key: after a renewal or a replacement the delegation at this
		// key may not be the one that admitted this handle, and releasing by key alone would either
		// surrender a successor while its own callers were still inside, or leave this admission on a
		// delegation nobody can ever drain.
		const delegation = this.#admissions.get(admissionId);
		if (!delegation) return undefined;
		const admission = delegation.admissions.get(admissionId);
		if (!admission?.holding) return undefined;
		// The entry stays. Unlocking ends this caller's claim on the DRAIN; the write it staged can
		// still commit, so the revoker has to remain reachable until the handle's own lease runs out.
		admission.holding = false;
		delegation.holding--;
		if (delegation.holding > 0) return undefined;
		if (delegation.drained) {
			// Waking the recall is enough: it surrenders once, on its own path. Surrendering here too
			// would write a second release entry for the same handoff.
			const waiters = delegation.drained;
			delegation.drained = undefined;
			for (const resolve of waiters) resolve();
			return undefined;
		}
		// Recalled with nobody waiting on the drain — the recall already returned, so this is the path
		// that gives the delegation up. An un-recalled delegation is deliberately retained.
		if (delegation.recalled && this.#delegations.get(keyId) === delegation) return this.#surrender(keyId, delegation);
		return undefined;
	}

	/**
	 * Apply a control entry from a peer (or a replayed one). Idempotent by `(requester, tsR)`: a
	 * release that arrives twice, or is replayed from the log long after its producer is gone, must be
	 * harmless.
	 *
	 * `author` is the node the entry was actually written by, taken from the audit header rather than
	 * the payload — without it a peer could write a release naming any other node and clear a
	 * delegation it does not hold.
	 */
	applyEntry(entry: LockControlEntry, author: string): void {
		// The only boundary peer input crosses into this state machine. A throw here would reach the
		// replicated apply loop and drop the whole enclosing transaction, so one malformed entry could
		// stall replication for the database.
		try {
			this.#applyEntry(entry, author);
		} catch (error) {
			warnOnce('failed to apply a record lock control entry', error);
		}
	}

	#applyEntry(entry: LockControlEntry, author: string): void {
		if (this.#closed) return;
		if (entry.type !== 'lockRelease' || !isNodeName(author)) return;
		if (entry.requester !== author) return;
		if (!this.transport.ownsCoordination()) {
			this.#droppedOffOwner++;
			const now = this.#monotonic();
			if (now - this.#lastOffOwnerWarn > WARN_INTERVAL_MS) {
				this.#lastOffOwnerWarn = now;
				harperLogger.warn?.('record lock control entries are reaching a non-coordinating thread', {
					database: this.database,
					table: this.table,
					dropped: this.#droppedOffOwner,
				});
			}
			return;
		}
		if (!Array.isArray(entry.token) || entry.token.length !== 3) return;
		const keyId = this.#keyIdOf(entry.key);
		const grant = this.#grants.get(keyId);
		// Only the delegate named in the live grant can clear it, and only for the exact token it was
		// issued — generation and incarnation included, since counters restart. A delayed release from a
		// previous delegation must not clear its successor's.
		if (!grant || grant.delegate !== author || compareTokens(grant.token, entry.token) !== 0) return;
		this.#clearGrant(keyId, grant);
	}

	/**
	 * Inbound delegation request from a peer, for a key this node homes. The home is the single
	 * arbiter, so this is the whole of the exclusion argument: one live grant per key, and a successor
	 * only after the predecessor is recalled-and-drained or provably expired here.
	 */
	async onDelegationRequest(request: DelegationRequest): Promise<DelegationReply> {
		if (this.#closed || !this.transport.ownsCoordination()) return { granted: false, reason: 'not-home' };
		if (!isNodeName(request.requester) || !isEncodableKey(request.key)) return { granted: false, reason: 'not-home' };
		if (!isDuration(request.leaseMs, MIN_LOCK_LEASE_MS, MAX_LOCK_LEASE_MS))
			return { granted: false, reason: 'not-home' };
		const homeMap = this.transport.homeMap(this.database);
		if (!homeMap || !this.#generationIsCurrent(homeMap.generation)) return { granted: false, reason: 'generation' };
		if (homeMap.generation !== request.generation)
			return { granted: false, reason: 'generation', generation: homeMap.generation };
		// Membership before state: a node the current generation does not name has no claim on a key,
		// and an authenticated replication identity outlives membership. Without this a decommissioned
		// node takes delegations against live homes and recalls the legitimate delegate to get them.
		if (!homeMap.homes.includes(request.requester))
			return { granted: false, reason: 'generation', generation: homeMap.generation };
		// Both sides must agree we are the home, or two arbiters could issue for one key.
		const keyId = this.#keyIdOf(request.key);
		if (homeFor(this.#ringKey(keyId), homeMap.homes) !== this.nodeId) return { granted: false, reason: 'not-home' };
		return this.#grant(keyId, request.key, homeMap, request.leaseMs, request.requester);
	}

	/**
	 * Inbound recall from a key's home. Revokes capability rather than closing the door: no new
	 * admission may start, live ones are drained, and the release is written only once the delegation
	 * can no longer admit or commit. A recall for a token we no longer hold is a no-op, not an error.
	 */
	async onDelegationRecall(recall: DelegationRecall): Promise<void> {
		if (this.#closed) return;
		const keyId = this.#keyIdOf(recall.key);
		const delegation = this.#delegations.get(keyId);
		if (!delegation || compareTokens(delegation.token, recall.token) !== 0) return;
		delegation.recalled = true;
		if (delegation.holding > 0) {
			await new Promise<void>((resolve) => {
				// A holder that never releases must not hold the recall open past its own lease: the
				// delegation expires here on our clock, and the home outwaits that by skew anyway. The
				// timer is dropped by whichever side wins, so a delegation that drains promptly does not
				// retain one for the rest of its lease.
				const remaining = Math.max(0, delegation.expiresMono - this.#monotonic());
				const timer = setTimeout(resolve, remaining);
				timer.unref?.();
				(delegation.drained ||= []).push(() => {
					clearTimeout(timer);
					resolve();
				});
			});
		}
		// The swap may have landed during the drain. The delegation OBJECT moved to the successor, so
		// surrendering here would revoke through an index this coordinator no longer owns and leave the
		// successor still holding a delegation whose release has already been written.
		await this.#authority().#surrender(keyId, delegation);
	}

	/** Expire delegations and grants whose deadlines have passed. Bounded work per call. */
	tick(): void {
		const now = this.#monotonic();
		// The budget counts EXPIRIES, not entries examined. Spending it on live entries would let a
		// table with more than a budget's worth of continuously renewed grants starve every expired
		// one behind them, and an uncollected expired grant answers `contended` to every other node.
		let budget = MAX_EXPIRIES_PER_TICK;
		for (const [keyId, delegation] of this.#delegations) {
			if (budget <= 0) break;
			if (delegation.expiresMono > now) continue;
			budget--;
			// A delegate may drop early; the handles it admitted are fenced by their own lease, which
			// never outlives the delegation that admitted them.
			this.#delegations.delete(keyId);
			this.#revokeAll(delegation);
			const waiters = delegation.drained;
			if (waiters) {
				delegation.drained = undefined;
				for (const resolve of waiters) resolve();
			}
		}
		budget = MAX_EXPIRIES_PER_TICK;
		for (const [keyId, grant] of this.#grants) {
			if (budget <= 0) break;
			// A home may NEVER forget a grant before its expiry — that asymmetry is the safety rule.
			if (grant.expiresMono > now) continue;
			budget--;
			this.#clearGrant(keyId, grant);
		}
		if (this.#delegations.size === 0 && this.#grants.size === 0) tickingCoordinators.delete(this);
	}

	/**
	 * Stop this coordinator and invalidate what it issued. Expiring every delegation is the part that
	 * matters: `close()` runs when a transport is replaced (a component reload is enough), and a
	 * successor coordinator must not be able to grant a key whose predecessor handles are still live.
	 */
	close(): void {
		this.#closed = true;
		// State that was handed to a successor is that coordinator's now; expiring it here would
		// invalidate delegations the successor is correctly still honouring.
		if (this.#handedOff) {
			tickingCoordinators.delete(this);
			return;
		}
		for (const delegation of this.#delegations.values()) {
			delegation.recalled = true;
			delegation.expiresMono = -Infinity;
			this.#revokeAll(delegation);
			const waiters = delegation.drained;
			if (waiters) {
				delegation.drained = undefined;
				for (const resolve of waiters) resolve();
			}
		}
		// The delegations THIS node issued as a home outlive it: no peer sees a local close, so each one
		// stands until its own deadline. Leave the latest of those deadlines, and the counter, for
		// whatever coordinator takes this table next.
		let grantableAfterMono = -Infinity;
		for (const grant of this.#grants.values()) {
			// A grant to THIS node is settled by the same close: the loop above revoked the delegation it
			// authorized. Only what another node holds outlives this coordinator unseen.
			if (grant.delegate === this.nodeId) continue;
			if (grant.expiresMono > grantableAfterMono) grantableAfterMono = grant.expiresMono;
		}
		const retirementKey = this.#retirementKey();
		const retired = retiredCoordinators.get(retirementKey);
		retiredCoordinators.set(retirementKey, {
			grantableAfterMono: Math.max(retired?.grantableAfterMono ?? -Infinity, grantableAfterMono),
			counter: Math.max(retired?.counter ?? 0, this.#counter),
		});
		this.#delegations.clear();
		this.#grants.clear();
		this.#grantsByRequester.clear();
		tickingCoordinators.delete(this);
	}

	/** Fail closed on a generation older than one already acted on here (see `highestGeneration`). */
	#generationIsCurrent(generation: number): boolean {
		const key = this.database;
		const highest = highestGeneration.get(key);
		if (highest !== undefined && generation < highest) return false;
		if (highest === undefined || generation > highest) highestGeneration.set(key, generation);
		return true;
	}

	#retirementKey(): string {
		return `${this.database}\u0000${this.table}`;
	}

	#ringKey(keyId: unknown): string {
		return ringKeyFor(this.database, this.table, keyId);
	}

	/** The coordinator holding this node's authority now: this one, or the end of the handoff chain. */
	#authority(): LockCoordinator {
		let coordinator: LockCoordinator = this;
		while (coordinator.#successor) coordinator = coordinator.#successor;
		return coordinator;
	}

	#liveDelegation(keyId: unknown, leaseMs: number, generation: number): Delegation | undefined {
		const delegation = this.#delegations.get(keyId);
		if (!delegation || delegation.recalled) return undefined;
		// A delegation is authority within ONE generation. After a generation change the key may have
		// been re-homed, and the new home knows nothing of this token — so keeping it would let this
		// node admit alongside whoever the new home grants.
		if (delegation.token[0] !== generation) {
			// Authority is gone, not merely stale: the key may have been re-homed to a node that knows
			// nothing of this token. Forgetting the delegation without revoking would leave its handles
			// able to commit alongside whatever the new home grants.
			this.#delegations.delete(keyId);
			this.#revokeAll(delegation);
			return undefined;
		}
		// The admission may not outlive the delegation that admitted it, so a delegation without room
		// for the whole lease is renewed rather than stretched.
		if (delegation.expiresMono - this.#monotonic() < leaseMs) return undefined;
		return delegation;
	}

	#admit(delegation: Delegation, leaseMs: number): LockRound {
		const mintedMono = this.#monotonic();
		// Admissions that unlocked are kept only until their handle's own lease fences it. Collecting
		// them here rather than on a timer keeps the work on the path that creates it, and a delegation
		// can accumulate at most one entry per overlapping lock in its own lease.
		this.#pruneAdmissions(delegation, mintedMono);
		const admissionId = this.#nextAdmissionId++;
		// The entry exists from the instant of admission, so a recall between admit and register still
		// sees it.
		delegation.admissions.set(admissionId, { revoke: noRevoke, expiresMono: mintedMono + leaseMs, holding: true });
		delegation.holding++;
		this.#admissions.set(admissionId, delegation);
		return { tsR: this.#nextTimestamp(), mintedMono, admissionId };
	}

	/**
	 * Drop admissions whose handle's lease has run out; they can no longer commit anything.
	 *
	 * Insertion order is monotonic order, not expiry order: under one lease length the leading run IS
	 * the expired set, but a longer-lease admission at the head hides every shorter one behind it for
	 * its own remaining lease. Scanning the whole map on every admission instead would be quadratic on
	 * the hot key this design exists to make cheap, so it is swept only once it has outgrown the live
	 * set the previous sweep measured — amortized O(1) per admission, and the map stays within twice
	 * the live set rather than growing at the lock rate.
	 *
	 * Never has a drain to wake: `#admit` reaches neither call site for a recalled delegation.
	 */
	#pruneAdmissions(delegation: Delegation, now: number): void {
		for (const [admissionId, admission] of delegation.admissions) {
			if (admission.expiresMono > now) break;
			this.#dropAdmission(delegation, admissionId, admission);
		}
		if (delegation.admissions.size < delegation.sweepAtSize) return;
		for (const [admissionId, admission] of delegation.admissions)
			if (admission.expiresMono <= now) this.#dropAdmission(delegation, admissionId, admission);
		delegation.sweepAtSize = delegation.admissions.size * 2 + ADMISSION_SWEEP_FLOOR;
	}

	#dropAdmission(delegation: Delegation, admissionId: number, admission: Admission): void {
		delegation.admissions.delete(admissionId);
		this.#admissions.delete(admissionId);
		if (admission.holding) delegation.holding--;
	}

	/**
	 * Register how to revoke the handle an admission produced. `Table.lock()` calls this once the
	 * handle has joined the round, so a recall can fence a write that was staged and then unlocked.
	 */
	registerAdmission(admissionId: number, revoke: () => void): void {
		const admission = this.#admissions.get(admissionId)?.admissions.get(admissionId);
		if (!admission) {
			// The admission was already revoked or collected between admit and register — the handle has
			// no authority to keep, so revoke it now rather than leaving it unfenced.
			revoke();
			return;
		}
		admission.revoke = revoke;
	}

	/**
	 * Install a granted delegation, with its deadline anchored at the moment the request was SENT
	 * rather than at the moment the reply arrived. The home started its own clock when it granted, so
	 * anchoring on arrival would hand a delayed reply more time than the home is holding the key for —
	 * and a reply delayed past the whole delegation must be discarded, not installed (§5.2).
	 */
	#installDelegation(
		keyId: unknown,
		key: any,
		token: FencingToken,
		leaseMs: number,
		requestedAtMono: number
	): Delegation | undefined {
		const expiresMono = requestedAtMono + leaseMs;
		if (expiresMono <= this.#monotonic()) return undefined;
		const existing = this.#delegations.get(keyId);
		// A reply that lost a race with a newer delegation for the same key must not move it backwards.
		if (existing && compareTokens(existing.token, token) >= 0) return existing;
		if (existing && !existing.recalled) {
			// A RENEWAL of authority this node never lost. Advance the token and the deadline in place so
			// the admissions it is still answerable for ride along; installing a fresh object here
			// orphaned them, and the next recall then surrendered while a live handle could still commit.
			existing.token = token;
			existing.expiresMono = expiresMono;
			this.#startTicking();
			return existing;
		}
		// Replacing a recalled delegation: its handles were revoked at surrender, so nothing carries.
		if (existing) this.#revokeAll(existing);
		const delegation: Delegation = {
			key,
			token,
			expiresMono,
			recalled: false,
			admissions: new Map(),
			holding: 0,
			sweepAtSize: ADMISSION_SWEEP_FLOOR,
		};
		this.#delegations.set(keyId, delegation);
		this.#startTicking();
		return delegation;
	}

	/** This node is the key's home: grant to itself through exactly the same table a peer would use. */
	#grantLocally(keyId: unknown, key: any, homeMap: LockHomeMap, leaseMs: number): DelegationReply {
		return this.#grant(keyId, key, homeMap, leaseMs, this.nodeId);
	}

	async #requestRemotely(
		home: string,
		keyId: unknown,
		key: any,
		homeMap: LockHomeMap,
		leaseMs: number,
		deadlineMono: number
	): Promise<DelegationReply> {
		try {
			// A half-open connection to the home would otherwise leave `lock()` pending forever, past
			// its own timeout and past the native lease — and a reply arriving after that lease has
			// fired cannot be joined to the handle anyway.
			const remaining = Math.max(1, deadlineMono - this.#monotonic());
			let raced = false;
			const requested = Promise.resolve(
				this.transport.requestDelegation(home, this.database, this.table, {
					key,
					requester: this.nodeId,
					generation: homeMap.generation,
					leaseMs,
				})
			);
			// A reply that arrives after we stopped waiting still granted us the key on the home, which
			// would then hold it for the whole delegation while every other node is denied. Hand it back.
			// Through the authority, not through this object: a transport swap can land while the reply
			// is in flight, and `handOffTo` empties this coordinator's delegations. The handback's
			// "not while a delegation for the key is held" guard would then read an empty map and give
			// back a grant that still backs the successor's live delegation.
			requested.then(
				(reply) => {
					if (raced && reply?.granted && reply.token) this.#authority().#releaseUnclaimedGrant(key, reply.token);
				},
				() => {}
			);
			const timeout = delay(remaining);
			// Dropped once the race settles: a reply that beats the timeout would otherwise leave a timer
			// holding this closure for the caller's whole remaining wait.
			requested.then(
				() => timeout.cancel(),
				() => timeout.cancel()
			);
			return await Promise.race([
				requested,
				timeout.promise.then(() => {
					raced = true;
					return { granted: false, reason: 'contended', retryAfterMs: 0 } as DelegationReply;
				}),
			]);
		} catch (error) {
			// An unreachable home blocks only the keys it homes, which is the availability property the
			// whole design exists for — it is not a reason to admit without one.
			throw new LockUnavailableError(
				`Could not reach ${home}, the home node for this key on ${this.database}.${this.table}: ${(error as Error)?.message ?? error}`
			);
		}
	}

	/**
	 * Give back a delegation this node asked for but stopped waiting on. Without it the home holds the
	 * key for a delegation nobody is using, and every other node is denied for its full duration.
	 */
	#releaseUnclaimedGrant(key: any, token: FencingToken): void {
		const keyId = this.#keyIdOf(key);
		const held = this.#delegations.get(keyId);
		// ANY live delegation for this key means this node is using it, and the tokens need not match.
		// A duplicate or delayed request from this node renews the home's grant IN PLACE (`#grant`'s
		// renewal branch mutates `existing.token`), so the home can hold a newer token than the one we
		// installed. Releasing that token would clear the grant still backing our own live delegation
		// and let the home hand the key to another node while we are inside it. Comparing tokens here
		// caught only the case where we installed this exact grant.
		if (held) return;
		this.#writeControlSafely({ type: 'lockRelease', key, requester: this.nodeId, token });
		const grant = this.#grants.get(keyId);
		if (grant && grant.delegate === this.nodeId && compareTokens(grant.token, token) === 0)
			this.#clearGrant(keyId, grant);
	}

	#grant(keyId: unknown, key: any, homeMap: LockHomeMap, leaseMs: number, requester: string): DelegationReply {
		const now = this.#monotonic();
		const quarantine = this.#grantableAfterMono - now;
		// NOT `contended`: the quarantine runs for a full delegation lease, and `MAX_LOCK_TIMEOUT_MS` is
		// shorter than that, so retrying it would spend the caller's whole budget and then answer 423 —
		// "held by someone else" — for a key nobody holds.
		if (quarantine > 0) return { granted: false, reason: 'quarantine', retryAfterMs: Math.min(quarantine, 250) };
		const existing = this.#grants.get(keyId);
		if (existing) {
			// An expired grant is not a live one. Collecting it here rather than trusting `tick()` is
			// what keeps a table whose expiry budget is saturated from answering `contended` forever.
			if (existing.expiresMono <= now) this.#clearGrant(keyId, existing);
			else if (existing.recalling)
				// A recall is in flight. Renewing now — even for the node being recalled — would mint a
				// token its own release no longer matches, and the contender would never get the key.
				return { granted: false, reason: 'contended', retryAfterMs: 25 };
			else if (existing.delegate === requester) {
				// Renewal for the node that already holds it: extend rather than recall itself.
				existing.token = [homeMap.generation, homeMap.homeIncarnation, ++this.#counter];
				existing.expiresMono = now + DELEGATION_LEASE_MS + this.#skewMs;
				return { granted: true, token: existing.token, leaseMs: DELEGATION_LEASE_MS };
			} else {
				// Someone else holds it. Start the recall and make the caller come back — holding the
				// request open across a drain would tie the home's reply to the previous delegate's
				// liveness.
				this.#beginRecall(keyId, existing);
				return { granted: false, reason: 'contended', retryAfterMs: 25 };
			}
		}
		if (this.#grants.size >= MAX_DELEGATIONS_PER_TABLE) return { granted: false, reason: 'capacity' };
		const perRequester = this.#grantsByRequester.get(requester) ?? 0;
		if (perRequester >= MAX_DELEGATIONS_PER_REQUESTER) return { granted: false, reason: 'capacity' };
		const token: FencingToken = [homeMap.generation, homeMap.homeIncarnation, ++this.#counter];
		this.#grants.set(keyId, {
			key,
			delegate: requester,
			token,
			// The home always outwaits the delegate by skew, so it cannot re-grant a key the previous
			// delegate still believes it holds. The delegation runs for its own fixed duration rather
			// than the caller's lock lease — a delegation sized to one lock leaves no room for the next
			// one, and every repeat lock would pay a round trip.
			expiresMono: now + DELEGATION_LEASE_MS + this.#skewMs,
		});
		this.#grantsByRequester.set(requester, perRequester + 1);
		this.#startTicking();
		return { granted: true, token, leaseMs: DELEGATION_LEASE_MS };
	}

	#beginRecall(keyId: unknown, grant: HomeGrant): void {
		if (grant.recalling) return;
		if (grant.delegate === this.nodeId) {
			// We are both home and delegate. Recall ourselves through the same path a peer would take.
			grant.recalling = this.onDelegationRecall({ key: grant.key, token: grant.token }).catch((error) => {
				warnOnce('failed to recall a local record lock delegation', error);
			});
			return;
		}
		grant.recalling = Promise.resolve(
			this.transport.recallDelegation(grant.delegate, this.database, this.table, {
				key: grant.key,
				token: grant.token,
			})
		)
			.then(() => {
				// The delegate confirmed it stopped admitting. Its release entry clears the grant; if that
				// write never lands the grant still expires on its own deadline — but the recall must be
				// cleared either way, or a later contender's recall is skipped and it waits forever.
				grant.recalling = undefined;
			})
			.catch(() => {
				// An unreachable delegate is not a reason to re-grant early: the grant's own deadline is
				// what makes the successor safe, and it already includes the skew margin.
				grant.recalling = undefined;
			});
	}

	/** Give up a delegation: stop admitting, then write the release that lets the home re-grant. */
	#surrender(keyId: unknown, delegation: Delegation): Promise<void> | void {
		if (this.#delegations.get(keyId) === delegation) this.#delegations.delete(keyId);
		// Capability, not just admission: anything this delegation admitted must be unable to commit
		// before the home is told it may re-grant.
		this.#revokeAll(delegation);
		const entry: LockControlEntry = {
			type: 'lockRelease',
			key: delegation.key,
			requester: this.nodeId,
			token: delegation.token,
		};
		// If we are our own home, clear directly — the entry still goes out so peers replaying the log
		// see the same handoff, but the home half must not wait on our own replication.
		const grant = this.#grants.get(keyId);
		if (grant && grant.delegate === this.nodeId && compareTokens(grant.token, entry.token) === 0)
			this.#clearGrant(keyId, grant);
		return this.#writeControlSafely(entry);
	}

	/** Revoke every handle this delegation is answerable for, and forget the admissions. */
	#revokeAll(delegation: Delegation): void {
		const admissions = delegation.admissions;
		delegation.admissions = new Map();
		delegation.holding = 0;
		delegation.sweepAtSize = ADMISSION_SWEEP_FLOOR;
		for (const [admissionId, admission] of admissions) {
			this.#admissions.delete(admissionId);
			try {
				admission.revoke();
			} catch (error) {
				warnOnce('failed to revoke a record lock handle', error);
			}
		}
	}

	#clearGrant(keyId: unknown, grant: HomeGrant): void {
		if (this.#grants.get(keyId) !== grant) return;
		this.#grants.delete(keyId);
		const count = (this.#grantsByRequester.get(grant.delegate) ?? 1) - 1;
		if (count > 0) this.#grantsByRequester.set(grant.delegate, count);
		else this.#grantsByRequester.delete(grant.delegate);
	}

	#writeControlSafely(entry: LockControlEntry): Promise<void> | void {
		let written: Promise<void> | void;
		try {
			written = this.#writeControl(entry);
		} catch (error) {
			warnOnce('failed to write a record lock release entry', error);
			return undefined;
		}
		return Promise.resolve(written).catch((error) => {
			// A lost release costs the key its remaining lease on the home; it never costs exclusion.
			warnOnce('failed to write a record lock release entry', error);
		});
	}

	#startTicking() {
		if (!this.#autoTick) return;
		tickingCoordinators.add(this);
		ensureTicking();
	}
}

/** A sleep whose timer the winner of a race can drop, rather than let it run out its full delay. */
function delay(ms: number): { promise: Promise<void>; cancel: () => void } {
	let timer: ReturnType<typeof setTimeout>;
	const promise = new Promise<void>((resolve) => {
		timer = setTimeout(resolve, ms);
		timer.unref?.();
	});
	return { promise, cancel: () => clearTimeout(timer!) };
}

const clusterLockTransports = new Map<string, ClusterLockTransport>();
// Databases that have had a transport registered on this worker. A later absence is a transport
// that went away — a component reload, a failed reconnect — not proof the node became standalone,
// so cluster scope must keep failing closed rather than quietly reverting to a node-local lock.
const clusterRequiredDatabases = new Set<string>();
type CoordinatorResolver = (database: string, table: string) => LockCoordinator | undefined;
let coordinatorResolver: CoordinatorResolver | undefined;
// Applying a release is bookkeeping on this node's own grant table and needs no transport, so it
// resolves the coordinator that HOLDS the grant rather than the one a registered transport answers
// for. Dropping a peer's clean-handoff release during a reconnect denies every other node that key
// for the delegation's whole deadline. Requests and recalls keep the transport-gated resolver: both
// are answers to a live peer, and failing them closed while the transport is gone is the right shape.
let admittingResolver: CoordinatorResolver | undefined;

/** Installed by Table.ts so a transport can push received entries in without importing Table. */
export function setLockCoordinatorResolver(
	resolve: CoordinatorResolver,
	resolveAdmitting: CoordinatorResolver = resolve
) {
	coordinatorResolver = resolve;
	admittingResolver = resolveAdmitting;
}

export function registerClusterLockTransport(database: string, transport: ClusterLockTransport): void {
	if (
		typeof transport?.homeMap !== 'function' ||
		typeof transport?.ownsCoordination !== 'function' ||
		typeof transport?.requestDelegation !== 'function' ||
		typeof transport?.recallDelegation !== 'function'
	)
		throw new ClientError(
			'A cluster lock transport must provide homeMap(), ownsCoordination(), requestDelegation() and recallDelegation()'
		);
	transport.onControlEntry = (db: string, table: string, entry: LockControlEntry, author: string) =>
		deliverLockControlEntry(db, table, entry, author);
	transport.onDelegationRequest = (db: string, table: string, request: DelegationRequest) =>
		deliverDelegationRequest(db, table, request);
	transport.onDelegationRecall = (db: string, table: string, recall: DelegationRecall) =>
		deliverDelegationRecall(db, table, recall);
	clusterRequiredDatabases.add(database);
	clusterLockTransports.set(database, transport);
}

export function unregisterClusterLockTransport(database: string, standalone = false): void {
	clusterLockTransports.delete(database);
	// Only an explicit statement that the database is no longer clustered clears the requirement.
	if (standalone) clusterRequiredDatabases.delete(database);
}

/** True once a transport has been registered for this database and no standalone claim has cleared it. */
export function isClusterLockRequired(database: string): boolean {
	return clusterRequiredDatabases.size > 0 && clusterRequiredDatabases.has(database);
}

/**
 * The registered transport, if any. The `size` check keeps the Phase 0 path free of a map lookup on
 * every `lock()` in a build where no transport is ever registered.
 */
export function getClusterLockTransport(database: string): ClusterLockTransport | undefined {
	if (clusterLockTransports.size === 0) return undefined;
	return clusterLockTransports.get(database);
}

export function hasClusterLockTransports(): boolean {
	return clusterLockTransports.size > 0;
}

/**
 * Resolve a coordinator for an inbound message. The resolver reaches `Table.lockCoordinator`, which
 * throws when this node's name is unusable — that throw must not escape a receive boundary, or it
 * reaches the replicated apply loop and drops the enclosing transaction.
 */
function coordinatorFor(database: string, table: string, resolve = coordinatorResolver): LockCoordinator | undefined {
	try {
		return resolve?.(database, table);
	} catch (error) {
		warnOnce('could not resolve a record lock coordinator for a received message', error);
		return undefined;
	}
}

export function deliverLockControlEntry(
	database: string,
	table: string,
	entry: LockControlEntry,
	author: string
): void {
	coordinatorFor(database, table, admittingResolver)?.applyEntry(entry, author);
}

export async function deliverDelegationRequest(
	database: string,
	table: string,
	request: DelegationRequest
): Promise<DelegationReply> {
	const coordinator = coordinatorFor(database, table);
	if (!coordinator) return { granted: false, reason: 'not-home' };
	try {
		return await coordinator.onDelegationRequest(request);
	} catch (error) {
		warnOnce('failed to answer a record lock delegation request', error);
		return { granted: false, reason: 'not-home' };
	}
}

export async function deliverDelegationRecall(
	database: string,
	table: string,
	recall: DelegationRecall
): Promise<void> {
	const coordinator = coordinatorFor(database, table);
	if (!coordinator) return;
	try {
		await coordinator.onDelegationRecall(recall);
	} catch (error) {
		warnOnce('failed to apply a record lock delegation recall', error);
	}
}
