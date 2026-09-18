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
 * Successor freshness follows §7: a clean release carries inherited origin-log dependencies, the
 * home advances the releasing origin to that entry's own position, and the next delegate cannot
 * admit until its transport has made the set visible. Missing lineage takes the weaker recovery
 * barrier and fails closed if that barrier cannot be established.
 */

/**
 * How long a home waits before re-sending a recall that FAILED. A recall the delegate confirmed is
 * never re-sent: it has stopped admitting, and the grant is then cleared by its release or by its own
 * deadline. Without both rules a contender polling at 25 ms re-armed the recall on every pass and
 * turned one handoff into an RPC storm lasting the rest of the delegation.
 */
export const RECALL_RETRY_MS = 1_000;

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
/**
 * How often `tick()` asks the transport whether this thread still coordinates. Far coarser than the
 * tick because the answer only has to be sampled faster than a gap can matter, and it cannot matter
 * below a full delegation lease: whatever coordinated during the gap is inside its own quarantine
 * until then. At the tick rate an idle coordinating table would call the transport 10 times a second
 * for the life of the process.
 */
const OWNERSHIP_POLL_MS = 1_000;
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
/** How many entries a relay sweep may LOOK at per tick, so a thread holding many live relayed
 * admissions does not walk all of them every 100 ms to find nothing. Well above any realistic count of
 * concurrent off-owner locks on one thread, so an ordinary sweep still completes a full pass. */
const MAX_EXAMINED_PER_TICK = 4_096;
/** How long past its lease a relayed admission entry is kept before pruning (harper-pro#852), so the
 * handle's own lease timer fires first and forwards its release to the owner rather than racing the
 * sweep that would drop the entry it needs. A few ticks is plenty. */
const REMOTE_PRUNE_GRACE_MS = 500;
/**
 * What an owner-worker acquire (harper-pro#852) reserves out of the caller's `waitMs` for the round
 * trip, so the transport is asked for a wait it can answer WITHIN the caller's budget. `lock()` holds
 * the native key for the whole wait, so the hop must come out of that budget, never on top of it:
 * overshooting blocks every other worker on the key for the overshoot. Halved for a caller whose wait
 * is shorter than the allowance, so a short wait still leaves the owner something to work with.
 *
 * Small on purpose. This covers only the core-to-transport boundary: a transport that relays bounds
 * itself inside the wait it is handed and reserves its own margin for the hops it makes, so reserving
 * a hop-sized allowance here as well would subtract the same round trip from the caller twice.
 */
const REMOTE_ACQUIRE_HOP_MS = 500;
/** Core's last-resort net on an owner-worker acquire, on top of the caller's `waitMs`. The transport
 * already bounds itself inside that budget, so this fires only when it never returns at all — small,
 * because it is a wedged-transport net and not a second full wait. */
const REMOTE_ACQUIRE_BACKSTOP_MS = 1_000;
const MAX_NODE_NAME_LENGTH = 255;
const MAX_LOCK_DEPENDENCIES = 1_024;
const MAX_DEPENDENCY_SETS_PER_TABLE = 20_000;
/**
 * A 256 KiB filter keeps the false-positive rate near 1% through 200,000 distinct delegated keys
 * per lock-active table and generation. Saturation remains safe — it selects recovery — but making
 * that the normal path would turn every first lock on a new key into a cluster-wide barrier.
 */
const DELEGATED_KEY_FILTER_WORDS = 65_536;
/** A node whose identity resolved to one of these is not distinctive enough to be a ring member. */
const NON_DISTINCTIVE_NODE_NAMES = new Set(['127.0.0.1', '::1', 'localhost', '0.0.0.0']);

/**
 * The two control entries. `lockRequest`/`lockGrant` belonged to the Ricart–Agrawala rule the
 * design note replaces; they never shipped enabled, so their nibbles were retired rather than
 * migrated (`auditStore.ts`). Delegation request/grant/recall are unicast over the transport, not
 * entries — the release stays on the replicated log because it is what orders a handoff behind the
 * delegate's own data writes, and the barrier is on it because being replicated is its whole
 * purpose (§7.2): a member commits one on request, and its position is the point a peer must have
 * applied that origin through before a recovery-mode successor may admit.
 */
export type LockControlType = 'lockRelease' | 'lockBarrier';

/**
 * The operator-agreed map a key's home is derived from. Supplied by harper-pro; core never computes
 * it and never advances it. Immutable for the life of a generation — nothing a node observes changes
 * it, which is why no agreement protocol runs here (§4).
 */
export interface LockHomeMap {
	/** Monotonic per database. Part of the fencing token, so it must never go backwards. */
	generation: number;
	/**
	 * Every node that participates in cluster record locks for this database — not only the ones an
	 * operator thinks of as arbiters. Order is irrelevant; the ring hashes each name independently.
	 *
	 * It is one set and not two because a home refuses a delegation to any node this list does not
	 * name (that is what keeps a decommissioned node from taking one), so a node absent from it can
	 * neither home a key nor lock one. Rendezvous hashing then makes every listed node the arbiter for
	 * its share of the ring, which is the property that costs a second list nothing.
	 */
	homes: string[];
	/**
	 * This node's durably persisted, monotonic incarnation counter as a home (§5.1). A random value
	 * makes a stale reply identifiable but not ORDERABLE: a home that restarts and re-issues counter 1
	 * after having issued counter 50 would let a delayed counter-50 write defeat its successor.
	 *
	 * **Per coordination incarnation, not per process.** Coordinator state — including the delegation
	 * counter — is per-thread, so a replacement coordinating worker starts counting from zero. If the
	 * incarnation did not advance with it, the new worker would re-mint tokens its predecessor already
	 * issued, and §4.3's incarnation-bound quiescence acknowledgements would survive a restart that
	 * discarded everything they attested to.
	 */
	homeIncarnation: number;
}

/**
 * A delegation's fencing token, ordered lexicographically as
 * `(generation, homeIncarnation, counter)`. Comparable across homes only within a generation, which
 * is all that is needed: a key has exactly one home per generation.
 */
export type FencingToken = readonly [generation: number, homeIncarnation: number, counter: number];
export type LockDependency = readonly [origin: string, position: number];
export type LockDependencySet = readonly LockDependency[];

export function compareTokens(a: FencingToken, b: FencingToken): number {
	return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

function isFencingToken(value: unknown): value is FencingToken {
	return (
		Array.isArray(value) &&
		value.length === 3 &&
		value.every((part) => typeof part === 'number' && Number.isFinite(part))
	);
}

export interface LockReleaseEntry {
	type: 'lockRelease';
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
	/**
	 * Inherited clean-handoff lineage. Null hands back an unused first grant without advancing it; a
	 * renewed grant still drops retained lineage because its earlier token may have admitted writes.
	 * Absent means legacy/unknown.
	 */
	dependencies?: LockDependencySet | null;
}

/**
 * The §7.2 recovery fence. It names no key and no token: it is appended after every transaction the
 * writing node had committed when it was requested, so a peer that has applied that origin's log
 * through this entry has applied all of them. The coordinator never acts on one.
 */
export interface LockBarrierEntry {
	type: 'lockBarrier';
	/** Supplied by the requesting transport; distinguishes barriers an origin stamped identically across a restart. */
	nonce: number;
}

export type LockControlEntry = LockReleaseEntry | LockBarrierEntry;

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
	/** Granted only. Null selects the recovery barrier; an array is the exact clean-handoff fence. */
	dependencies?: LockDependencySet | null;
	/**
	 * Denied only. `contended` is the one reason that means another node holds the key, and so the only
	 * one an exhausted wait may report as 423. `generation` (the two sides hold different home maps),
	 * `unknown-node` (this node is not named in the map) and `quarantine` (the home is inside its §4.3
	 * restart interval) all describe something other than contention, so each ends as a retryable 503
	 * rather than telling the caller a key nobody holds is held. `timeout` is not a home answer at all
	 * — it is this node's own deadline ending its probe — and never classifies a wait (DESIGN.md).
	 */
	reason?: 'contended' | 'generation' | 'unknown-node' | 'capacity' | 'not-home' | 'quarantine' | 'timeout';
	/** Denied with `generation`, so a stale requester can re-derive the ring without another round trip. */
	generation?: number;
	retryAfterMs?: number;
}

/** A completed home reply, bound to the route that produced it so a ring change retires it. */
interface LastCompletedReply {
	reply: DelegationReply;
	home: string;
	generation: number;
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
	 * of this process provably issued nothing — a fresh database, a first start, or a test. Because the
	 * same attestation enables the virgin-key freshness fast path, it must prove that no earlier
	 * incarnation delegated any key under the current home-map generation at any time, not merely that
	 * its last delegation lease has elapsed. Omitted means core enforces the full
	 * `DELEGATION_LEASE_MS + skew` from that coordinator's construction — see `#grantableAfterMono` for
	 * why neither process start nor thread start is a sound anchor.
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
	/**
	 * Obtain an admission from the worker thread that coordinates this database, for a `lock()` served
	 * on a thread that is not the owner. Present only when the transport can relay across threads
	 * (harper-pro#852); a transport without it makes `acquire()` fail closed off the owner thread, as
	 * before. The returned `LockRound` was minted by the owner's coordinator; the caller's coordinator
	 * records it as a REMOTE admission and installs the handle's revoker locally, so a recall on the
	 * owner fences a write this thread's handle staged. `mintedMono` is comparable across threads
	 * because `performance.now()` shares one time origin process-wide.
	 */
	acquireOnOwner?(database: string, table: string, key: any, leaseMs: number, waitMs: number): Promise<LockRound>;
	/** Release a remote admission on the owner thread (the counterpart of `acquireOnOwner`). */
	releaseOnOwner?(database: string, table: string, key: any, admissionId: number): Promise<void> | void;
	/**
	 * Establish an exact clean-handoff dependency set, or recover the strongest reachable-member
	 * barrier when `dependencies` is null. Recovery returns the captured positions for current lock
	 * participants that were made visible; it may drain additional replication peers without carrying
	 * them in the key's lineage. Clean waits may return void. Concurrent recovery snapshots should be
	 * coalesced.
	 *
	 * Recovery asks each reachable member for a `lockBarrier` entry (`writeLockBarrier`) and drains
	 * that member's stream through the position it returns. Core races this promise against the
	 * lock's own deadline but cannot cancel it; `deadlineMs` is the wait remaining at the call, so the
	 * transport can bound its own work to it instead of outliving the lock that asked.
	 */
	establishLockFreshness(
		database: string,
		table: string,
		key: any,
		dependencies: LockDependencySet | null,
		deadlineMs: number
	): Promise<LockDependencySet | void>;
	/** Emit a control entry and return the committed entry's local origin-log position when available. */
	writeControl?(table: string, entry: LockControlEntry): Promise<number | void> | number | void;
	/**
	 * Assigned at registration so a transport can push a received entry in directly. `author` and
	 * `position` come from the authenticated origin-log header, never from the payload.
	 */
	onControlEntry?(database: string, table: string, entry: LockControlEntry, author: string, position: number): void;
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
	if (entry.type === 'lockBarrier') return controlPackr.pack([1, entry.nonce]);
	const [generation, homeIncarnation, counter] = entry.token;
	if (entry.dependencies === undefined)
		return controlPackr.pack([entry.key, entry.requester, generation, homeIncarnation, counter]);
	return controlPackr.pack([1, entry.key, entry.requester, generation, homeIncarnation, counter, entry.dependencies]);
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
	if (type !== 'lockRelease' && type !== 'lockBarrier') return undefined;
	let tuple: unknown;
	try {
		tuple = value instanceof Uint8Array ? controlPackr.unpack(value) : value;
	} catch {
		return undefined;
	}
	if (!Array.isArray(tuple)) return undefined;
	if (type === 'lockBarrier') {
		if (tuple.length !== 2 || tuple[0] !== 1) return undefined;
		const nonce = tuple[1];
		return typeof nonce === 'number' && Number.isFinite(nonce) ? { type: 'lockBarrier', nonce } : undefined;
	}
	if (tuple.length !== 5 && tuple.length !== 7) return undefined;
	try {
		return decodeTuple(tuple);
	} catch {
		// isEncodableKey recurses; a deeply nested array in a peer or replayed payload would otherwise
		// raise a RangeError into the replicated apply loop instead of being dropped as malformed.
		return undefined;
	}
}

function decodeTuple(tuple: unknown[]): LockReleaseEntry | undefined {
	const versioned = tuple.length === 7;
	if (versioned && tuple[0] !== 1) return undefined;
	const offset = versioned ? 1 : 0;
	const [key, requester, generation, homeIncarnation, counter] = tuple.slice(offset, offset + 5);
	if (!isEncodableKey(key) || !isNodeName(requester)) return undefined;
	for (const part of [generation, homeIncarnation, counter])
		if (typeof part !== 'number' || !Number.isFinite(part)) return undefined;
	let dependencies: LockDependencySet | null | undefined;
	if (versioned) {
		const rawDependencies = tuple[6];
		if (rawDependencies === null) dependencies = null;
		else dependencies = normalizeDependencies(rawDependencies);
	}
	const entry: LockReleaseEntry = {
		type: 'lockRelease',
		key,
		requester,
		token: [generation, homeIncarnation, counter] as FencingToken,
	};
	if (versioned) entry.dependencies = dependencies;
	return entry;
}

function normalizeDependencies(value: unknown, homes?: readonly string[]): LockDependencySet | undefined {
	if (!Array.isArray(value) || value.length > MAX_LOCK_DEPENDENCIES) return undefined;
	const positions = new Map<string, number>();
	const allowedOrigins = homes && new Set(homes);
	for (const dependency of value) {
		if (!Array.isArray(dependency) || dependency.length !== 2) return undefined;
		const [origin, position] = dependency;
		if (!isNodeName(origin) || typeof position !== 'number' || !Number.isFinite(position) || position < 0)
			return undefined;
		if (allowedOrigins && !allowedOrigins.has(origin)) return undefined;
		if (positions.has(origin)) return undefined;
		positions.set(origin, position);
	}
	return [...positions].sort(([a], [b]) => a.localeCompare(b));
}

class DelegatedKeyFilter {
	#bits = new Uint32Array(DELEGATED_KEY_FILTER_WORDS);

	add(key: unknown): void {
		const [first, second] = this.#hashes(key);
		for (let index = 0; index < 4; index++) this.#set((first + Math.imul(index, second)) >>> 0);
	}

	has(key: unknown): boolean {
		const [first, second] = this.#hashes(key);
		for (let index = 0; index < 4; index++) if (!this.#get((first + Math.imul(index, second)) >>> 0)) return false;
		return true;
	}

	clear(): void {
		this.#bits.fill(0);
	}

	copyFrom(other: DelegatedKeyFilter): void {
		this.#bits.set(other.#bits);
	}

	#set(hash: number): void {
		const bit = hash % (this.#bits.length * 32);
		this.#bits[bit >>> 5] |= 1 << (bit & 31);
	}

	#get(hash: number): boolean {
		const bit = hash % (this.#bits.length * 32);
		return (this.#bits[bit >>> 5] & (1 << (bit & 31))) !== 0;
	}

	#hashes(key: unknown): [number, number] {
		const value = `${typeof key}:${String(key)}`;
		let first = 0x811c9dc5;
		let second = 0x9e3779b9;
		for (let index = 0; index < value.length; index++) {
			first = Math.imul(first ^ value.charCodeAt(index), 0x01000193);
			second = Math.imul(second ^ value.charCodeAt(index), 0x85ebca6b);
		}
		return [first >>> 0, (second | 1) >>> 0];
	}
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
	dependencies: LockDependencySet;
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
	/** The one in-flight `#surrender` for this delegation; see there for why it is memoized. */
	surrendering?: Promise<void>;
}

/**
 * One `lock()` this thread admitted from the OWNER thread (harper-pro#852), addressed by a LOCAL id
 * distinct from the owner's own admission id (see `#remoteByOwnerId`), so a stale local admission can
 * never share a number with an incoming owner-minted one. `revoke` fences this thread's handle;
 * `revoked` latches a revoke that landed before `registerAdmission` supplied the real revoker.
 * `fenceWaiters` resolve once the handle is provably fenced — the owner waits on them before it writes
 * the release, so an ack never claims a fence the handle has not actually taken.
 */
interface RemoteAdmission {
	/** The owner's admission id, echoed on release and matched by an inbound revoke. */
	ownerAdmissionId: number;
	key: any;
	/** The caller-side handle fence — today always `Table.lock`'s `() => handle.revokeLease()`, which is
	 * synchronous and total, never the owner-side async relay revoker (that lives on a delegation
	 * `Admission` instead). `registerAdmission` accepts an async revoker all the same, so the ack paths
	 * here settle on the outcome rather than assuming this one. */
	revoke: () => void;
	/** Monotonic deadline of the handle's own lease; the entry is dropped once past it. */
	expiresMono: number;
	revoked: boolean;
	fenceWaiters: (() => void)[];
}

/** One `lock()` admitted under a delegation. */
interface Admission {
	/**
	 * Fences the handle's write capability. A no-op until `registerAdmission` supplies the real one. A
	 * handle admitted on another worker thread revokes over a message and resolves once that thread has
	 * fenced it; `#surrender` waits for that (or the admission's own lease) before writing the release.
	 */
	revoke: () => void | Promise<void>;
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
	/** Requirement handed to this delegate; reused if the same node renews after losing local state. */
	dependencies: LockDependencySet | null;
	/** This grant advanced from an earlier token that may already have admitted writes. */
	renewed?: boolean;
	/**
	 * Monotonic deadline on THIS node, set to the delegate's lease PLUS skew. The home always outwaits
	 * the delegate, so it can never re-grant a key the previous delegate still believes it holds.
	 */
	expiresMono: number;
	recalling?: Promise<void>;
	/** Set once the delegate confirmed it stopped admitting, so the recall is never re-sent. */
	recallConfirmed?: boolean;
	/** After a FAILED recall, the earliest this home may try that delegate again (`RECALL_RETRY_MS`). */
	recallRetryAfterMono?: number;
}

interface PendingDelegation {
	key: any;
	token: FencingToken;
	recalled: boolean;
	recalledPromise: Promise<void>;
	markRecalled: () => void;
}

const PENDING_DELEGATION_RECALLED = Symbol('pending delegation recalled');

function createPendingDelegation(key: any, token: FencingToken, recalledBeforeReply: boolean): PendingDelegation {
	let resolveRecall: () => void;
	const pending: PendingDelegation = {
		key,
		token,
		recalled: false,
		recalledPromise: new Promise((resolve) => (resolveRecall = resolve)),
		markRecalled() {
			if (pending.recalled) return;
			pending.recalled = true;
			resolveRecall();
		},
	};
	if (recalledBeforeReply) pending.markRecalled();
	return pending;
}

interface PendingRequest {
	recalledToken?: FencingToken;
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
	writeControl: (entry: LockControlEntry) => Promise<number | void> | number | void;
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
	 * an injected clock the test drives itself. See `#grantableAfterMono`.
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

/** Bound one drain step so a single unresponsive delegate cannot consume the whole transition budget. */
function withDeadline<T>(work: Promise<T>, ms: number, message = 'the quiesce deadline elapsed'): Promise<T> {
	if (!(ms > 0)) return Promise.reject(new Error(message));
	const timer = delay(ms);
	work.then(
		() => timer.cancel(),
		() => timer.cancel()
	);
	return Promise.race([
		work,
		timer.promise.then<T>(() => {
			throw new Error(message);
		}),
	]);
}

const tickingCoordinators = new Set<LockCoordinator>();
/**
 * Every coordinator alive on this thread, so a membership transition can quiesce a whole database
 * rather than one table at a time (harper-pro#856). The per-`(database, table)` resolvers cannot
 * enumerate: they answer a name you already have.
 */
const liveCoordinators = new Set<LockCoordinator>();
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
 * Fire a revoker in a fire-and-forget context, absorbing both a synchronous throw and a rejected
 * promise. A relayed revoker is `() => Promise<void>` and may reject on a dead sibling port; a
 * discarded rejection would exit the worker under Node's default policy, taking every coordinator on
 * the thread. Callers that must WAIT for the fence (`#revokeAllAndSettle`, `revokeRemoteAdmission`)
 * handle the outcome themselves and do not use this.
 */
function isPromiseLike(value: unknown): value is Promise<unknown> {
	return value != null && typeof (value as Promise<unknown>).then === 'function';
}
function fireRevokeAndForget(revoke: () => void | Promise<void>): void {
	try {
		const outcome = revoke();
		if (isPromiseLike(outcome))
			outcome.catch((error) => warnOnce('a fire-and-forget record lock revoke failed', error));
	} catch (error) {
		warnOnce('a fire-and-forget record lock revoke threw', error);
	}
}

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
	#writeControl: (entry: LockControlEntry) => Promise<number | void> | number | void;
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
	/**
	 * How long until this coordinator can rule out authority issued before it took over — 0 when it
	 * already can. Non-mutating, unlike `#ownershipHorizon`, which records ownership as a side effect.
	 *
	 * The waiver is deliberately NOT consulted. `grantableAfterMono` attests that no previous
	 * INCARNATION OF THIS PROCESS delegated; it says nothing about a sibling thread that was
	 * coordinating until this instant, and a coordinator built while already owning keeps the waiver
	 * without ever observing that handoff — which let a takeover worker in a first-incarnation process
	 * report a clean drain while the previous owner's delegates were still admitting.
	 *
	 * The cost is that a freshly built coordinator cannot prove quiescence for a full lease. That falls
	 * only on the case that does not need the proof: a node with no delegations yet is bootstrapping
	 * generation 1, where there is nothing to drain and no interval to skip.
	 */
	unprovenOwnershipMs(): number {
		const horizon = DELEGATION_LEASE_MS + this.#skewMs;
		if (this.#ownedSinceMono === undefined) return horizon;
		return Math.max(0, this.#ownedSinceMono + horizon - this.#monotonic());
	}
	/**
	 * When this coordinator was last observed to own coordination, and `undefined` while it does not.
	 *
	 * The quarantine has to run from here and not only from construction: a coordinator is built when a
	 * transport registers, but `ownsCoordination()` can flip to true long afterwards — a thread that
	 * took over from an owner that died. By then the construction horizon has aged out, and this
	 * coordinator would grant immediately over delegations the previous OWNER issued. Regaining
	 * ownership re-arms it for the same reason: something else was coordinating in between.
	 */
	#ownedSinceMono: number | undefined;
	/** Rate-limits `tick()`'s ownership poll to `OWNERSHIP_POLL_MS`. */
	#lastOwnershipPollMono = -Infinity;
	/**
	 * The `homeIncarnation` this coordinator has been coordinating under. A different one is the
	 * transport saying another coordination incarnation ran for this node (§5.1), which is the only
	 * statement about CONTINUITY available here — see `#ownershipHorizon`.
	 */
	#coordinatingIncarnation: number | undefined;
	/**
	 * Set when the caller supplied an explicit horizon. It waives both halves of the quarantine only
	 * for this coordinator's FIRST ownership interval, and `#ownershipHorizon` clears it at the first
	 * observed gap: the attestation behind it is "no previous incarnation of this process issued
	 * anything", which is a claim about process start and not about a sibling thread that coordinated
	 * while this one did not.
	 */
	#quarantineWaived: boolean;
	/** Keys this node holds a delegation for. */
	#delegations = new Map<unknown, Delegation>();
	/** Grants received but not yet installed because their freshness barrier is still running. */
	#pendingDelegations = new Map<unknown, PendingDelegation>();
	/** Outbound requests whose grant token is not known yet, so an early recall cannot be lost. */
	#pendingRequests = new Map<unknown, PendingRequest>();
	/**
	 * Every live admission, by id, and the delegation answerable for it. Coordinator-level rather than
	 * per-delegation so a release can find its admission after the delegation was renewed or replaced.
	 */
	#admissions = new Map<number, Delegation>();
	#nextAdmissionId = 1;
	/**
	 * Admissions this thread obtained from the OWNER thread (harper-pro#852), keyed by a LOCAL id drawn
	 * from `#nextAdmissionId` — never the owner's id, so it cannot collide with a live local admission.
	 * This thread holds the handle (native key, staged writes, lease timer) while the delegation that
	 * authorizes it lives on the owner. Allocated lazily so a coordinator that never serves an off-owner
	 * lock pays nothing. An entry is kept after the caller unlocks, revoker included, until the handle's
	 * own lease runs out (owner-side §6 retention: an unlocked-but-staged write is still fenceable).
	 */
	#remoteAdmissions: Map<number, RemoteAdmission> | undefined;
	/** Owner admission id → this thread's local id, so an inbound revoke (which names the owner id)
	 * reaches the right entry. */
	#remoteByOwnerId: Map<number, number> | undefined;
	/** Owner admission ids whose revoke arrived before `#acquireFromOwner` installed the entry, with the
	 * ack resolvers waiting on the eventual fence and the monotonic time they arrived. Drained when the
	 * entry installs (`#acquireFromOwner`); an entry whose acquire never lands (a revoke for an admission
	 * this thread already dropped) is resolved and swept once its wait exceeds a lease (`tick`). */
	#pendingRemoteRevokes: Map<number, { resolvers: (() => void)[]; at: number }> | undefined;
	/**
	 * Bumped every time every relayed admission is fenced wholesale (`fenceAllRemoteAdmissions`, i.e. the
	 * owner worker is gone). `#acquireFromOwner` samples it before it asks the owner and re-checks after
	 * the reply: a grant minted by an owner that has since been declared gone must NOT be installed, or
	 * this thread would start writing under an admission the replacement owner knows nothing about while
	 * that owner, starting empty, grants the same key to somebody else. Carried forward on handoff so a
	 * transport swap mid-acquire cannot reset it and re-open the window.
	 */
	#relayGeneration = 0;
	#relayedAdmissions = 0;
	/** Keys this node homes, and who holds each one. */
	#grants = new Map<unknown, HomeGrant>();
	/** Per-requester counts, so one peer cannot fill the home's table on its own. */
	#grantsByRequester = new Map<string, number>();
	/** Clean-handoff lineage outlives grants and is retained independently under its own cap. */
	#dependencySets = new Map<unknown, LockDependencySet>();
	#everDelegated = new DelegatedKeyFilter();
	#freshnessGeneration: number | undefined;
	/** False after any interval whose delegation history this coordinator could not have observed. */
	#trustVirginKeys: boolean;
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
		liveCoordinators.add(this);
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
		this.#quarantineWaived = options.grantableAfterMono !== undefined;
		this.#trustVirginKeys = this.#quarantineWaived;
		// Ownership observed here, not lazily on the first grant: a coordinator built while this thread
		// already coordinates has owned it since construction, and the construction horizon covers that.
		// Leaving it unset until a grant would date ownership from the grant and re-quarantine a reload.
		try {
			if (options.transport.ownsCoordination()) {
				this.#ownedSinceMono = this.#monotonic();
				// The incarnation it has been coordinating under, so the first grant does not read its own
				// construction as a takeover. Undefined when there is no map yet, which `#ownershipHorizon`
				// treats as a takeover — the conservative direction.
				this.#coordinatingIncarnation = options.transport.homeMap(options.database)?.homeIncarnation;
			}
		} catch {
			// A transport that cannot answer yet is not owning yet; `#ownershipHorizon` will observe it.
		}
		this.#grantableAfterMono = options.grantableAfterMono ?? this.#monotonic() + DELEGATION_LEASE_MS + this.#skewMs;
		options.adopt?.handOffTo(this);
		const retired = retiredCoordinators.get(this.#retirementKey());
		if (retired) {
			this.#counter = Math.max(this.#counter, retired.counter);
			this.#grantableAfterMono = Math.max(this.#grantableAfterMono, retired.grantableAfterMono);
			// A close without a successor discarded the key filter and retained dependency sets. An
			// explicit cold-start waiver on the replacement says nothing about that discarded history.
			this.#trustVirginKeys = false;
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
		for (const [keyId, pending] of this.#pendingDelegations) successor.#pendingDelegations.set(keyId, pending);
		for (const [keyId, request] of this.#pendingRequests) successor.#pendingRequests.set(keyId, request);
		for (const [keyId, grant] of this.#grants) successor.#grants.set(keyId, grant);
		for (const [requester, count] of this.#grantsByRequester) successor.#grantsByRequester.set(requester, count);
		// The admission index moves with the delegations it points into. Without it a handle admitted
		// on the predecessor could never be released through the successor — `release` addresses the
		// admission, so the entry would sit on the delegation forever and no recall could drain it.
		for (const [admissionId, delegation] of this.#admissions) successor.#admissions.set(admissionId, delegation);
		// Remote admissions (harper-pro#852) move with their handles: this thread still holds the native
		// key and the staged write for each, so the successor must be the one a later `release` or a
		// relayed `revoke` reaches. Their local ids stay valid (the successor's own `#nextAdmissionId` is
		// carried forward below), and the owner-id index and any not-yet-installed revokes move with them.
		if (this.#remoteAdmissions) {
			const into = (successor.#remoteAdmissions ??= new Map());
			for (const [localId, remote] of this.#remoteAdmissions) into.set(localId, remote);
			const ownerIndex = (successor.#remoteByOwnerId ??= new Map());
			for (const [ownerId, localId] of this.#remoteByOwnerId ?? []) ownerIndex.set(ownerId, localId);
			this.#remoteAdmissions = undefined;
			this.#remoteByOwnerId = undefined;
		}
		if (this.#pendingRemoteRevokes) {
			const into = (successor.#pendingRemoteRevokes ??= new Map());
			for (const [ownerId, entry] of this.#pendingRemoteRevokes) {
				const existing = into.get(ownerId);
				if (existing) existing.resolvers.push(...entry.resolvers);
				else into.set(ownerId, entry);
			}
			this.#pendingRemoteRevokes = undefined;
		}
		successor.#relayedAdmissions += this.#relayedAdmissions;
		// Never backwards: an acquire that sampled the predecessor must still see a bump the successor
		// (or the predecessor) already recorded, so a swap mid-acquire cannot re-open the orphan window.
		successor.#relayGeneration = Math.max(successor.#relayGeneration, this.#relayGeneration);
		// Neither counter may restart. A repeated token would compare equal to one the predecessor
		// already issued for a different delegation; a repeated admission id would address the wrong
		// admission in the map just carried over.
		successor.#counter = Math.max(successor.#counter, this.#counter);
		successor.#nextAdmissionId = Math.max(successor.#nextAdmissionId, this.#nextAdmissionId);
		// The predecessor's horizon EXACTLY, not the successor's freshly computed one. Adoption means the
		// successor now knows everything the predecessor knew, so it faces the same cold-start hazard and
		// no more: recomputing from its own construction would quarantine a node for a full delegation
		// lease on every transport reload, and clearing it would let a swap inside the window grant over
		// an unseen predecessor incarnation.
		successor.#grantableAfterMono = this.#grantableAfterMono;
		// And the ownership clock: a transport reload does not change which thread coordinates, so the
		// successor inherits how long this one has owned it rather than starting a fresh interval. The
		// waiver rides along with it and in the same direction: the successor reads `grantableAfterMono`
		// off the new transport and would otherwise re-waive a horizon this coordinator had already lost
		// to a takeover.
		//
		// Only what this coordinator actually OBSERVED may override that, though. `undefined` on either
		// of these means "never saw it" — a coordinator built on a non-owning thread, or before a map
		// was available — and the successor has just read the new transport, which is not less current.
		// Carrying the blank over it re-armed a quarantine on a node that had never stopped coordinating.
		if (this.#ownedSinceMono !== undefined) {
			successor.#ownedSinceMono = this.#ownedSinceMono;
			successor.#quarantineWaived = this.#quarantineWaived;
		}
		if (this.#coordinatingIncarnation !== undefined) successor.#coordinatingIncarnation = this.#coordinatingIncarnation;
		successor.#dependencySets = this.#dependencySets;
		successor.#everDelegated.copyFrom(this.#everDelegated);
		successor.#freshnessGeneration = this.#freshnessGeneration;
		successor.#trustVirginKeys = this.#trustVirginKeys;
		this.#dependencySets = new Map();
		this.#everDelegated.clear();
		this.#delegations.clear();
		this.#pendingDelegations.clear();
		this.#pendingRequests.clear();
		this.#grants.clear();
		this.#grantsByRequester.clear();
		this.#admissions.clear();
		if (
			successor.#delegations.size > 0 ||
			successor.#pendingDelegations.size > 0 ||
			successor.#grants.size > 0 ||
			(successor.#remoteAdmissions?.size ?? 0) > 0 ||
			(successor.#pendingRemoteRevokes?.size ?? 0) > 0
		)
			successor.#startTicking();
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
		relayedAdmissions: number;
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
			// Admissions this thread has obtained from the owner worker (harper-pro#852), cumulative
			// rather than current: what it makes visible in `cluster_status` is that off-owner `lock()`s
			// are being served here at all.
			relayedAdmissions: this.#relayedAdmissions,
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
	acquire(key: any, leaseMs: number, waitMs: number): Promise<LockRound> {
		return this.#acquire(key, leaseMs, waitMs);
	}

	async #acquire(key: any, leaseMs: number, waitMs: number, observed?: LastCompletedReply): Promise<LockRound> {
		// `Table.lock()` captures a coordinator and only reaches here after the native key lock, which
		// can wait the caller's whole timeout — long enough for a transport swap to close what it
		// captured. Authority moved to the successor rather than away, so run there instead of
		// rejecting a caller that is already holding the key.
		const authority = this.#authority();
		if (authority !== this) return authority.#acquire(key, leaseMs, waitMs, observed);
		if (this.#closed) throw new LockUnavailableError('Cluster record lock coordination was closed for this table');
		if (!this.transport.ownsCoordination()) {
			// Off the coordinating thread. A transport that can relay obtains the admission from the
			// owner and installs the handle's revoker here (harper-pro#852); one that cannot fails
			// closed, the historical contract.
			// BOTH halves or neither. A transport that could acquire but not release would route locks and
			// then never forward an unlock, leaving every admission `holding` on the owner for its full
			// lease and stalling peer recalls — worse than the honest 503 below.
			if (this.transport.acquireOnOwner && this.transport.releaseOnOwner)
				return this.#acquireFromOwner(key, leaseMs, waitMs);
			throw new LockUnavailableError(
				'Cluster record lock coordination is not owned by this worker thread; retry so the request reaches the coordinating thread'
			);
		}
		const keyId = this.#keyIdOf(key);
		const deadlineMono = this.#monotonic() + waitMs;
		let lastCompleted = observed;

		acquisition: for (;;) {
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
			const pendingRequest: PendingRequest = {};
			this.#pendingRequests.set(keyId, pendingRequest);
			let reply: DelegationReply;
			try {
				reply =
					home === this.nodeId
						? this.#grantLocally(keyId, key, homeMap, leaseMs)
						: await this.#requestRemotely(home, keyId, key, homeMap, leaseMs, deadlineMono);
			} catch (error) {
				const requestAuthority = this.#authority();
				if (requestAuthority.#pendingRequests.get(keyId) === pendingRequest)
					requestAuthority.#pendingRequests.delete(keyId);
				throw error;
			}

			// A transport swap can land while a request is in flight. The grant is authority for this
			// NODE, and the successor is this node now — installing it here would leave a delegation
			// nothing consults, admitting a caller that no recall can reach.
			let authority = this.#authority();
			if (authority.#pendingRequests.get(keyId) === pendingRequest) authority.#pendingRequests.delete(keyId);
			if (authority.#closed)
				throw new LockUnavailableError('Cluster record lock coordination was closed for this table');

			const replyDependencies =
				reply.dependencies === null ? null : normalizeDependencies(reply.dependencies, homeMap.homes);
			if (
				reply.granted &&
				isFencingToken(reply.token) &&
				isDuration(reply.leaseMs, MIN_LOCK_LEASE_MS, DELEGATION_LEASE_MS) &&
				replyDependencies !== undefined
			) {
				const recalledBeforeReply =
					pendingRequest.recalledToken !== undefined && compareTokens(pendingRequest.recalledToken, reply.token) === 0;
				const existing = authority.#delegations.get(keyId);
				if (
					existing &&
					!existing.recalled &&
					existing.token[0] === reply.token[0] &&
					compareTokens(existing.token, reply.token) < 0
				) {
					// This is a continuous renewal of authority this node already made fresh. No other
					// delegate could have held the key, so repeating the barrier — especially recovery —
					// buys no freshness. The home still returns its requirement for the case where the
					// requester lost local state and has no existing delegation to prove continuity.
					const renewed = authority.#installDelegation(
						keyId,
						key,
						reply.token,
						reply.leaseMs,
						requestedAtMono,
						existing.dependencies
					);
					if (renewed && recalledBeforeReply) {
						// The renewed delegation inherits every admission from the old token. Drain those
						// admissions through the ordinary recall path; surrendering directly would revoke
						// their handles and clear the home's grant while their critical sections still run.
						await authority.onDelegationRecall({ key, token: reply.token });
						if (authority.#closed)
							throw new LockUnavailableError('Cluster record lock coordination was closed for this table');
						continue acquisition;
					}
					if (renewed && renewed.expiresMono - authority.#monotonic() >= leaseMs)
						return authority.#admit(renewed, leaseMs);
					continue acquisition;
				}
				const pending = createPendingDelegation(key, reply.token, recalledBeforeReply);
				authority.#pendingDelegations.set(keyId, pending);
				let dependencies: LockDependencySet;
				try {
					let requirement = replyDependencies;
					for (;;) {
						const barrierAuthority = authority;
						dependencies = await barrierAuthority.#establishFreshness(
							key,
							requirement,
							homeMap.homes,
							deadlineMono,
							pending
						);
						authority = this.#authority();
						if (authority === barrierAuthority) break;
						requirement = dependencies;
					}
				} catch (error) {
					authority = this.#authority();
					if (authority.#pendingDelegations.get(keyId) === pending) authority.#pendingDelegations.delete(keyId);
					await authority.#releaseUnclaimedGrant(key, reply.token);
					if (error === PENDING_DELEGATION_RECALLED) {
						if (authority.#closed)
							throw new LockUnavailableError('Cluster record lock coordination was closed for this table');
						continue acquisition;
					}
					throw new LockUnavailableError(
						`Could not establish successor freshness for ${this.database}.${this.table}: ${(error as Error)?.message ?? error}`
					);
				}
				const currentPending = authority.#pendingDelegations.get(keyId);
				if (currentPending === pending) authority.#pendingDelegations.delete(keyId);
				if (currentPending !== pending || pending.recalled) {
					await authority.#releaseUnclaimedGrant(key, reply.token);
					if (authority.#closed)
						throw new LockUnavailableError('Cluster record lock coordination was closed for this table');
					continue;
				}
				// The generation can advance across the await. A grant minted under a superseded one is
				// authority for a ring that no longer exists: the key may be homed elsewhere now, and that
				// home can already have granted it to another node. `#liveDelegation` rejects a stale
				// token on the NEXT pass, which is too late — this pass would have admitted on it first.
				if (reply.token[0] !== authority.transport.homeMap(this.database)?.generation) {
					// Hand it back rather than let the old home hold a key nobody is using for a full lease.
					authority.#releaseUnclaimedGrant(key, reply.token);
				} else {
					const installed = authority.#installDelegation(
						keyId,
						key,
						reply.token,
						reply.leaseMs,
						requestedAtMono,
						dependencies
					);
					// A reply that outlived its own delegation grants nothing; fall through and ask again
					// rather than admitting on authority the home has already expired.
					if (installed && !installed.recalled && installed.expiresMono - authority.#monotonic() >= leaseMs)
						return authority.#admit(installed, leaseMs);
					// A long barrier can consume enough of the delegation that the requested lease no longer
					// fits. Surrender the unused installed delegation before retrying; otherwise the home renews
					// it in place on every pass and contenders wait for its full deadline.
					if (installed && compareTokens(installed.token, reply.token) === 0 && installed.holding === 0)
						await authority.#surrender(keyId, installed);
					else if (!installed) await authority.#releaseUnclaimedGrant(key, reply.token);
				}
			} else if (reply.granted) {
				if (isFencingToken(reply.token)) authority.#releaseUnclaimedGrant(key, reply.token);
				throw new LockUnavailableError(
					`The home node for this key on ${this.database}.${this.table} returned a delegation with no usable token or freshness requirement`
				);
			}
			if (reply.reason === 'capacity')
				throw new LockUnavailableError(`Too many record lock delegations in flight on ${this.database}`);
			if (reply.reason === 'quarantine')
				throw new LockUnavailableError(
					`The home node for this key on ${this.database}.${this.table} restarted and cannot grant until the delegations its previous incarnation issued have expired`
				);
			// Neither of these can be waited out inside a `lock()` timeout, and retrying them spends the
			// caller's whole budget holding the native key only to answer 423 for a key nobody holds.
			if (reply.reason === 'generation')
				throw new LockUnavailableError(
					`The home node for this key on ${this.database}.${this.table} holds record lock home map generation ${reply.generation ?? 'unknown'} and this node holds ${homeMap.generation}; cluster record locks are unavailable until they agree`
				);
			if (reply.reason === 'unknown-node')
				throw new LockUnavailableError(
					`This node is not named in the record lock home map for ${this.database}, so it can neither home a key nor take a cluster lock on one`
				);
			if (reply.reason === 'not-home')
				// The home disagrees about the ring. Re-reading the map on the next pass is the fix, and it
				// converges if our copy is the stale one — so unlike the denials above this one is worth
				// retrying. If it is NOT stale (two maps under one generation number) it never converges,
				// which the terminal answer below is what handles.
				warnOnce('record lock home disagreed about the ring', { database: this.database, table: this.table });

			if (reply.reason !== 'timeout') lastCompleted = { reply, home, generation: homeMap.generation };
			const remaining = deadlineMono - this.#monotonic();
			const retryAfterMs = reply.retryAfterMs ?? 25;
			// A home this node IS costs nothing to ask again — `#grantLocally` is synchronous, so a release
			// landing in the backoff is still grantable at the deadline. A remote home is not: its request
			// would go out with the leftover budget and could only return this node's own `timeout`.
			const exhausted = home === this.nodeId ? remaining <= 0 : remaining <= retryAfterMs;
			if (!exhausted) await delay(Math.min(retryAfterMs, remaining)).promise;
			if (this.#closed) {
				// Same swap, landing in the backoff instead. The successor inherits both the remaining wait
				// and what this one saw, since a successor exhausted on arrival has nothing of its own.
				const successor = this.#authority();
				if (successor === this)
					throw new LockUnavailableError('Cluster record lock coordination was closed for this table');
				return successor.#acquire(key, leaseMs, Math.max(0, deadlineMono - this.#monotonic()), lastCompleted);
			}
			if (!exhausted) continue acquisition;
			// Only an observation made under the generation that is current NOW still describes the key —
			// this pass's reply included, since a generation can be activated while the probe that ended
			// the wait is still in flight. Hence a fresh read rather than the copy this pass started from.
			const currentGeneration = this.transport.homeMap(this.database)?.generation;
			const carried =
				lastCompleted?.home === home && lastCompleted.generation === currentGeneration
					? lastCompleted.reply
					: undefined;
			const terminal = carried ?? (homeMap.generation === currentGeneration ? reply : undefined);
			// Only `contended` may end as 423: every other reason ran out the clock without the key ever
			// being held, and reporting contention sends the caller to retry a condition no wait outlasts.
			if (terminal?.reason === 'contended') throw new ClientError('Record is locked and was not released in time', 423);
			throw new LockUnavailableError(
				`Could not establish a cluster record lock on ${this.database}.${this.table} within the wait: ${describeExhaustedWait(terminal, currentGeneration !== undefined)}`
			);
		}
	}

	/**
	 * Obtain an admission from the owner worker for a `lock()` served on a non-owner thread
	 * (harper-pro#852), recorded under a LOCAL id so `registerAdmission`/`release` can never collide it
	 * with a live local admission. `acquireOnOwner` is bounded by the transport, inside the caller's
	 * `waitMs`; the race here is core's own backstop against a transport that never answers, so `lock()`
	 * cannot hang far past the wait it was given.
	 */
	async #acquireFromOwner(key: any, leaseMs: number, waitMs: number): Promise<LockRound> {
		// The transport bounds this wait (harper-pro's acquire has its own `waitMs`-scaled timeout); the
		// core-side race is a last-resort backstop set strictly beyond that bound — the transport is asked
		// for `waitMs - hop` and core's deadline is `waitMs + REMOTE_ACQUIRE_BACKSTOP_MS` — so it fires only
		// if the transport never returns, never ahead of the transport's own timeout. Without it a wedged
		// owner would hang `lock()` past its `waitMs`.
		// Sampled BEFORE the request goes out, on the authority that will install the result.
		const startGeneration = this.#authority().#relayGeneration;
		// The hop allowance comes OUT of the caller's budget, never on top of it: `lock()` holds the native
		// key for this whole wait, so overshooting `waitMs` blocks every other worker on the key for the
		// overshoot. The transport is asked for the reduced wait and answers within the caller's budget;
		// core's deadline is the caller's `waitMs` plus a small net that fires only if the transport never
		// answers at all.
		const hop = Math.min(REMOTE_ACQUIRE_HOP_MS, Math.floor(waitMs / 2));
		// A transport that throws SYNCHRONOUSLY (a sibling port already gone) must still reach the
		// normalization below: escaping raw gives the caller a 500 where it needs the retryable 503.
		// `#beginRecall` wraps its transport call for the same reason.
		const acquire = Promise.resolve().then(() =>
			this.transport.acquireOnOwner!(this.database, this.table, key, leaseMs, waitMs - hop)
		);
		let backstopWon = false;
		// If the backstop wins the race, the owner may still grant afterward: release that grant back so it
		// does not sit `holding` on the owner for its whole lease. (The transport releases a late reply too;
		// this closes the case where core's backstop fired first.)
		acquire.then(
			(round) => {
				if (backstopWon) this.#authority().#releaseOnOwnerSafely(key, round.admissionId);
			},
			() => {}
		);
		const round = await withDeadline(
			acquire,
			waitMs + REMOTE_ACQUIRE_BACKSTOP_MS,
			'the coordinating worker did not answer'
		).catch((error) => {
			backstopWon = true;
			throw error instanceof LockUnavailableError
				? error
				: new LockUnavailableError(
						`Could not obtain a cluster record lock on ${this.database}.${this.table} from the coordinating worker: ${(error as Error)?.message ?? error}`
					);
		});
		const authority = this.#authority();
		if (authority.#closed) {
			// The coordinator closed while the owner was granting. The owner still holds this admission;
			// hand it straight back rather than leaving it outstanding for its whole lease.
			authority.#releaseOnOwnerSafely(key, round.admissionId);
			throw new LockUnavailableError('Cluster record lock coordination was closed for this table');
		}
		if (authority.#relayGeneration !== startGeneration) {
			// Every relayed admission was fenced while this grant was in flight: the owner that minted it
			// has been declared gone, and the replacement starts with no record of it. Installing it now
			// would let this thread write under an admission the new owner can neither see nor recall,
			// while that owner grants the same key to another worker — two writers. Fail closed and hand
			// the grant back; the caller retries against the new owner.
			authority.#releaseOnOwnerSafely(key, round.admissionId);
			throw new LockUnavailableError(
				'The record lock coordinating worker changed while this lock was being granted; retry against the new owner'
			);
		}
		// A live entry already keyed to this owner id means the owner reused an id its counter had already
		// issued — only possible if a replacement owner restarted its sequence. The old entry is from that
		// prior owner incarnation and its delegation is gone: fence it fail-closed before the new one takes
		// the id, so a later revoke for this id can never address the stale handle.
		const collidingLocalId = authority.#remoteByOwnerId?.get(round.admissionId);
		if (collidingLocalId !== undefined) {
			const stale = authority.#remoteAdmissions?.get(collidingLocalId);
			if (stale) {
				fireRevokeAndForget(stale.revoke);
				authority.#dropRemoteAdmission(collidingLocalId, stale);
			}
		}
		const localId = authority.#nextAdmissionId++;
		const entry: RemoteAdmission = {
			ownerAdmissionId: round.admissionId,
			key,
			revoke: noRevoke,
			expiresMono: round.mintedMono + leaseMs,
			revoked: false,
			fenceWaiters: [],
		};
		(authority.#remoteAdmissions ??= new Map()).set(localId, entry);
		(authority.#remoteByOwnerId ??= new Map()).set(round.admissionId, localId);
		// A revoke that raced ahead of this install (the owner registered its revoker before it posted
		// the grant reply, so a recall in that window fired first): apply it now so the ack the owner is
		// waiting on cannot resolve before the handle is fenced.
		const pending = authority.#pendingRemoteRevokes?.get(round.admissionId);
		if (pending) {
			authority.#pendingRemoteRevokes!.delete(round.admissionId);
			entry.revoked = true;
			entry.fenceWaiters.push(...pending.resolvers);
		}
		authority.#relayedAdmissions++;
		// Tick so an entry whose caller never releases (its lease elapses instead) is still pruned.
		authority.#startTicking();
		// The LOCAL id is what the handle registers and releases against; the round the owner minted
		// still carries its own id, which only the owner-facing release/revoke messages use.
		return { tsR: round.tsR, mintedMono: round.mintedMono, admissionId: localId };
	}

	/**
	 * Fence a remote admission's handle on this thread, driven by a recall or surrender on the owner
	 * (harper-pro#852), addressed by the OWNER's admission id. Resolves once the handle is provably
	 * fenced — its `revokeLease` has run — so the owner's ack cannot claim a fence the handle has not
	 * taken; the owner waits on this before writing the release. A revoke that arrives before the handle
	 * is installed, or before `registerAdmission` supplies the real revoker, resolves only when the fence
	 * finally lands. A revoker that throws, or whose promise rejects, fails this promise rather than
	 * resolving it, so the owner falls back to its own lease bound rather than being told the fence
	 * succeeded.
	 */
	revokeRemoteAdmission(ownerAdmissionId: number): Promise<void> {
		const localId = this.#remoteByOwnerId?.get(ownerAdmissionId);
		if (localId === undefined) {
			// The entry is not installed yet (a revoke that raced ahead of the grant reply): latch the ack
			// resolver so `#acquireFromOwner` can carry it, and never fence-then-resolve a handle that does
			// not exist. If the acquire never lands (a revoke for an admission already dropped), `tick`
			// resolves and sweeps it after a lease so the resolver cannot leak.
			return new Promise<void>((resolve) => {
				const map = (this.#pendingRemoteRevokes ??= new Map());
				const pending = map.get(ownerAdmissionId);
				if (pending) pending.resolvers.push(resolve);
				else map.set(ownerAdmissionId, { resolvers: [resolve], at: this.#monotonic() });
				this.#startTicking();
			});
		}
		const remote = this.#remoteAdmissions?.get(localId);
		if (!remote) return Promise.resolve();
		remote.revoked = true;
		if (remote.revoke === noRevoke) {
			// The handle has not registered its revoker yet; resolve when `registerAdmission` fences it.
			return new Promise<void>((resolve) => remote.fenceWaiters.push(resolve));
		}
		return Promise.resolve(this.#fenceRemoteAdmission(localId, remote));
	}

	/**
	 * Fire a remote admission's revoker and report when the handle is PROVABLY fenced. `registerAdmission`
	 * accepts an async revoker, so an outcome that is promise-like is not a fence until it fulfils: the
	 * entry is dropped — and any ack waiting on it settled — only then. A rejection is not a fence at all,
	 * so it propagates and the entry is LEFT for the lease sweep: a retry can fire the revoker again, and
	 * the owner either sees the failure or waits its own lease bound out rather than writing the release
	 * and admitting a successor over a live writer. Unlike a plain release, which retains the entry
	 * because a staged write is still committable until the lease.
	 */
	#fenceRemoteAdmission(localId: number, remote: RemoteAdmission): void | Promise<void> {
		let fenced: void | Promise<void>;
		try {
			fenced = remote.revoke();
		} catch (error) {
			// A synchronous throw is not a fence either, and it must not escape past the promise this
			// function's callers hand to the owner: surface it as a rejection instead.
			warnOnce('a relayed record lock fence failed; the handle lease still bounds it', error);
			return Promise.reject(error);
		}
		if (!isPromiseLike(fenced)) {
			this.#dropRemoteAdmission(localId, remote);
			return;
		}
		return fenced.then(
			() => {
				this.#dropRemoteAdmission(localId, remote);
			},
			(error) => {
				warnOnce('a relayed record lock fence failed; the handle lease still bounds it', error);
				throw error;
			}
		);
	}

	/**
	 * Fence every relayed handle this thread holds, fail-closed (harper-pro#852). Called when the owner
	 * worker that granted them is gone (its thread exited, so its delegation table died with it): the
	 * handles are no longer backed by any delegation, so nothing here may keep committing. There is no
	 * owner left to tell, so this only revokes locally and drops the entries; a still-pending ack is
	 * resolved, since the handle can no longer commit.
	 */
	fenceAllRemoteAdmissions(): void {
		// Before anything is torn down, so an acquire already in flight to the departed owner fails its
		// post-reply generation check rather than installing an orphaned admission.
		this.#relayGeneration++;
		if (this.#remoteAdmissions) {
			for (const remote of this.#remoteAdmissions.values()) {
				fireRevokeAndForget(remote.revoke);
				this.#settleFenceWaiters(remote);
			}
			this.#remoteAdmissions = undefined;
			this.#remoteByOwnerId = undefined;
		}
		if (this.#pendingRemoteRevokes) {
			for (const entry of this.#pendingRemoteRevokes.values()) for (const resolve of entry.resolvers) resolve();
			this.#pendingRemoteRevokes = undefined;
		}
	}

	/**
	 * Forward a release to the owner, naming the admission by the OWNER's id. Core deliberately carries no
	 * owner epoch of its own: a release for an id a replacement owner has since reused is rejected by the
	 * transport, which stamps every release with the owner session captured when the admission was minted
	 * and drops its cached sessions when the coordinating thread changes. An owner ignores anything not
	 * stamped with its own session, so a stale release cannot address a live admission that reuses the id.
	 */
	#releaseOnOwnerSafely(key: any, ownerAdmissionId: number): void {
		// The common relayed unlock is a synchronous post to the owner thread, so it must not cost a
		// promise chain and two microtasks per unlock: call it directly and only attach a rejection
		// handler when the transport actually returned a promise.
		try {
			const outcome = this.transport.releaseOnOwner?.(this.database, this.table, key, ownerAdmissionId);
			if (isPromiseLike(outcome))
				outcome.catch((error) => warnOnce('failed to forward a relayed record lock release to the owner', error));
		} catch (error) {
			warnOnce('failed to forward a relayed record lock release to the owner', error);
		}
	}

	/** Resolve every ack waiting on a remote admission's fence, then forget them. */
	#settleFenceWaiters(remote: RemoteAdmission): void {
		if (remote.fenceWaiters.length === 0) return;
		const waiters = remote.fenceWaiters;
		remote.fenceWaiters = [];
		for (const resolve of waiters) resolve();
	}

	/**
	 * Drop remote admissions whose handle lease elapsed a grace ago, at most `MAX_EXPIRIES_PER_TICK` per
	 * tick like the delegation and grant sweeps — a burst of tens of thousands of same-lease admissions
	 * expiring together drains over several ticks rather than deleting them all (and firing a release
	 * message apiece) in one 100 ms turn. The scan skips still-live entries so different lease lengths are
	 * handled. `REMOTE_PRUNE_GRACE_MS` past the lease is what lets the handle's OWN lease timer fire first
	 * and forward its release (`release`) rather than racing this sweep.
	 *
	 * Entries EXAMINED are bounded too, not just deletions: a thread holding many live relayed admissions
	 * would otherwise walk every one of them on every 100 ms tick, purely to find nothing. What is left
	 * unexamined is reached on a later tick, which is safe because this sweep only reclaims memory — an
	 * admission's handle is fenced by its own lease, never by this loop running promptly.
	 *
	 * The scan restarts at the map head each tick rather than carrying a cursor, so above the examine cap
	 * a long-lived prefix would delay collecting expired entries behind it. Accepted deliberately: the cap
	 * is far above any realistic count of concurrent off-owner locks on one thread, and a cursor would
	 * have to walk the prefix anyway to find its resume point, spending the work it meant to save. It
	 * costs memory held longer in a case that should not arise, never correctness.
	 */
	#pruneRemoteAdmissions(now: number): void {
		const remotes = this.#remoteAdmissions;
		if (!remotes) return;
		const horizon = now - REMOTE_PRUNE_GRACE_MS;
		let budget = MAX_EXPIRIES_PER_TICK;
		let examined = MAX_EXAMINED_PER_TICK;
		for (const [localId, remote] of remotes) {
			if (budget <= 0 || examined <= 0) break;
			examined--;
			if (remote.expiresMono > horizon) continue;
			budget--;
			this.#dropRemoteAdmission(localId, remote, true);
		}
		if (remotes.size === 0) {
			this.#remoteAdmissions = undefined;
			this.#remoteByOwnerId = undefined;
		}
	}

	/**
	 * Drop a remote admission entry. `forwardRelease` tells the owner to give the delegation up now —
	 * set when pruning at lease, since an event-loop stall can let this sweep run before the handle's
	 * own lease timer forwards the release, and the owner would otherwise hold `holding` until its own
	 * delegation lease. The forward is idempotent on the owner, so a race with the handle's own release
	 * is harmless. Not set for a fence-drop: the owner is already surrendering that delegation.
	 */
	#dropRemoteAdmission(localId: number, remote: RemoteAdmission, forwardRelease = false): void {
		// Optional: an asynchronous fence can settle after `fenceAllRemoteAdmissions`, `close` or a
		// handoff has already cleared the map, and a TypeError here would reject an ack whose handle is
		// in fact fenced, making the owner wait out the lease for nothing.
		this.#remoteAdmissions?.delete(localId);
		this.#remoteByOwnerId?.delete(remote.ownerAdmissionId);
		// The handle's own lease has elapsed, so it fences itself; a still-pending ack may resolve.
		this.#settleFenceWaiters(remote);
		if (forwardRelease) this.#releaseOnOwnerSafely(remote.key, remote.ownerAdmissionId);
	}

	/**
	 * Resolve and drop a latched revoke whose admission never installed — a revoke for an admission this
	 * thread had already dropped (fenced or pruned), so the handle is gone and the ack is vacuously
	 * satisfied. Bounded by a lease: past that, no acquire can still be in flight for the id.
	 */
	#prunePendingRemoteRevokes(now: number): void {
		const pending = this.#pendingRemoteRevokes;
		if (!pending) return;
		// Bounded like the admission sweep above, and for the same reason: what this tick does not reach,
		// a later one does. Each waiting ack is independently bounded by the owner's own lease wait.
		let examined = MAX_EXAMINED_PER_TICK;
		for (const [ownerId, entry] of pending) {
			if (examined <= 0) break;
			examined--;
			if (now - entry.at < MAX_LOCK_LEASE_MS) continue;
			pending.delete(ownerId);
			for (const resolve of entry.resolvers) resolve();
		}
		if (pending.size === 0) this.#pendingRemoteRevokes = undefined;
	}

	/**
	 * End this node's admission for a key. The delegation is deliberately KEPT: that is the
	 * amortization, and the next `lock()` on this node costs nothing. Returns the durable release
	 * write only when the delegation is actually being given up.
	 */
	release(key: any, admissionId: number): Promise<void> | void {
		// A remote admission (harper-pro#852) — the common path once threads.count > 1 — tells the owner
		// this caller unlocked (its own id, not this thread's local one) but keeps the entry, revoker
		// included, until the handle's lease runs out: §6 revokes CAPABILITY, not admission, so a write
		// staged before `unlock()` stays fenceable. Checked before `#keyIdOf` so a relayed unlock does not
		// pay that key encoding for nothing.
		const remote = this.#remoteAdmissions?.get(admissionId);
		if (remote) {
			this.#releaseOnOwnerSafely(remote.key, remote.ownerAdmissionId);
			return undefined;
		}
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
	applyEntry(entry: LockControlEntry, author: string, position?: number): void {
		// The only boundary peer input crosses into this state machine. A throw here would reach the
		// replicated apply loop and drop the whole enclosing transaction, so one malformed entry could
		// stall replication for the database.
		try {
			this.#applyEntry(entry, author, position);
		} catch (error) {
			warnOnce('failed to apply a record lock control entry', error);
		}
	}

	#applyEntry(entry: LockControlEntry, author: string, position?: number): void {
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
		if (!isFencingToken(entry.token)) return;
		const keyId = this.#keyIdOf(entry.key);
		const grant = this.#grants.get(keyId);
		// Only the delegate named in the live grant can clear it, and only for the exact token it was
		// issued — generation and incarnation included, since counters restart. A delayed release from a
		// previous delegation must not clear its successor's.
		if (!grant || grant.delegate !== author || compareTokens(grant.token, entry.token) !== 0) return;
		if (entry.dependencies !== null) {
			const homeMap = this.transport.homeMap(this.database);
			const matchingHomes = homeMap?.generation === entry.token[0] ? homeMap.homes : undefined;
			const inherited = matchingHomes ? normalizeDependencies(entry.dependencies, matchingHomes) : undefined;
			if (
				inherited &&
				matchingHomes.includes(author) &&
				typeof position === 'number' &&
				Number.isFinite(position) &&
				position >= 0
			) {
				const merged = new Map<string, number>(this.#dependencySets.get(keyId));
				for (const [origin, dependencyPosition] of inherited)
					merged.set(origin, Math.max(merged.get(origin) ?? -Infinity, dependencyPosition));
				merged.set(author, Math.max(merged.get(author) ?? -Infinity, position));
				if (merged.size <= MAX_LOCK_DEPENDENCIES)
					this.#rememberDependencies(
						keyId,
						[...merged].sort(([a], [b]) => a.localeCompare(b))
					);
				else this.#dependencySets.delete(keyId);
			} else {
				this.#dependencySets.delete(keyId);
			}
		} else if (grant.renewed) this.#dependencySets.delete(keyId);
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
		// Membership before state: a node the current map does not name has no claim on a key, and an
		// authenticated replication identity outlives membership. Without this a decommissioned node
		// takes delegations against live homes and recalls the legitimate delegate to get them. This is
		// why `homes` has to name every node that takes a cluster lock, not only the arbiters — see
		// `LockHomeMap.homes`.
		if (!homeMap.homes.includes(request.requester)) return { granted: false, reason: 'unknown-node' };
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
		// A close that was not a handoff expired and revoked every delegation first, so nothing here can
		// admit on any token and resolving is honest. A handoff does not reach this: the table's getter
		// answers the successor, which adopted them.
		if (this.#closed) return;
		// Ownership-gated like `onDelegationRequest`, and for the stronger reason: `acquire` refuses off
		// the owner thread, so a delegation only ever lives on the coordinating one. A recall routed to
		// any other thread finds no delegation and would resolve — which the home reads as a drained
		// delegate — while the real delegate keeps admitting. Resolving has to mean nothing on THIS NODE
		// can admit on that token, and only the owner can say so.
		if (!this.transport.ownsCoordination())
			throw new Error('Cluster record lock coordination is not owned by this worker thread');
		const keyId = this.#keyIdOf(recall.key);
		const pending = this.#pendingDelegations.get(keyId);
		if (pending && compareTokens(pending.token, recall.token) === 0) {
			pending.markRecalled();
			return;
		}
		const delegation = this.#delegations.get(keyId);
		if (!delegation || compareTokens(delegation.token, recall.token) !== 0) {
			// A recall can beat the grant reply. Remember its token so that reply cannot install authority
			// the home already believes drained.
			const request = this.#pendingRequests.get(keyId);
			if (request) request.recalledToken = recall.token;
			return;
		}
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
		// A second, weaker signal than the incarnation: it catches a thread that stopped coordinating
		// without anything else starting, which advances no incarnation. Rate-limited well below the
		// tick because it cannot matter faster than a delegation lease, and it costs nothing at all on a
		// coordinator holding nothing — that one has already stopped ticking.
		if (now - this.#lastOwnershipPollMono >= OWNERSHIP_POLL_MS) {
			this.#lastOwnershipPollMono = now;
			this.#observeOwnership();
		}
		this.#pruneRemoteAdmissions(now);
		this.#prunePendingRemoteRevokes(now);
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
			this.#expireGrant(keyId, grant);
		}
		if (
			this.#delegations.size === 0 &&
			this.#grants.size === 0 &&
			!this.#remoteAdmissions &&
			!this.#pendingRemoteRevokes
		)
			tickingCoordinators.delete(this);
	}

	/**
	 * One table's half of `quiesceDelegations`. Never throws for a single grant: a transition needs to
	 * know exactly what is still live, and one unreachable delegate must not hide the rest.
	 */
	async quiesce(result: QuiesceResult, remaining: () => number): Promise<void> {
		if (this.#closed) return;
		// Delegate side first: this is what admits, and surrendering is purely local — it cannot be
		// refused by an unreachable peer, so it succeeds even when the recalls below do not.
		for (const delegation of [...this.#delegations.values()]) {
			try {
				await withDeadline(this.onDelegationRecall({ key: delegation.key, token: delegation.token }), remaining());
				result.surrendered++;
			} catch (error) {
				result.outstanding.push({
					table: this.table,
					key: delegation.key,
					reason: `this node still holds a delegation it could not drain: ${(error as Error)?.message ?? error}`,
				});
			}
		}
		// Home side: tell delegates elsewhere to stop. `#beginRecall` owns the retry and confirmation
		// bookkeeping; this only drives it and reports what it did not confirm.
		for (const [keyId, grant] of [...this.#grants]) {
			if (grant.recallConfirmed) {
				result.recalled++;
				continue;
			}
			try {
				this.#beginRecall(keyId, grant);
				if (grant.recalling) await withDeadline(grant.recalling, remaining());
				if (grant.recallConfirmed) result.recalled++;
				else
					result.outstanding.push({
						table: this.table,
						key: grant.key,
						delegate: grant.delegate,
						reason: 'the delegate did not confirm it stopped admitting',
					});
			} catch (error) {
				result.outstanding.push({
					table: this.table,
					key: grant.key,
					delegate: grant.delegate,
					reason: `recall failed: ${(error as Error)?.message ?? error}`,
				});
			}
		}
	}

	/**
	 * Stop this coordinator and invalidate what it issued. Expiring every delegation is the part that
	 * matters: `close()` runs when a transport is replaced (a component reload is enough), and a
	 * successor coordinator must not be able to grant a key whose predecessor handles are still live.
	 */
	close(): void {
		this.#closed = true;
		liveCoordinators.delete(this);
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
		for (const pending of this.#pendingDelegations.values()) pending.markRecalled();
		// Remote admissions (harper-pro#852) that were NOT handed to a successor: this thread is going
		// away, so fence their handles (fail closed) and tell the owner it may give the delegation up now
		// rather than hold it for a full lease waiting on a worker that has gone.
		if (this.#remoteAdmissions) {
			for (const remote of this.#remoteAdmissions.values()) {
				fireRevokeAndForget(remote.revoke);
				this.#settleFenceWaiters(remote);
				this.#releaseOnOwnerSafely(remote.key, remote.ownerAdmissionId);
			}
			this.#remoteAdmissions = undefined;
			this.#remoteByOwnerId = undefined;
		}
		// Any ack still waiting on an entry that never installed cannot be honored here; resolve it so the
		// owner's revoke wait does not hang on a thread that is gone (its own lease bounds it regardless).
		if (this.#pendingRemoteRevokes) {
			for (const entry of this.#pendingRemoteRevokes.values()) for (const resolve of entry.resolvers) resolve();
			this.#pendingRemoteRevokes = undefined;
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
		this.#pendingDelegations.clear();
		this.#pendingRequests.clear();
		this.#grants.clear();
		this.#grantsByRequester.clear();
		this.#dependencySets.clear();
		this.#everDelegated.clear();
		tickingCoordinators.delete(this);
	}

	/**
	 * Ownership as this thread can actually observe it. Only a LOSS is recorded: regaining it is the
	 * grant path's business, because that is where the incarnation is available to say whether anything
	 * else coordinated in between.
	 */
	#observeOwnership(): void {
		let owns: boolean;
		try {
			owns = this.transport.ownsCoordination();
		} catch {
			// A transport that cannot answer is not proof this thread kept coordinating, and the whole
			// point of the horizon is what happened while it did not.
			owns = false;
		}
		if (!owns) this.#ownedSinceMono = undefined;
	}

	/**
	 * The horizon owning coordination imposes, anchored at the instant this coordinator STARTED
	 * coordinating under the incarnation it is granting under — see `#ownedSinceMono`.
	 *
	 * `homeIncarnation` is the signal, not `ownsCoordination()`. Sampling a boolean proves the answer
	 * at the instant it is read and never that ownership was unbroken between two reads, so ownership
	 * alternating faster than the sample interval could alias away entirely. §5.1 makes the incarnation
	 * advance once per COORDINATION incarnation — that is what keeps the fencing token orderable — so a
	 * value this coordinator has not granted under is the transport stating that something else
	 * coordinated for this node, whatever the boolean said in between.
	 */
	#ownershipHorizon(now: number, homeIncarnation: number): number {
		if (this.#coordinatingIncarnation !== homeIncarnation || this.#ownedSinceMono === undefined) {
			this.#loseFreshnessHistory();
			// Ownership STARTED here, which is the one thing the waiver cannot cover.
			// `grantableAfterMono` attests that no previous INCARNATION OF THIS PROCESS had issued
			// delegations — a cold start, a fresh database, a test — and says nothing about the sibling
			// thread that was coordinating until this instant. The constructor records both directly, so
			// a coordinator that has coordinated since it was built never reaches this and keeps the
			// waiver; every other way of arriving at ownership lands here and loses it.
			this.#coordinatingIncarnation = homeIncarnation;
			this.#quarantineWaived = false;
			this.#ownedSinceMono = now;
		}
		if (this.#quarantineWaived) return -Infinity;
		return this.#ownedSinceMono + DELEGATION_LEASE_MS + this.#skewMs;
	}

	/** Fail closed on a generation older than one already ACTED on here (see `highestGeneration`). */
	#generationIsCurrent(generation: number): boolean {
		const highest = highestGeneration.get(this.database);
		return highest === undefined || generation >= highest;
	}

	/**
	 * Raise the floor, at the moment authority is actually taken under this generation — a token
	 * minted or a delegation installed — and never merely on reading a map.
	 *
	 * Observing was the obvious place and it is the wrong one: a single `homeMap()` that returns a
	 * too-large generation once, from a partial publish or a transport glitch, would pin the floor
	 * above anything the operator ever publishes and fail every later lock on this database until the
	 * thread restarts. Nothing was minted under that reading, so nothing needs protecting from it. The
	 * invariant only ever needed to be "never mint below a generation already minted".
	 */
	#recordGenerationActedOn(generation: number): void {
		const highest = highestGeneration.get(this.database);
		if (highest === undefined || generation > highest) highestGeneration.set(this.database, generation);
	}

	#prepareFreshnessGeneration(generation: number): void {
		if (this.#freshnessGeneration === undefined) {
			this.#freshnessGeneration = generation;
			return;
		}
		if (this.#freshnessGeneration === generation) return;
		this.#freshnessGeneration = generation;
		this.#loseFreshnessHistory();
	}

	#loseFreshnessHistory(): void {
		this.#dependencySets.clear();
		this.#everDelegated.clear();
		this.#trustVirginKeys = false;
	}

	#freshnessFor(keyId: unknown): LockDependencySet | null {
		const retained = this.#dependencySets.get(keyId);
		if (retained) {
			this.#dependencySets.delete(keyId);
			this.#dependencySets.set(keyId, retained);
			return retained;
		}
		return this.#trustVirginKeys && !this.#everDelegated.has(keyId) ? [] : null;
	}

	#rememberDependencies(keyId: unknown, dependencies: LockDependencySet): void {
		this.#dependencySets.delete(keyId);
		this.#dependencySets.set(keyId, dependencies);
		while (this.#dependencySets.size > MAX_DEPENDENCY_SETS_PER_TABLE)
			this.#dependencySets.delete(this.#dependencySets.keys().next().value);
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
	registerAdmission(admissionId: number, revoke: () => void | Promise<void>): void {
		const admission = this.#admissions.get(admissionId)?.admissions.get(admissionId);
		if (admission) {
			admission.revoke = revoke;
			return;
		}
		// A remote admission (harper-pro#852): the delegation lives on the owner, the handle here. A revoke
		// that already latched (it beat this registration) fences the handle now and releases the ack that
		// was waiting on the fence; otherwise store the revoker for a later recall.
		const remote = this.#remoteAdmissions?.get(admissionId);
		if (remote) {
			remote.revoke = revoke;
			if (remote.revoked) {
				// A revoke latched before this registration: fence now, then drop the entry and release the
				// ack that was waiting on the fence. `#dropRemoteAdmission` is what resolves that ack, so an
				// async revoker must settle FIRST — resolving it early would tell the owner this handle is
				// fenced while it still is not, and the owner would write the release over a live writer. A fence
				// that FAILS settles nothing: the entry is left for the lease sweep, which resolves the ack once
				// the handle is provably dead. The failure is warned about inside and has nobody here to go to,
				// so it is absorbed rather than left to Node's unhandled-rejection policy.
				const fenced = this.#fenceRemoteAdmission(admissionId, remote);
				if (isPromiseLike(fenced)) fenced.catch(() => {});
			}
			return;
		}
		// The admission was already revoked or collected between admit and register — the handle has no
		// authority to keep, so revoke it now (safely: a relay revoker collected in this window is async
		// and could reject on a dead port) rather than leaving it unfenced.
		fireRevokeAndForget(revoke);
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
		requestedAtMono: number,
		dependencies: LockDependencySet
	): Delegation | undefined {
		const expiresMono = requestedAtMono + leaseMs;
		if (expiresMono <= this.#monotonic()) return undefined;
		// The delegate side of taking authority under a generation: installing this makes it admit under
		// `token[0]`, so that is the floor a later map may not go below.
		this.#recordGenerationActedOn(token[0]);
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
			dependencies,
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

	async #establishFreshness(
		key: any,
		requirement: LockDependencySet | null,
		homes: readonly string[],
		deadlineMono: number,
		pending?: PendingDelegation
	): Promise<LockDependencySet> {
		if (pending?.recalled) throw PENDING_DELEGATION_RECALLED;
		if (requirement?.length === 0) return requirement;
		const remaining = deadlineMono - this.#monotonic();
		if (remaining <= 0) throw new Error('the lock wait elapsed before its freshness barrier started');
		const established = Promise.resolve().then(() =>
			this.transport.establishLockFreshness(this.database, this.table, key, requirement, remaining)
		);
		const timeout = delay(remaining);
		established.then(
			() => timeout.cancel(),
			() => timeout.cancel()
		);
		const alternatives: Promise<LockDependencySet | void>[] = [
			established,
			timeout.promise.then(() => {
				throw new Error('the lock wait elapsed before its freshness barrier completed');
			}),
		];
		if (pending)
			alternatives.push(
				pending.recalledPromise.then(() => {
					timeout.cancel();
					throw PENDING_DELEGATION_RECALLED;
				})
			);
		const result = await Promise.race(alternatives);
		if (requirement !== null) return requirement;
		const recovered = normalizeDependencies(result);
		if (!recovered) throw new Error('the recovery barrier returned no usable applied-position set');
		const allowedOrigins = new Set(homes);
		return recovered.filter(([origin]) => allowedOrigins.has(origin));
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
					return { granted: false, reason: 'timeout', retryAfterMs: 0 } as DelegationReply;
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
	#releaseUnclaimedGrant(key: any, token: FencingToken): Promise<void> | void {
		const keyId = this.#keyIdOf(key);
		const held = this.#delegations.get(keyId);
		// ANY live delegation for this key means this node is using it, and the tokens need not match.
		// A duplicate or delayed request from this node renews the home's grant IN PLACE (`#grant`'s
		// renewal branch mutates `existing.token`), so the home can hold a newer token than the one we
		// installed. Releasing that token would clear the grant still backing our own live delegation
		// and let the home hand the key to another node while we are inside it. Comparing tokens here
		// caught only the case where we installed this exact grant.
		if (held) return;
		return this.#writeControlSafely({ type: 'lockRelease', key, requester: this.nodeId, token, dependencies: null });
	}

	#grant(keyId: unknown, key: any, homeMap: LockHomeMap, leaseMs: number, requester: string): DelegationReply {
		const now = this.#monotonic();
		this.#prepareFreshnessGeneration(homeMap.generation);
		// Consulted unconditionally — it is what observes a gap in ownership, and the waiver it applies
		// to itself is the only part `grantableAfterMono` may switch off.
		const quarantine = Math.max(this.#grantableAfterMono, this.#ownershipHorizon(now, homeMap.homeIncarnation)) - now;
		// NOT `contended`: the quarantine runs for a full delegation lease, and `MAX_LOCK_TIMEOUT_MS` is
		// shorter than that, so retrying it would spend the caller's whole budget and then answer 423 —
		// "held by someone else" — for a key nobody holds.
		if (quarantine > 0) return { granted: false, reason: 'quarantine', retryAfterMs: Math.min(quarantine, 250) };
		const existing = this.#grants.get(keyId);
		if (existing) {
			// An expired grant is not a live one. Collecting it here rather than trusting `tick()` is
			// what keeps a table whose expiry budget is saturated from answering `contended` forever.
			if (existing.expiresMono <= now) this.#expireGrant(keyId, existing);
			else if (existing.recalling || existing.recallConfirmed)
				// A recall is in flight, or the delegate has already confirmed one. Renewing now — even for
				// the node being recalled — would mint a token its own release no longer matches, and the
				// contender would never get the key. `recallConfirmed` has to be here as well as in
				// `#beginRecall`: the delegate can confirm and re-ask before its release reaches the home,
				// and renewing then would leave a grant nothing will recall again and nothing can release.
				return { granted: false, reason: 'contended', retryAfterMs: 25 };
			else if (existing.delegate === requester) {
				// Renewal for the node that already holds it: extend rather than recall itself.
				this.#recordGenerationActedOn(homeMap.generation);
				existing.token = [homeMap.generation, homeMap.homeIncarnation, ++this.#counter];
				existing.renewed = true;
				existing.expiresMono = now + DELEGATION_LEASE_MS + this.#skewMs;
				return {
					granted: true,
					token: existing.token,
					leaseMs: DELEGATION_LEASE_MS,
					dependencies: existing.dependencies,
				};
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
		this.#recordGenerationActedOn(homeMap.generation);
		const token: FencingToken = [homeMap.generation, homeMap.homeIncarnation, ++this.#counter];
		const dependencies = this.#freshnessFor(keyId);
		this.#everDelegated.add(keyId);
		this.#grants.set(keyId, {
			key,
			delegate: requester,
			token,
			dependencies,
			// The home always outwaits the delegate by skew, so it cannot re-grant a key the previous
			// delegate still believes it holds. The delegation runs for its own fixed duration rather
			// than the caller's lock lease — a delegation sized to one lock leaves no room for the next
			// one, and every repeat lock would pay a round trip.
			expiresMono: now + DELEGATION_LEASE_MS + this.#skewMs,
		});
		this.#grantsByRequester.set(requester, perRequester + 1);
		this.#startTicking();
		return { granted: true, token, leaseMs: DELEGATION_LEASE_MS, dependencies };
	}

	#beginRecall(keyId: unknown, grant: HomeGrant): void {
		if (grant.recalling || grant.recallConfirmed) return;
		if (grant.recallRetryAfterMono !== undefined && this.#monotonic() < grant.recallRetryAfterMono) return;
		if (grant.delegate === this.nodeId) {
			// We are both home and delegate. Recall ourselves through the same path a peer would take,
			// and settle it the same way: a recall that did not apply must leave the grant recallable,
			// or `recalling` stays latched here for the rest of the delegation and no contender ever
			// prompts another one.
			grant.recalling = this.onDelegationRecall({ key: grant.key, token: grant.token }).then(
				() => {
					grant.recalling = undefined;
					grant.recallConfirmed = true;
				},
				(error) => {
					warnOnce('failed to recall a local record lock delegation', error);
					grant.recalling = undefined;
					grant.recallRetryAfterMono = this.#monotonic() + RECALL_RETRY_MS;
				}
			);
			return;
		}
		// `.then`, not `Promise.resolve(recallDelegation(...))`: the transport call is evaluated before
		// `Promise.resolve` and can throw synchronously, which escapes this whole method — so the
		// handlers below never run, the retry interval is never armed, and the next contender pass
		// throws again immediately instead of backing off.
		grant.recalling = Promise.resolve()
			.then(() =>
				this.transport.recallDelegation(grant.delegate, this.database, this.table, {
					key: grant.key,
					token: grant.token,
				})
			)
			.then(() => {
				// The delegate confirmed it stopped admitting, so re-sending buys nothing: the grant is
				// cleared by its release entry, or failing that by its own deadline. Re-arming here is what
				// let a contender polling at 25 ms fire a recall per pass for the rest of the delegation.
				grant.recalling = undefined;
				grant.recallConfirmed = true;
			})
			.catch(() => {
				// An unreachable delegate is not a reason to re-grant early: the grant's own deadline is
				// what makes the successor safe, and it already includes the skew margin. Retrying IS
				// worthwhile here — the delegate may come back — but on its own interval, not the
				// contender's.
				grant.recalling = undefined;
				grant.recallRetryAfterMono = this.#monotonic() + RECALL_RETRY_MS;
			});
	}

	/**
	 * Give up a delegation: stop admitting, then write the release that lets the home re-grant. One
	 * surrender per delegation, memoized: the home re-sends a recall `RECALL_RETRY_MS` after its own
	 * recall call failed, which is far inside a delegation lease, so two recalls for the same token can
	 * both be waiting on the drain and resume together. Without the memo the second finds the
	 * admissions the first already emptied, has no fence to wait for, and writes the release while the
	 * first is still waiting for a relayed handle to confirm it is fenced.
	 */
	#surrender(keyId: unknown, delegation: Delegation): Promise<void> {
		return (delegation.surrendering ??= this.#surrenderOnce(keyId, delegation));
	}

	async #surrenderOnce(keyId: unknown, delegation: Delegation): Promise<void> {
		if (this.#delegations.get(keyId) === delegation) this.#delegations.delete(keyId);
		// Capability, not just admission: anything this delegation admitted must be unable to commit
		// before the home is told it may re-grant. A handle admitted on another worker thread revokes
		// over a message, so wait for its fence to land — bounded by the handle's own lease, past which
		// it fences itself — before writing the release that lets the home re-grant the key.
		await this.#revokeAllAndSettle(delegation);
		const entry: LockReleaseEntry = {
			type: 'lockRelease',
			key: delegation.key,
			requester: this.nodeId,
			token: delegation.token,
			dependencies: delegation.dependencies,
		};
		return this.#writeControlSafely(entry);
	}

	/**
	 * Revoke every handle this delegation is answerable for and forget the admissions. Returns, per
	 * admission, the revoker's outcome paired with the admission's own monotonic deadline, so a caller
	 * that must not write the release before the fence is proven (`#surrender`) can bound its wait by
	 * that deadline. Callers tearing the delegation down anyway (`tick`, `close`) ignore the result. A
	 * revoke that throws synchronously is captured as a rejected outcome, never swallowed as fenced.
	 */
	#revokeAll(delegation: Delegation): { outcome: void | Promise<void>; expiresMono: number }[] {
		const admissions = delegation.admissions;
		delegation.admissions = new Map();
		delegation.holding = 0;
		delegation.sweepAtSize = ADMISSION_SWEEP_FLOOR;
		const outcomes: { outcome: void | Promise<void>; expiresMono: number }[] = [];
		for (const [admissionId, admission] of admissions) {
			this.#admissions.delete(admissionId);
			let outcome: void | Promise<void>;
			try {
				outcome = admission.revoke();
			} catch (error) {
				// A synchronous throw is NOT a fence: surface it as a rejected outcome so `#revokeAllAndSettle`
				// waits out the admission's own lease rather than releasing against a handle that may still commit.
				outcome = Promise.reject(error);
			}
			// Every fire-and-forget caller (`tick`, `close`) discards this array, so a rejecting outcome —
			// a sync throw above, or a relayed revoker whose promise rejects on a dead sibling port — must
			// carry its own no-op handler here or Node's default policy would exit the worker. The awaited
			// path (`#revokeAllAndSettle`) still sees the rejection: a settled promise may be awaited again.
			if (outcome && typeof (outcome as Promise<void>).then === 'function') (outcome as Promise<void>).catch(() => {});
			outcomes.push({ outcome, expiresMono: admission.expiresMono });
		}
		return outcomes;
	}

	/**
	 * `#revokeAll`, then wait for every asynchronous fence (a handle on another worker acking its
	 * `revokeLease`) before the caller writes the release. Each wait is bounded HERE by the admission's
	 * own remaining lease, independent of what the transport's revoker does: a revoker that rejects,
	 * throws, or never settles cannot make `#surrender` publish the release before the fenced handle's
	 * lease has elapsed — past which the handle fences itself and can no longer commit. The transport's
	 * own lease-bounded ack (harper-pro) is the fast path; this is the guarantee.
	 */
	async #revokeAllAndSettle(delegation: Delegation): Promise<void> {
		const outcomes = this.#revokeAll(delegation);
		// ONE shared lease timer for the whole settle, not one per admission: a recall of a delegation
		// holding thousands of relayed admissions would otherwise arm thousands of timers at exactly the
		// moment it is handing off. The shared deadline is the LATEST lease among them, which bounds every
		// handle in the set — waiting past a shorter lease only ever errs towards holding the release
		// longer, never towards writing it early.
		let latestExpiry = -Infinity;
		let anyAsync = false;
		for (const { outcome, expiresMono } of outcomes) {
			if (!isPromiseLike(outcome)) continue;
			anyAsync = true;
			if (expiresMono > latestExpiry) latestExpiry = expiresMono;
		}
		// A synchronous revoker has already fenced by the time it returns, so it contributes nothing to
		// wait on: only the promise-returning ones cost an entry here.
		if (!anyAsync) return;
		const leaseTimer = delay(Math.max(0, latestExpiry - this.#monotonic()));
		const waits: Promise<unknown>[] = [];
		for (const { outcome } of outcomes) {
			if (!isPromiseLike(outcome)) continue;
			// Race the fence ack against the shared lease deadline: whichever comes first, the handle can no
			// longer commit once we return. A rejected fence is not a confirmed one, so it falls through to
			// the same deadline rather than resolving early.
			waits.push(
				Promise.race([
					outcome.catch((error) => {
						warnOnce('a record lock handle did not confirm revocation; waiting out its lease', error);
						return leaseTimer.promise;
					}),
					leaseTimer.promise,
				])
			);
		}
		try {
			await Promise.all(waits);
		} finally {
			leaseTimer.cancel();
		}
	}

	#clearGrant(keyId: unknown, grant: HomeGrant): void {
		if (this.#grants.get(keyId) !== grant) return;
		this.#grants.delete(keyId);
		const count = (this.#grantsByRequester.get(grant.delegate) ?? 1) - 1;
		if (count > 0) this.#grantsByRequester.set(grant.delegate, count);
		else this.#grantsByRequester.delete(grant.delegate);
	}

	#expireGrant(keyId: unknown, grant: HomeGrant): void {
		if (this.#grants.get(keyId) !== grant) return;
		this.#dependencySets.delete(keyId);
		this.#clearGrant(keyId, grant);
	}

	async #writeControlSafely(entry: LockReleaseEntry): Promise<void> {
		try {
			const position = await this.#writeControl(entry);
			this.#authority().applyEntry(entry, this.nodeId, typeof position === 'number' ? position : undefined);
		} catch (error) {
			// A lost release costs the key its remaining lease on the home; it never costs exclusion.
			warnOnce('failed to write a record lock release entry', error);
			// A local home can discard its own failed handback safely; its successor will recover.
			try {
				const keyId = this.#keyIdOf(entry.key);
				const grant = this.#grants.get(keyId);
				if (grant?.delegate === this.nodeId && compareTokens(grant.token, entry.token) === 0)
					this.#expireGrant(keyId, grant);
			} catch {}
		}
	}

	#startTicking() {
		if (!this.#autoTick) return;
		tickingCoordinators.add(this);
		ensureTicking();
	}
}

/**
 * What ended an exhausted `acquire()`, for the 503 it throws. A `timeout` is not phrased as a home
 * answer: it is this node's own deadline, and an operator told "the home answered timeout" looks for
 * a fault on a node that was simply not waited for.
 */
function describeExhaustedWait(terminal: DelegationReply | undefined, hasCurrentMap: boolean): string {
	if (terminal)
		return terminal.reason === 'timeout'
			? "no reply from the key's home within the wait"
			: `the key's home answered ${terminal.reason ?? (terminal.granted ? 'grants that arrived too late to use' : 'nothing usable')}`;
	return hasCurrentMap
		? 'the record lock home map changed generation before the wait ended'
		: 'this node has no current record lock home map';
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
type ControlWriter = (entry: LockControlEntry) => Promise<number | void> | number | void;
type ControlWriterResolver = (database: string, table: string) => ControlWriter | undefined;
let controlWriterResolver: ControlWriterResolver | undefined;

/** Installed by Table.ts so a transport can push received entries in without importing Table. */
export function setLockCoordinatorResolver(
	resolve: CoordinatorResolver,
	resolveAdmitting: CoordinatorResolver = resolve,
	resolveControlWriter?: ControlWriterResolver
) {
	coordinatorResolver = resolve;
	admittingResolver = resolveAdmitting;
	controlWriterResolver = resolveControlWriter;
}

export interface QuiesceOutstanding {
	table: string;
	key: unknown;
	/** Present when this node was the HOME and the delegate did not confirm. */
	delegate?: string;
	reason: string;
}

export interface QuiesceResult {
	/**
	 * Whether this result is a PROOF of quiescence, or merely a report of what was swept.
	 *
	 * A sweep can only visit coordinators that exist on this thread, and they are built lazily — a
	 * table nothing has touched since a restart has none, so an empty `outstanding` would otherwise
	 * read as "nothing is live" when the previous incarnation's delegations are still running
	 * elsewhere. An orchestrator must require `complete && outstanding.length === 0`; anything else
	 * means fall back to the drain interval for this node.
	 */
	complete: boolean;
	/** Delegations this node held and gave up, so it can no longer admit under them. */
	surrendered: number;
	/** Grants this node issued whose delegate confirmed it stopped admitting. */
	recalled: number;
	/**
	 * What is still live, or unprovable. Empty means this node is provably quiesced for the database —
	 * and ONLY then, which is why a coordinator still inside its restart quarantine contributes an
	 * entry here rather than reporting a clean sweep it cannot back.
	 */
	outstanding: QuiesceOutstanding[];
}

/**
 * Stop this node admitting under the current generation for `database`, and say whether it is
 * provably done (harper-pro#856).
 *
 * A membership change otherwise has to wait out `DELEGATION_LEASE_MS + LOCK_LEASE_SKEW_MS` before the
 * next generation may activate, because authority already issued under the old one has to expire —
 * roughly six minutes during which the staged nodes serve no cluster locks at all. That interval is a
 * TIMER, chosen because you cannot recall what you cannot reach. In a planned transition every
 * participant is reachable, so the same guarantee can be *established* instead of waited out: this
 * drains both directions and reports what, if anything, is left.
 *
 * - **As a delegate** it surrenders every delegation it holds. This is the load-bearing half: a
 *   delegate is what admits, and `onDelegationRecall` is the existing path whose resolution means
 *   "nothing on this node can admit on that token" — live critical sections are drained, not cut.
 * - **As a home** it recalls every grant it issued, so delegates elsewhere stop too. Redundant when
 *   every node is quiescing at once, and the reason this still terminates when one is not.
 *
 * `outstanding` empty on every node in `homes(g) ∪ homes(g+1)` is the operator's evidence that the
 * next generation may be activated immediately. Anything left is a node to fall back to the timer for,
 * or to fence externally — this never claims a drain it did not get, and never throws for one grant.
 */
export async function quiesceDelegations(database: string, budgetMs: number): Promise<QuiesceResult> {
	const result: QuiesceResult = { complete: true, surrendered: 0, recalled: 0, outstanding: [] };
	const coordinators = [...liveCoordinators].filter((coordinator) => coordinator.database === database);
	// A DURATION, not an absolute deadline: the whole sweep gets this long, measured from here.
	const deadline = Date.now() + Math.max(0, budgetMs);
	const remaining = () => Math.max(0, deadline - Date.now());
	for (const coordinator of coordinators) {
		await coordinator.quiesce(result, remaining);
	}
	// A sweep proves quiescence only if it could have seen everything this NODE issued, not merely what
	// this coordinator holds. Two ways it could not have:
	//
	// - No coordinator exists for the database on this thread, so there is nothing to attest from.
	// - A coordinator has not owned coordination long enough for authority issued BEFORE it took over
	//   — by a previous owner thread, or a previous incarnation of this process — to have expired.
	//   Those grants live on delegate nodes and no local sweep can see them; the same fact is what
	//   core's own grant gate refuses on, and it is why uptime is not the right measure (a worker that
	//   built empty coordinators early and took ownership late has plenty of uptime and no proof).
	if (coordinators.length === 0) {
		result.outstanding.push({
			table: '*',
			key: undefined,
			reason:
				'no lock coordinator exists for this database on this thread, so there is nothing to prove quiescence from',
		});
	}
	for (const coordinator of coordinators) {
		const unproven = coordinator.unprovenOwnershipMs();
		if (unproven > 0)
			result.outstanding.push({
				table: coordinator.table,
				key: undefined,
				reason: `this thread has not coordinated ${database}.${coordinator.table} long enough to rule out authority issued before it took over; ${Math.ceil(unproven)}ms remain`,
			});
	}
	// A coordinator that closed parked the latest deadline of the grants it had issued to OTHER nodes
	// here and then cleared its own table (`close`). Those grants are still valid on their delegates and
	// no live coordinator holds them, so a sweep that ignored this would miss them entirely — the table
	// may not even have a coordinator any more.
	//
	// `performance.now()` because a retired entry outlives the coordinator whose injected clock produced
	// its deadline: production passes that same clock (the transport's `monotonicNow`), so the domains
	// agree where it matters, and a test on an artificial clock only ever reads the deadline as further
	// away — conservative, never a false clean.
	const now = performance.now();
	for (const [key, retired] of retiredCoordinators) {
		const separator = key.indexOf('\u0000');
		if (separator < 0 || key.slice(0, separator) !== database) continue;
		if (!(retired.grantableAfterMono > now)) continue;
		result.outstanding.push({
			table: key.slice(separator + 1),
			key: undefined,
			reason: `a closed coordinator for this table issued grants that remain valid on their delegates for another ${Math.ceil(retired.grantableAfterMono - now)}ms`,
		});
	}
	if (result.outstanding.length > 0) result.complete = false;
	return result;
}

/**
 * Commit a `lockBarrier` entry for the table and resolve to its transaction-log position — the §7.2
 * recovery fence, for a transport answering a peer's recovery probe. The entry is appended after
 * every transaction this node had committed when the call was made, so a peer that has applied this
 * origin's log through the returned position has applied all of them.
 *
 * The transport supplies the nonce it will match the entry on, since a position alone is not an
 * identity: a restart after the wall clock moved backwards can reissue a log key, and a drain that
 * matched the earlier entry at that key would declare this origin drained with its post-restart
 * commits unapplied.
 *
 * Strictly this node's own commit, never the transport's `writeControl`: the fence is a position in
 * THIS origin's log, and the caller is the transport itself — a relaying hook would answer with a
 * position that is not local, or re-enter the operation that called here. A write that commits
 * without a position rejects rather than resolve, since a barrier nobody can wait on is not a fence.
 */
export async function writeLockBarrier(database: string, table: string, nonce: number): Promise<number> {
	if (!Number.isSafeInteger(nonce) || nonce < 0)
		throw new ClientError('A lock barrier nonce must be a non-negative integer');
	const write = controlWriterResolver?.(database, table);
	if (!write) throw new ClientError(`Table ${database}.${table} does not exist`, 404);
	const position = await write({ type: 'lockBarrier', nonce });
	if (typeof position !== 'number' || !(position >= 0) || !Number.isFinite(position))
		throw new LockUnavailableError(`the record lock barrier for ${database}.${table} committed without a log position`);
	return position;
}

/**
 * Register harper-pro's transport for a database, on THIS thread.
 *
 * **It must be registered on every worker that can serve a `lock()`, not only the coordinating one**
 * — including a dedicated application worker (harper#2524) — and core cannot check that. `clusterRequiredDatabases` is module state, so a worker that never registers never latches —
 * and a default-scoped `lock()` there takes the Phase 0 node lock alone while a peer runs the cluster
 * protocol, which is two nodes admitting one key. The `ownsCoordination()` fail-closed path only
 * reaches a worker that has a transport. Registering everywhere also makes that path the one a
 * non-owner worker takes, which is what it exists for.
 */
export function registerClusterLockTransport(database: string, transport: ClusterLockTransport): void {
	if (
		typeof transport?.homeMap !== 'function' ||
		typeof transport?.ownsCoordination !== 'function' ||
		typeof transport?.requestDelegation !== 'function' ||
		typeof transport?.recallDelegation !== 'function' ||
		typeof transport?.establishLockFreshness !== 'function'
	)
		throw new ClientError(
			'A cluster lock transport must provide homeMap(), ownsCoordination(), requestDelegation(), recallDelegation() and establishLockFreshness()'
		);
	transport.onControlEntry = (db: string, table: string, entry: LockControlEntry, author: string, position: number) =>
		deliverLockControlEntry(db, table, entry, author, position);
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
	author: string,
	position: number
): void {
	coordinatorFor(database, table, admittingResolver)?.applyEntry(entry, author, position);
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
	// This is core's receiving end of `recallDelegation`, which resolves only "once the delegate has
	// drained and stopped admitting" — and `#beginRecall` latches `recallConfirmed` on that resolution
	// and never re-sends. So a recall this thread could not apply has to FAIL rather than resolve:
	// `coordinatorFor` is the transport-gated resolver and answers undefined through a reconnect, and
	// the home reading that silence as a drained delegate denies the key to every other node for the
	// delegation's whole deadline. Failing it leaves the home's `.catch` to retry on RECALL_RETRY_MS.
	const coordinator = coordinatorFor(database, table);
	if (!coordinator)
		throw new Error(`No record lock coordinator on this thread to apply a recall for ${database}.${table}`);
	await coordinator.onDelegationRecall(recall);
}

// ---- owner-worker relay (harper-pro#852) -------------------------------------------------------

/**
 * The owner thread's end of `acquireOnOwner`: mint an admission for a `lock()` served on another
 * worker thread, and register `revoke` as the way to fence that thread's handle. `revoke` is what the
 * transport wires to a cross-thread message; a recall or surrender here calls it and waits for the
 * fence before writing the release. Runs on the coordinating thread, resolved through the transport-
 * gated resolver so it fails when this thread does not coordinate the database — the same shape as
 * `deliverDelegationRequest`. Returns the round the calling worker installs as a remote admission.
 */
export async function acquireForRelay(
	database: string,
	table: string,
	key: any,
	leaseMs: number,
	waitMs: number,
	makeRevoke: (round: LockRound) => () => void | Promise<void>
): Promise<LockRound> {
	const coordinator = coordinatorFor(database, table);
	if (!coordinator)
		throw new Error(`No record lock coordinator on this thread to acquire ${database}.${table} for a peer worker`);
	const round = await coordinator.acquire(key, leaseMs, waitMs);
	// Re-resolve through the ADMITTING resolver rather than reusing the captured coordinator: a transport
	// swap during the acquire moves the admission to the successor and empties the predecessor, so
	// registering on the captured object would eagerly revoke a healthy handle and leave the successor's
	// admission unfenceable. `Table.ts` does the same via `admittingCoordinator`. The revoker is built
	// from the round so it names the exact admission when it tells the calling worker to fence its handle.
	const authority = coordinatorFor(database, table, admittingResolver) ?? coordinator;
	authority.registerAdmission(round.admissionId, makeRevoke(round));
	return round;
}

/** The owner thread's end of `releaseOnOwner`: end a relayed admission the owner minted. */
export function releaseForRelay(database: string, table: string, key: any, admissionId: number): Promise<void> | void {
	// The admitting resolver, like a received release: it answers the coordinator that HOLDS the
	// admission even while a transport is momentarily unregistered, so a release is never dropped.
	return coordinatorFor(database, table, admittingResolver)?.release(key, admissionId);
}

/**
 * The calling thread's end of an owner `revoke`: fence the handle for a relayed admission this thread
 * holds. Resolves once the handle's `revokeLease` has run, so the owner may wait for the fence before
 * it writes the release. The admitting resolver answers the coordinator that adopted the admission
 * across a transport swap.
 */
export function revokeRelayedAdmission(database: string, table: string, admissionId: number): Promise<void> {
	const coordinator = coordinatorFor(database, table, admittingResolver);
	// No coordinator to fence against means nothing here can commit under that admission; the fence is
	// vacuously satisfied and the owner may proceed.
	return coordinator ? coordinator.revokeRemoteAdmission(admissionId) : Promise.resolve();
}

/**
 * Fail-closed fence for every relayed handle a table's coordinator holds (harper-pro#852), for when
 * the owner worker that granted them has exited and its delegations are gone. Harper-pro calls this
 * per table when it learns the coordinating thread for a database changed.
 */
export function fenceRelayedAdmissions(database: string, table: string): void {
	coordinatorFor(database, table, admittingResolver)?.fenceAllRemoteAdmissions();
}
