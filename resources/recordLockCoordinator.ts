import { performance } from 'node:perf_hooks';
import { Packr } from 'msgpackr';
import harperLogger from '../utility/logging/harper_logger.ts';
import { ClientError, LockUnavailableError } from '../utility/errors/hdbError.ts';
import { MAX_LOCK_LEASE_MS, MAX_LOCK_TIMEOUT_MS, MIN_LOCK_LEASE_MS } from './recordLock.ts';

/**
 * Cluster-wide record locks (harper#483, Phase 1): Ricart-Agrawala over replicated control entries.
 *
 * `Table.lock()` acquires the node's rocksdb-js key lock first, which bounds this process to one
 * outstanding request per key; only then does it run the round here. A requester writes
 * `LOCK_REQUEST` and waits for a `LOCK_GRANT` from every participant. A participant defers while it
 * holds the key, or while its own pending request is earlier by `(tsR, nodeId)`; deferred grants are
 * written in that order when it releases or withdraws.
 *
 * Two properties carry the safety argument, and both are enforced rather than assumed:
 *
 * - A holder's lease runs from `tsR` with no margin while every participant bounds the same hold at
 *   its own observation plus `max(leaseMs, waitMs) + LOCK_LEASE_SKEW_MS`, so the holder's writes are
 *   rejected before any participant grants the key onward. Expiry is measured on each node's own
 *   monotonic clock; no remote timestamp is ever compared against a local one.
 * - A round that completes after `tsR + leaseMs` yields no hold at all (423). Without that, a
 *   requester acquiring late and a participant that had already synthesized its grant would both
 *   consider the key held.
 *
 * `nodeId` here is the globally stable node NAME. It is deliberately not the audit entry's `nodeId`:
 * `nodeIdMapping.ts` hands out per-node short ids (0 is always local), so the same node has different
 * ids on different nodes and a `(ts, nodeId)` total order built on them would order the same pair of
 * requests differently on two nodes — and both would grant.
 */

/** Margin every participant adds to a hold it did not take, so the holder always expires first. */
export const LOCK_LEASE_SKEW_MS = 5_000;
const TICK_INTERVAL_MS = 100;
const OFF_OWNER_WARN_INTERVAL_MS = 60_000;
/** Bounds the state one contended key, and one database, can accumulate from replicated entries. */
const MAX_PEER_REQUESTS_PER_KEY = 64;
const MAX_KEYS_IN_FLIGHT = 10_000;
const MAX_NODE_NAME_LENGTH = 255;
/** A node whose identity resolved to one of these is not distinctive enough to order requests by. */
const NON_DISTINCTIVE_NODE_NAMES = new Set(['127.0.0.1', '::1', 'localhost', '0.0.0.0']);

export type LockControlType = 'lockRequest' | 'lockGrant' | 'lockRelease';

export interface LockParticipant {
	/** The node's globally stable name. NOT the per-node audit short id. */
	nodeId: string;
	/** False when the node does not implement record locks; any false member fails the round closed. */
	capable: boolean;
	/** When the node went DOWN in the cluster truth, or null/undefined while it is up. */
	downSince?: number | null;
}

export interface LockControlEntry {
	type: LockControlType;
	/** The locked record's id. Control entries carry it here, never as the audit entry's recordId. */
	key: any;
	/** Node that opened the round; with `tsR` this is the entry's identity. */
	requester: string;
	tsR: number;
	/** `lockGrant` only: the node issuing the grant. */
	grantor?: string;
	/** `lockRequest` only. */
	leaseMs?: number;
	waitMs?: number;
}

/**
 * Supplied by harper-pro. Core never computes cluster topology; it only refuses to promise a
 * cluster-wide lock that this contract cannot back.
 */
export interface ClusterLockTransport {
	/**
	 * The COMPLETE desired peer set for the database, each with its capability — never a pre-filtered
	 * intersection, which could not distinguish "not a participant" from "peer cannot participate".
	 */
	participants(database: string): LockParticipant[];
	/**
	 * Whether this worker thread owns lock coordination for the process. Coordinator state is
	 * per-thread while the key lock it arbitrates is process-wide, so a second thread running its own
	 * rounds would arbitrate against a different view. Core fails closed off the owner thread.
	 */
	ownsCoordination(): boolean;
	/** Emit a control entry. Optional: core writes it to the table's transaction log when omitted. */
	writeControl?(table: string, entry: LockControlEntry): Promise<void> | void;
	/**
	 * Assigned at registration so a transport can push a received entry in directly. `author` is the
	 * node the entry was written by, established by the transport, not read from the payload.
	 */
	onControlEntry?(database: string, table: string, entry: LockControlEntry, author: string): void;
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
	const packed =
		entry.type === 'lockRequest'
			? controlPackr.pack([entry.key, entry.requester, entry.tsR, entry.leaseMs, entry.waitMs])
			: entry.type === 'lockGrant'
				? controlPackr.pack([entry.key, entry.requester, entry.tsR, entry.grantor])
				: controlPackr.pack([entry.key, entry.requester, entry.tsR]);
	// A record key is an ordered-binary value, never a plain object, so nothing here can mint a
	// structure. If that ever stops holding, the receiver's decoder has no way to resolve the id.
	if (controlStructures.length > 0) {
		// Replace the packer, don't just truncate its array: msgpackr keeps its own shape-to-id state,
		// and a reused id with an empty dictionary would ship a payload referencing a structure no
		// receiver can resolve — silently dropped everywhere instead of throwing here. Recovering at
		// all matters because a dirty dictionary would otherwise make every later grant write throw
		// into a latched warning, and this node would stop granting to the whole cluster.
		controlStructures = [];
		controlPackr = new Packr({ structures: controlStructures });
		throw new ClientError('Record lock control payload minted a structure');
	}
	return packed;
}

function isNodeName(value: unknown): value is string {
	return typeof value === 'string' && value.length > 0 && value.length <= MAX_NODE_NAME_LENGTH;
}

function isDuration(value: unknown, min: number, max: number): value is number {
	return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
}

/**
 * A record id shape ordered-binary can encode. Anything else — a plain object, a Date — throws out
 * of `keyIdOf`, and that throw would reach the replicated apply loop.
 */
function isEncodableKey(value: unknown): boolean {
	if (Array.isArray(value)) return value.every((element) => isEncodableKey(element));
	if (value instanceof Uint8Array) return true;
	const type = typeof value;
	return value === null || type === 'string' || type === 'number' || type === 'bigint' || type === 'boolean';
}

/**
 * Decode a replicated control payload, returning undefined for anything that is not exactly the
 * shape this protocol writes. Peer input reaches the state machine through here, so every field is
 * checked before it can create a map entry, a timer bound, or a grant.
 */
export function decodeLockControlPayload(type: unknown, value: unknown): LockControlEntry | undefined {
	if (!Array.isArray(value)) return undefined;
	const [key, requester, tsR] = value;
	if (!isEncodableKey(key) || !isNodeName(requester)) return undefined;
	if (typeof tsR !== 'number' || !Number.isFinite(tsR) || tsR <= 0) return undefined;
	if (type === 'lockRequest') {
		if (value.length !== 5) return undefined;
		const [, , , leaseMs, waitMs] = value;
		if (!isDuration(leaseMs, MIN_LOCK_LEASE_MS, MAX_LOCK_LEASE_MS)) return undefined;
		if (!isDuration(waitMs, 1, MAX_LOCK_TIMEOUT_MS)) return undefined;
		return { type, key, requester, tsR, leaseMs, waitMs };
	}
	if (type === 'lockGrant') {
		if (value.length !== 4) return undefined;
		const grantor = value[3];
		if (!isNodeName(grantor)) return undefined;
		return { type, key, requester, tsR, grantor };
	}
	if (type === 'lockRelease') {
		if (value.length !== 3) return undefined;
		return { type, key, requester, tsR };
	}
	return undefined;
}

/** Total order across the cluster: earlier timestamp wins, node name breaks the tie. */
function isEarlier(tsA: number, nodeA: string, tsB: number, nodeB: string): boolean {
	if (tsA !== tsB) return tsA < tsB;
	return nodeA < nodeB;
}

function identityOf(requester: string, tsR: number): string {
	// A separator no node name can contain, written as an escape: a literal NUL in the source makes
	// git treat this file as binary and hides it from every text tool.
	return `${requester}\u0000${tsR}`;
}

interface OwnRound {
	tsR: number;
	/** `monotonic()` at the instant `tsR` was minted; every lease bound is measured from it. */
	mintedMono: number;
	leaseMs: number;
	waitMs: number;
	/** Participants whose grant is still outstanding. */
	pending: Set<string>;
	acquired: boolean;
	/** The LOCK_REQUEST write has landed, so a withdraw on the wire can correlate to it. */
	requestSettled: boolean;
	/** The round ended before its request settled; the withdraw is owed once it does. */
	withdrawOwed: boolean;
	/** The acquire() promise has been settled. */
	resolved: boolean;
	/** The round is over: released, withdrawn or abandoned. */
	done: boolean;
	/** Monotonic bound: the wait deadline before acquisition, the hold deadline after. */
	deadlineMono: number;
	resolve: (round: LockRound) => void;
	reject: (error: Error) => void;
}

/** What a completed round hands back: the identity to stamp with, and the clock to measure from. */
export interface LockRound {
	tsR: number;
	mintedMono: number;
}

interface PeerRound {
	requester: string;
	tsR: number;
	/** Monotonic instant after which this peer can neither hold nor newly acquire the key. */
	expiresMono: number;
	released: boolean;
}

class KeyState {
	key: any;
	own: OwnRound | undefined;
	peers = new Map<string, PeerRound>();
	/** Identities we owe a grant to, kept in `(tsR, nodeId)` order. */
	deferredOrder: string[] = [];
	/** Peer rounds not yet released. Maintained so the overflow sweep stays a flat scan. */
	livePeers = 0;
	constructor(key: any) {
		this.key = key;
	}
	get idle(): boolean {
		return !this.own && this.peers.size === 0 && this.deferredOrder.length === 0;
	}
	/** Nothing here can still act; what remains is kept only so a replay cannot resurrect it. */
	get releasedOnly(): boolean {
		return !this.own && this.livePeers === 0 && this.deferredOrder.length === 0;
	}
	addPeer(identity: string, peer: PeerRound) {
		this.peers.set(identity, peer);
		this.livePeers++;
	}
	releasePeer(peer: PeerRound) {
		if (peer.released) return;
		peer.released = true;
		this.livePeers--;
	}
	deletePeer(identity: string, peer: PeerRound) {
		this.peers.delete(identity);
		if (!peer.released) this.livePeers--;
	}
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
	/** Mints `ts_R`; core passes the primary store's monotonic timestamp. */
	nextTimestamp: () => number;
	/** Wall clock. Used only where both operands are cluster-wide timestamps. */
	now?: () => number;
	/** Monotonic clock. Every expiry decision is made on this. */
	monotonic?: () => number;
	skewMs?: number;
	/** False in tests, which drive `tick()` themselves. */
	autoTick?: boolean;
}

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

const warnedMessages = new Set<string>();
function warnOnce(message: string, detail?: unknown) {
	if (warnedMessages.has(message)) return;
	warnedMessages.add(message);
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
	#now: () => number;
	#monotonic: () => number;
	#skewMs: number;
	#autoTick: boolean;
	#states = new Map<unknown, KeyState>();
	// A latched warning would make a permanently misrouted deployment look like a quiet cluster.
	#droppedOffOwner = 0;
	#lastOffOwnerWarn = 0;
	#knownParticipants: Set<string> | undefined;
	#knownParticipantsAt = 0;
	// Bumped only where liveness is REMOVED — a released round, a dropped one, a cleared own round, a
	// shrinking deferred queue. Those are the only transitions that can make a key state released-only,
	// so a futile reclamation scan can tell "nothing reclaimable has appeared" in O(1). Bumping on
	// arrivals too would let a request on an existing key re-arm the scan for the next overflow, which
	// is the amplification this exists to prevent.
	#mutations = 0;
	#lastFutileScan = -1;

	constructor(options: LockCoordinatorOptions) {
		if (!isNodeName(options.nodeId) || NON_DISTINCTIVE_NODE_NAMES.has(options.nodeId))
			throw new LockUnavailableError(
				`Cluster record locks need a distinctive node name to order requests by, but this node identifies as "${options.nodeId}". Set node.hostname to this node's name in system.hdb_nodes.`
			);
		this.database = options.database;
		this.table = options.table;
		this.nodeId = options.nodeId;
		this.transport = options.transport;
		this.#writeControl = options.writeControl;
		this.#keyIdOf = options.keyIdOf;
		this.#nextTimestamp = options.nextTimestamp;
		this.#now = options.now ?? Date.now;
		this.#monotonic = options.monotonic ?? (() => performance.now());
		this.#skewMs = options.skewMs ?? LOCK_LEASE_SKEW_MS;
		this.#autoTick = options.autoTick !== false;
	}

	/** Held holds, outstanding requests, owed grants and misrouted entries, for `cluster_status`. */
	get stats(): { held: number; pending: number; deferred: number; droppedOffOwner: number } {
		let held = 0;
		let pending = 0;
		let deferred = 0;
		for (const state of this.#states.values()) {
			if (state.own?.acquired) held++;
			else if (state.own) pending++;
			deferred += state.deferredOrder.length;
		}
		return { held, pending, deferred, droppedOffOwner: this.#droppedOffOwner };
	}

	/**
	 * Run the cluster round for a key whose native lock this thread already holds. Resolves with
	 * `ts_R`, which becomes the holder's stamp; rejects 423 on timeout (having written the withdraw)
	 * or 503 when the guarantee cannot be established.
	 */
	acquire(key: any, leaseMs: number, waitMs: number): Promise<LockRound> {
		const keyId = this.#keyIdOf(key);
		let grantSet: string[];
		try {
			if (!this.transport.ownsCoordination())
				throw new LockUnavailableError(
					'Cluster record lock coordination is not owned by this worker thread; retry so the request reaches the coordinating thread'
				);
			if (this.#states.size >= MAX_KEYS_IN_FLIGHT && !this.#states.has(keyId)) {
				this.#evictReleasedOnlyKeys();
				if (this.#states.size >= MAX_KEYS_IN_FLIGHT)
					throw new LockUnavailableError(`Too many record lock rounds in flight on ${this.database}.${this.table}`);
			}
			grantSet = this.#grantSet();
		} catch (error) {
			return Promise.reject(error);
		}
		const state = this.#stateFor(keyId, key);
		if (state.own && !state.own.done)
			// The native key lock is process-wide, so a second concurrent round on one key means the
			// caller reached here without holding it.
			return Promise.reject(
				new LockUnavailableError(`A cluster record lock round is already in flight for this key on ${this.table}`)
			);
		const tsR = this.#nextTimestamp();
		const mintedMono = this.#monotonic();
		let resolve!: (value: LockRound) => void;
		let reject!: (error: Error) => void;
		const acquisition = new Promise<LockRound>((res, rej) => {
			resolve = res;
			reject = rej;
		});
		const own: OwnRound = {
			tsR,
			mintedMono,
			leaseMs,
			waitMs,
			pending: new Set(grantSet),
			acquired: false,
			requestSettled: false,
			withdrawOwed: false,
			resolved: false,
			done: false,
			deadlineMono: mintedMono + waitMs,
			resolve,
			reject,
		};
		state.own = own;
		this.#startTicking();
		// Await the request before resolving on grants: a request that never became durable is one no
		// peer will ever answer, and leaving it pending would burn the caller's whole timeout.
		let written: Promise<void> | void;
		try {
			written = this.#writeControl({ type: 'lockRequest', key, requester: this.nodeId, tsR, leaseMs, waitMs });
		} catch (error) {
			this.#abandon(state, keyId, own, error as Error);
			return acquisition;
		}
		Promise.resolve(written).then(
			() => {
				own.requestSettled = true;
				// The wait deadline can fire while this write is still in flight. The withdraw could not
				// be written then — peers would apply it before the request it withdraws and install a
				// round nothing ever retracts — so it was deferred to here.
				if (own.withdrawOwed) {
					own.withdrawOwed = false;
					this.#writeControlSafely({ type: 'lockRelease', key, requester: this.nodeId, tsR });
					return;
				}
				if (own.done || own.resolved) return;
				if (own.pending.size === 0) this.#complete(state, keyId, own);
			},
			(error) => this.#abandon(state, keyId, own, error)
		);
		return acquisition;
	}

	/**
	 * Release this node's hold or outstanding request for a key. Returns the durable release write so
	 * the caller can contain its failure; peers expire the hold on their own bound regardless.
	 */
	release(key: any): Promise<void> | void {
		const keyId = this.#keyIdOf(key);
		const state = this.#states.get(keyId);
		const own = state?.own;
		if (!state || !own || own.done) return undefined;
		return this.#finish(state, keyId, own);
	}

	/**
	 * Apply a control entry from a peer (or a replayed one). Idempotent by `(requester, tsR)`.
	 *
	 * `author` is the node the entry was actually written by, taken from the audit header rather than
	 * the payload. Without it a participant could write a grant naming any other node as the grantor
	 * and complete a requester's round while the real holder was still holding.
	 */
	applyEntry(entry: LockControlEntry, author: string): void {
		// The only boundary peer input crosses into this state machine. A throw here would reach the
		// replicated apply loop and drop the whole enclosing transaction, so one malformed entry could
		// cost a table every control entry that follows it.
		try {
			this.#applyEntry(entry, author);
		} catch (error) {
			warnOnce('a cluster record lock control entry could not be applied', error);
		}
	}

	#applyEntry(entry: LockControlEntry, author: string): void {
		if (!this.transport.ownsCoordination()) {
			this.#droppedOffOwner++;
			const now = this.#now();
			if (now - this.#lastOffOwnerWarn > OFF_OWNER_WARN_INTERVAL_MS) {
				this.#lastOffOwnerWarn = now;
				harperLogger.warn?.(
					`${this.#droppedOffOwner} cluster record lock control entries have been dropped on a worker that does not own lock coordination for ${this.database}; the transport must deliver them to the coordinating worker`
				);
			}
			return;
		}
		const claimed = entry.type === 'lockGrant' ? entry.grantor : entry.requester;
		if (claimed !== author) {
			warnOnce('dropping a record lock control entry whose payload identity is not the node that wrote it');
			return;
		}
		this.tick();
		switch (entry.type) {
			case 'lockRequest':
				this.#applyRequest(entry);
				return;
			case 'lockGrant':
				this.#applyGrant(entry);
				return;
			case 'lockRelease':
				this.#applyRelease(entry);
		}
	}

	/** Advance every deadline. Driven by the shared interval in production, by tests directly. */
	tick(): void {
		const mono = this.#monotonic();
		for (const [keyId, state] of this.#states) {
			for (const [identity, peer] of state.peers) {
				if (peer.expiresMono > mono) continue;
				state.deletePeer(identity, peer);
				this.#mutations++;
				this.#removeDeferred(state, identity);
				// Synthesizing the missing grant is what lets a waiter proceed past a holder that crashed
				// without writing its release — so it must mean exactly that, and nothing else. A peer that
				// released cleanly is alive and will answer normally, and a peer with another round still
				// live may be holding the key right now: treating either as a grant admits a second holder.
				const own = state.own;
				if (peer.released || own === undefined || own.done || own.acquired) continue;
				if (this.#hasLiveRound(state, peer.requester)) continue;
				if (own.pending.delete(peer.requester) && own.pending.size === 0) this.#complete(state, keyId, own);
			}
			const own = state.own;
			// The holder's own handle timer normally releases first; this is the backstop that keeps a
			// deferred queue from being stranded if it did not.
			if (own && !own.done && own.deadlineMono <= mono) this.#finish(state, keyId, own);
			this.#gc(keyId, state);
		}
		if (this.#states.size === 0) tickingCoordinators.delete(this);
	}

	/** Drop all state, e.g. when the table is dropped. Outstanding waiters are rejected. */
	close(): void {
		for (const state of this.#states.values()) {
			const own = state.own;
			if (own && !own.resolved) {
				own.resolved = true;
				own.done = true;
				own.reject(new LockUnavailableError('Record lock coordination stopped'));
			}
		}
		this.#states.clear();
		tickingCoordinators.delete(this);
	}

	#startTicking() {
		if (!this.#autoTick) return;
		tickingCoordinators.add(this);
		ensureTicking();
	}

	/**
	 * Drop keys whose only remaining state is released rounds. They are kept so a replayed request
	 * cannot resurrect them, which must not cost a live key its slot — the same reason released rounds
	 * do not consume the per-key contention budget.
	 *
	 * Reached from the overflow path, so two things keep it off the apply thread's budget: the per-key
	 * test is O(1) (`livePeers` is maintained as rounds arrive and are released), and a scan that found
	 * nothing is not repeated until some state has actually changed. A saturated table under a flood of
	 * requests therefore scans once, not once per request, because a dropped request changes nothing.
	 *
	 * Throttling on a clock instead would be the wrong trade: it would skip a reclamation that had just
	 * become possible and drop a one-shot request that had room waiting for it.
	 */
	#evictReleasedOnlyKeys() {
		if (this.#mutations === this.#lastFutileScan) return;
		let reclaimed = false;
		for (const [keyId, state] of this.#states)
			if (state.releasedOnly) {
				this.#states.delete(keyId);
				reclaimed = true;
			}
		if (!reclaimed) this.#lastFutileScan = this.#mutations;
	}

	#hasLiveRound(state: KeyState, requester: string): boolean {
		for (const peer of state.peers.values()) if (peer.requester === requester && !peer.released) return true;
		return false;
	}

	#stateFor(keyId: unknown, key: any): KeyState {
		let state = this.#states.get(keyId);
		if (!state) this.#states.set(keyId, (state = new KeyState(key)));
		return state;
	}

	#gc(keyId: unknown, state: KeyState) {
		if (state.idle) this.#states.delete(keyId);
	}

	// Membership for arriving entries is re-read at most once per tick window. The grant set an
	// acquire depends on is never cached — that one is the safety decision and is taken fresh.
	#isKnownParticipant(nodeId: string): boolean {
		const now = this.#monotonic();
		if (!this.#knownParticipants || now - this.#knownParticipantsAt >= TICK_INTERVAL_MS) {
			const names = new Set<string>();
			try {
				const participants = this.transport.participants(this.database);
				if (Array.isArray(participants))
					for (const participant of participants) if (isNodeName(participant?.nodeId)) names.add(participant.nodeId);
			} catch {
				// An unavailable participant set means nothing is known to be a participant.
			}
			this.#knownParticipants = names;
			this.#knownParticipantsAt = now;
		}
		return this.#knownParticipants.has(nodeId);
	}

	#grantSet(): string[] {
		let participants: LockParticipant[];
		try {
			participants = this.transport.participants(this.database);
		} catch (error) {
			throw new LockUnavailableError(
				`The record lock participant set for ${this.database} could not be determined: ${(error as Error)?.message}`
			);
		}
		if (!Array.isArray(participants) || participants.length === 0)
			throw new LockUnavailableError(`The record lock participant set for ${this.database} is unknown`);
		const now = this.#now();
		const downCutoff = MAX_LOCK_LEASE_MS + this.#skewMs;
		const grantSet: string[] = [];
		const seen = new Set<string>();
		for (const participant of participants) {
			if (!isNodeName(participant?.nodeId))
				throw new LockUnavailableError(`The record lock participant set for ${this.database} names an invalid node`);
			// A repeated name means two nodes share an identity, which breaks the total order the whole
			// protocol rests on.
			if (seen.has(participant.nodeId))
				throw new LockUnavailableError(
					`Two nodes replicating ${this.database} both identify as ${participant.nodeId}; record locks cannot order their requests`
				);
			seen.add(participant.nodeId);
			if (participant.nodeId === this.nodeId) continue;
			if (participant.capable !== true)
				throw new LockUnavailableError(
					`Node ${participant.nodeId} replicates ${this.database} but does not support record locks; use { scope: 'node' } to lock only on this node`
				);
			// Excluded only once every hold or request it could have had has certainly expired.
			const downSince = participant.downSince;
			if (typeof downSince === 'number' && now - downSince > downCutoff) continue;
			grantSet.push(participant.nodeId);
		}
		return grantSet;
	}

	#writeControlSafely(entry: LockControlEntry): Promise<void> | void {
		const failed = (error: unknown) =>
			warnOnce(`a record lock ${entry.type} could not be written; peers will expire the hold`, error);
		try {
			const result = this.#writeControl(entry);
			if (result && typeof result.then === 'function') return result.then(undefined, failed);
			return result;
		} catch (error) {
			failed(error);
		}
	}

	#complete(state: KeyState, keyId: unknown, own: OwnRound) {
		// Measured on the monotonic clock, not `tsR + leaseMs - now()`: `tsR` never decreases, so a
		// backward wall-clock step would report more lease left than the round was granted.
		const remaining = own.leaseMs - (this.#monotonic() - own.mintedMono);
		if (remaining <= 0) {
			// The lease window closed while the round ran. Participants may already have synthesized this
			// node's grant, so treating the key as held here is exactly the two-holder case.
			this.#finish(state, keyId, own, new ClientError('Record lock was granted after its lease had elapsed', 423));
			return;
		}
		own.acquired = true;
		// From the mint origin: a pause between the two reads would otherwise push the deadline out by
		// its own duration, past what peers bounded.
		own.deadlineMono = own.mintedMono + own.leaseMs;
		own.resolved = true;
		own.resolve({ tsR: own.tsR, mintedMono: own.mintedMono });
	}

	/** End the round: write the withdraw/release, hand out the deferred grants, settle the caller. */
	#finish(state: KeyState, keyId: unknown, own: OwnRound, rejection?: Error): Promise<void> | void {
		own.done = true;
		if (state.own === own) state.own = undefined;
		this.#mutations++;
		let write: Promise<void> | void;
		if (own.requestSettled)
			write = this.#writeControlSafely({
				type: 'lockRelease',
				key: state.key,
				requester: this.nodeId,
				tsR: own.tsR,
			});
		else own.withdrawOwed = true;
		this.#flushDeferred(state);
		if (!own.resolved) {
			own.resolved = true;
			own.reject(rejection ?? new ClientError('Record is locked and was not released in time', 423));
		}
		this.#gc(keyId, state);
		return write;
	}

	/** Give up a round whose own request never became durable; there is nothing to withdraw on the wire. */
	#abandon(state: KeyState, keyId: unknown, own: OwnRound, error: Error) {
		own.done = true;
		if (state.own === own) state.own = undefined;
		this.#mutations++;
		this.#flushDeferred(state);
		if (!own.resolved) {
			own.resolved = true;
			own.reject(error);
		}
		this.#gc(keyId, state);
	}

	#applyRequest(entry: LockControlEntry) {
		if (entry.requester === this.nodeId) return; // our own entry, echoed back
		// Core cannot authenticate an entry's author — the transport owns trusted origin identity — but
		// it can refuse to spend state on a request from a node that replicates nothing here.
		if (!this.#isKnownParticipant(entry.requester)) {
			// The message is deliberately constant: warnOnce latches per distinct string, so
			// interpolating an unvalidated peer-supplied name would let a stream of forged requesters
			// grow that set without bound.
			warnOnce('ignoring a record lock control entry from a node that is not a participant for its database');
			return;
		}
		const waitMs = entry.waitMs!;
		const leaseMs = entry.leaseMs!;
		// A replayed request this old cannot correspond to a live hold anywhere.
		if (entry.tsR < this.#now() - (MAX_LOCK_LEASE_MS + waitMs + this.#skewMs)) return;
		const keyId = this.#keyIdOf(entry.key);
		if (!this.#states.has(keyId) && this.#states.size >= MAX_KEYS_IN_FLIGHT) {
			this.#evictReleasedOnlyKeys();
			if (this.#states.size >= MAX_KEYS_IN_FLIGHT) {
				warnOnce(
					`dropping a replicated record lock request: ${this.database}.${this.table} has too many live keys in flight`
				);
				return;
			}
		}
		const state = this.#stateFor(keyId, entry.key);
		const identity = identityOf(entry.requester, entry.tsR);
		if (state.peers.has(identity)) return; // idempotent by identity, which is what makes replay harmless
		if (state.peers.size >= MAX_PEER_REQUESTS_PER_KEY) {
			// Released rounds linger only so a replayed request cannot resurrect them. They must not
			// consume the contention budget: a hot key turns over more than this many rounds inside one
			// bound, and counting them would make this node withhold grants from live requesters.
			// Re-admitting a replayed round instead costs a spurious grant to a requester that is gone.
			for (const [identity, peer] of state.peers) {
				if (!peer.released) continue;
				state.deletePeer(identity, peer);
				this.#mutations++;
				if (state.peers.size < MAX_PEER_REQUESTS_PER_KEY) break;
			}
		}
		if (state.peers.size >= MAX_PEER_REQUESTS_PER_KEY) {
			warnOnce(`dropping a replicated record lock request: too many live contenders on one key in ${this.table}`);
			return;
		}
		const peer: PeerRound = {
			requester: entry.requester,
			tsR: entry.tsR,
			// Local observation only: comparing this node's clock against the requester's would make the
			// bound depend on clock offset rather than on the skew allowance.
			expiresMono: this.#monotonic() + Math.max(leaseMs, waitMs) + this.#skewMs,
			released: false,
		};
		state.addPeer(identity, peer);
		this.#startTicking();
		const own = state.own;
		const defer =
			own !== undefined && !own.done && (own.acquired || isEarlier(own.tsR, this.nodeId, entry.tsR, entry.requester));
		if (defer) {
			state.deferredOrder.push(identity);
			this.#sortDeferred(state);
			return;
		}
		this.#writeControlSafely({
			type: 'lockGrant',
			key: state.key,
			requester: entry.requester,
			tsR: entry.tsR,
			grantor: this.nodeId,
		});
	}

	#applyGrant(entry: LockControlEntry) {
		if (entry.requester !== this.nodeId) return; // a grant addressed to another node
		const keyId = this.#keyIdOf(entry.key);
		const state = this.#states.get(keyId);
		const own = state?.own;
		if (!state || !own || own.done || own.acquired) return;
		if (own.tsR !== entry.tsR) return; // a grant for a round that already ended
		if (!own.pending.delete(entry.grantor!)) return; // unsolicited, duplicate, or from a non-participant
		if (own.pending.size === 0) this.#complete(state, keyId, own);
	}

	#applyRelease(entry: LockControlEntry) {
		if (entry.requester === this.nodeId) return; // our own entry, echoed back
		const state = this.#states.get(this.#keyIdOf(entry.key));
		if (!state) return;
		const identity = identityOf(entry.requester, entry.tsR);
		const peer = state.peers.get(identity);
		if (!peer || peer.released) return;
		state.releasePeer(peer);
		this.#mutations++;
		// A withdrawn request is owed nothing. The peer record itself stays until its bound, so a
		// replayed request for the same identity cannot resurrect it.
		this.#removeDeferred(state, identity);
	}

	#sortDeferred(state: KeyState) {
		state.deferredOrder.sort((a, b) => {
			const left = state.peers.get(a)!;
			const right = state.peers.get(b)!;
			if (left.tsR !== right.tsR) return left.tsR - right.tsR;
			return left.requester < right.requester ? -1 : left.requester > right.requester ? 1 : 0;
		});
	}

	#removeDeferred(state: KeyState, identity: string) {
		const index = state.deferredOrder.indexOf(identity);
		if (index >= 0) {
			state.deferredOrder.splice(index, 1);
			this.#mutations++;
		}
	}

	#flushDeferred(state: KeyState) {
		if (state.deferredOrder.length === 0) return;
		const order = state.deferredOrder;
		state.deferredOrder = [];
		this.#mutations++;
		for (const identity of order) {
			const peer = state.peers.get(identity);
			if (!peer || peer.released) continue;
			this.#writeControlSafely({
				type: 'lockGrant',
				key: state.key,
				requester: peer.requester,
				tsR: peer.tsR,
				grantor: this.nodeId,
			});
		}
	}
}

const clusterLockTransports = new Map<string, ClusterLockTransport>();
// Databases that have had a transport registered on this worker. A later absence is a transport
// that went away — a component reload, a failed reconnect — not proof the node became standalone,
// so cluster scope must keep failing closed rather than quietly reverting to a node-local lock.
const clusterRequiredDatabases = new Set<string>();
let coordinatorResolver: ((database: string, table: string) => LockCoordinator | undefined) | undefined;

/** Installed by Table.ts so a transport can push received entries in without importing Table. */
export function setLockCoordinatorResolver(resolve: (database: string, table: string) => LockCoordinator | undefined) {
	coordinatorResolver = resolve;
}

export function registerClusterLockTransport(database: string, transport: ClusterLockTransport): void {
	if (typeof transport?.participants !== 'function' || typeof transport?.ownsCoordination !== 'function')
		throw new ClientError('A cluster lock transport must provide participants() and ownsCoordination()');
	transport.onControlEntry = (db: string, table: string, entry: LockControlEntry, author: string) =>
		deliverLockControlEntry(db, table, entry, author);
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

export function deliverLockControlEntry(
	database: string,
	table: string,
	entry: LockControlEntry,
	author: string
): void {
	coordinatorResolver?.(database, table)?.applyEntry(entry, author);
}
