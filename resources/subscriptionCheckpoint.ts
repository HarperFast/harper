import { createHash } from 'node:crypto';
import { RocksDatabase, Transaction as RocksTransaction } from '@harperfast/rocksdb-js';
import { getThisNodeName } from '../server/nodeName.ts';
import { ClientError, ResumeHistoryUnavailableError } from '../utility/errors/hdbError.ts';
import { getAuditResumeFloor, getDatabaseGeneration } from './auditStore.ts';
import { commitTrackedRocksTransaction } from './DatabaseTransaction.ts';
import { RecordObject } from './RecordEncoder.ts';
import { getNodeNameForId } from './nodeIdMapping.ts';
import { getOriginClosedFloor, isValidFloor, originFloorsDurable } from './originClosedFloor.ts';

/**
 * Compact per-origin subscription checkpoint. `S = time - overlap` is the inclusive
 * replay boundary of every member not named in `exceptions`; an exception resumes at its own boundary. The member
 * set is bound by `members`, a digest over every member origin and its database generation, so healthy origins
 * are neither named nor counted while an origin the issuer never saw can still be told apart on resume.
 */
export interface SubscriptionCheckpoint {
	v: 1;
	scope: string;
	time: number;
	overlap: number;
	exceptions: { [originName: string]: number };
	members: string;
}

/** The event-origin tag a progress-reporting subscription carries on each event: the origin's local node id. */
export const ORIGIN_ID = Symbol.for('subscription-origin');
const SEQ_KEY = Symbol.for('seq');
export const COPY_BOUND_KEY = Symbol.for('copyBound');
const EPOCH_BUFFER = 'origin-state-epoch';
const epochWords = new WeakMap<object, Int32Array>();

function epochWord(rootStore: any): Int32Array | undefined {
	if (typeof rootStore?.getUserSharedBuffer !== 'function') return;
	let word = epochWords.get(rootStore);
	if (!word)
		epochWords.set(rootStore, (word = new Int32Array(rootStore.getUserSharedBuffer(EPOCH_BUFFER, new ArrayBuffer(4)))));
	return word;
}

/** Every thread sees a qualifier change once its seq row is committed; an admitted checkpoint rechecks on a change. */
export function bumpOriginStateEpoch(rootStore: any): void {
	const word = epochWord(rootStore);
	if (word) Atomics.add(word, 0, 1);
}

export function readOriginStateEpoch(rootStore: any): number {
	const word = epochWord(rootStore);
	return word ? Atomics.load(word, 0) : 0;
}
/** Above the 30 s certificate cadence plus the 5 s idle round, so a healthy cluster folds into one boundary. */
export const MAX_OVERLAP_MS = 60_000;
const MAX_ORIGINS = 1024;
const MAX_REPLACED_GENERATIONS = 8;
const MAX_EXCLUSIONS = 4;
const MAX_COMBINATIONS = 100_000;
const DIGEST_BYTES = 32;

/** One origin's checkpoint-grade state, merged over every seq row that names it. */
export interface OriginState {
	nodeId: number;
	name: string;
	/** The highest closed floor from a route whose stored prefix below it is complete and full-coverage. */
	floor?: number;
	/** The origin's database generation as certified; undefined from level-1 routes alone, or when unordered. */
	generation?: string;
	/** The origin key the route that certified `floor` has been floor-only from (`0`: the origin's first entry). */
	certifiedFrom?: number;
	fullCoverage?: boolean;
	partialHistory?: boolean;
	hole?: boolean;
	floorRevoked?: boolean;
}

export interface MemberBoundary {
	boundary: number;
	generation: string;
}

function originHash(name: string, generation: string): Buffer {
	return createHash('sha256').update(name).update('\0').update(generation).digest();
}

function xorInto(target: Buffer, source: Buffer) {
	for (let i = 0; i < DIGEST_BYTES; i++) target[i] ^= source[i];
}

const originHashes = new Map<string, Buffer>();
function cachedOriginHash(name: string, generation: string): Buffer {
	const key = name + '\0' + generation;
	let hash = originHashes.get(key);
	if (!hash) {
		if (originHashes.size >= 4096) originHashes.clear();
		originHashes.set(key, (hash = originHash(name, generation)));
	}
	return hash;
}

/** Order-independent so that a resume can test candidate member sets by subtraction. */
export function membersDigest(members: Iterable<[name: string, generation: string]>): string {
	const digest = Buffer.alloc(DIGEST_BYTES);
	for (const [name, generation] of members) xorInto(digest, cachedOriginHash(name, generation));
	return digest.toString('hex');
}

/**
 * The highest record version an audit-less base copy wrote here, per origin, over every copying peer's
 * `[copyBound, peerId, ...]` rows (`{ [localOriginId]: version }`, written only by `writeCopyBounds`). This node's
 * log of the origin lacks those rows, so no route certified from at or below the bound holds the origin complete. A
 * malformed row throws: a bound read as absent would admit.
 */
export function readCopyBounds(dbisDb: any): Map<number, number> {
	const bounds = new Map<number, number>();
	for (const { value } of dbisDb.getRange({ start: COPY_BOUND_KEY, end: [COPY_BOUND_KEY, Buffer.from([0xff])] })) {
		mergeCopyBoundRow(bounds, value);
	}
	return bounds;
}

function isCopyBound(bound: unknown): bound is number {
	return typeof bound === 'number' && Number.isFinite(bound) && bound >= 0;
}

function mergeCopyBoundRow(bounds: Map<number, number>, row: any): void {
	// a range read decodes a plain object, a point read a record object
	if (!(row instanceof RecordObject)) {
		const prototype = row && typeof row === 'object' ? Object.getPrototypeOf(row) : undefined;
		if (prototype !== Object.prototype && prototype !== null) throw unreadableCopyBound();
	}
	for (const key of Object.keys(row)) {
		const originId = Number(key);
		const bound = row[key];
		if (!(Number.isInteger(originId) && originId >= 0 && String(originId) === key)) throw unreadableCopyBound();
		if (!isCopyBound(bound)) throw unreadableCopyBound();
		if (!(bounds.get(originId)! >= bound)) bounds.set(originId, bound);
	}
}

export interface CopyBoundChange {
	/** Max-merged into the row `[copyBound, peerId, ...at]`. */
	raise?: ReadonlyMap<number, number>;
	at?: (string | number)[];
	/** Rows `[copyBound, peerId, ...slot]` to remove; whatever they held must already be covered by a row that stays. */
	release?: (string | number)[][];
}

/**
 * Applies `change` to a copying peer's bound rows in one commit, under a cross-thread lock on the peer, then bumps the
 * origin-state epoch, so every capture and admitted replay that read the rows before rechecks. The bump runs even when
 * nothing changed: a retry then publishes a commit whose writer stopped before bumping. A database with no epoch is
 * refused before anything is written. Resolves whether a row changed.
 */
export async function writeCopyBounds(
	rootStore: any,
	peerId: number,
	{ raise, at = [], release = [] }: CopyBoundChange
): Promise<boolean> {
	const epoch = epochWord(rootStore);
	if (!epoch) {
		throw new Error(
			'This database has no origin-state epoch, so a copy bound written to it could not void the checkpoints it covers'
		);
	}
	if (!(Number.isInteger(peerId) && peerId >= 0)) throw new Error(`Invalid copy bound peer id: ${peerId}`);
	if (raise) {
		for (const [originId, bound] of raise) {
			if (!(Number.isInteger(originId) && originId >= 0 && isCopyBound(bound))) {
				throw new Error(`Invalid copy bound for origin ${originId}: ${bound}`);
			}
		}
	}
	const dbisDb = rootStore.dbisDb;
	const rowKey = [COPY_BOUND_KEY, peerId, ...at];
	const plan = () => {
		let row: { [originId: number]: number } | undefined;
		if (raise && raise.size > 0) {
			const merged = new Map<number, number>();
			const existing = dbisDb.getSync(rowKey);
			// rewriting a malformed row from what parses would turn admission's refusal into a lower bound
			if (existing !== undefined) mergeCopyBoundRow(merged, existing);
			let raised = false;
			for (const [originId, bound] of raise) {
				if (!(merged.get(originId)! >= bound)) {
					merged.set(originId, bound);
					raised = true;
				}
			}
			if (raised) row = Object.fromEntries(merged);
		}
		const removals = release
			.map((slot) => [COPY_BOUND_KEY, peerId, ...slot])
			.filter((key) => dbisDb.getSync(key) !== undefined);
		return { row, removals };
	};
	let changed = false;
	if (rootStore instanceof RocksDatabase) {
		await dbisDb.withLock([COPY_BOUND_KEY, peerId], async () => {
			const { row, removals } = plan();
			if (!row && removals.length === 0) return;
			const transaction = new RocksTransaction(dbisDb.store);
			try {
				if (row) dbisDb.putSync(rowKey, row, { transaction });
				for (const key of removals) dbisDb.removeSync(key, { transaction });
				await commitTrackedRocksTransaction(transaction, dbisDb, rootStore);
			} catch (error) {
				// a staged or rejected transaction stays open and would pin a snapshot
				try {
					transaction.abort();
				} catch {}
				throw error;
			}
			changed = true;
		});
	} else {
		rootStore.transactionSync(() => {
			const { row, removals } = plan();
			if (row) dbisDb.putSync(rowKey, row);
			for (const key of removals) dbisDb.removeSync(key);
			changed = Boolean(row) || removals.length > 0;
		});
	}
	Atomics.add(epoch, 0, 1);
	return changed;
}

function unreadableCopyBound(): ResumeHistoryUnavailableError {
	return new ResumeHistoryUnavailableError(
		'A copy bound record is unreadable, so no checkpoint can be shown complete; resubscribe to resynchronize'
	);
}

/** Reads every `[seq, peerId]` row and merges the checkpoint-grade state of each origin it names. */
function readOriginStates(auditStore: any, dbisDb: any): Map<number, OriginState> {
	const states = new Map<number, OriginState>();
	// each origin's row entries, with the peer whose row holds them
	const entries = new Map<number, { node: any; routeId: number }[]>();
	const generation = getDatabaseGeneration(auditStore)?.id;
	const own: OriginState = {
		nodeId: 0,
		name: getThisNodeName(),
		generation,
		certifiedFrom: 0,
		fullCoverage: true,
	};
	// the own floor certifies only when it was on disk before it was published (`syncWal`)
	const published = originFloorsDurable(auditStore.rootStore) ? getOriginClosedFloor(auditStore.rootStore) : undefined;
	if (published) own.floor = published.floor;
	states.set(0, own);
	const copyBounds = readCopyBounds(dbisDb);
	// a copy can restore this node's own lost rows too, which its own log then lacks
	const ownBound = copyBounds.get(0);
	if (ownBound !== undefined) own.certifiedFrom = positionAfter(ownBound);
	const routeCertifies = (node: any) =>
		isValidFloor(node.closedFloor) &&
		typeof node.originGeneration === 'string' &&
		node.fullCoverage === true &&
		node.partialHistory !== true &&
		node.hole !== true &&
		node.floorRevoked !== true &&
		typeof node.certifiedFrom === 'number' &&
		!(node.certifiedFrom > node.closedFloor) &&
		!(node.certifiedFrom <= copyBounds.get(node.id)!);
	for (const { key, value } of dbisDb.getRange({ start: SEQ_KEY, end: [SEQ_KEY, Buffer.from([0xff])] })) {
		const nodes = value?.nodes;
		const routeId = key?.[1];
		if (!Array.isArray(nodes) || typeof routeId !== 'number') continue;
		for (const node of nodes) {
			if (!node || typeof node.id !== 'number' || node.id === 0) continue;
			let originEntries = entries.get(node.id);
			if (!originEntries) {
				const name = getNodeNameForId(auditStore, node.id, true);
				if (name === undefined) continue;
				states.set(node.id, { nodeId: node.id, name });
				entries.set(node.id, (originEntries = []));
			}
			originEntries.push({ node, routeId });
		}
	}
	for (const [nodeId, originEntries] of entries) {
		const state = states.get(nodeId)!;
		state.generation = currentGeneration(nodeId, originEntries);
		if (state.generation === undefined) continue;
		// only rows of the current generation speak for the origin
		for (const { node } of originEntries) {
			if (node.originGeneration !== state.generation) continue;
			if (!(state.floor >= node.closedFloor) && routeCertifies(node)) {
				// the route that certified the floor is the one whose prefix below it is complete: another whole
				// route's start says nothing about this one, since their coverage can be disjoint
				state.floor = node.closedFloor;
				state.certifiedFrom = node.certifiedFrom;
				state.fullCoverage = true;
			}
			if (node.floorRevoked === true) state.floorRevoked = true;
			if (node.hole === true) state.hole = true;
		}
	}
	return states;
}

/**
 * The origin's generation its rows show current: the only one they name, or else the one its direct route saw
 * replace every other they name. A floor cannot order generations: floors sample the origin's clock, which a restore
 * can set back. A relayed route is no witness either: a restored relay can forward a generation older than one it
 * already forwarded. Undefined when nothing orders them, so the origin certifies nothing.
 */
function currentGeneration(nodeId: number, originEntries: { node: any; routeId: number }[]): string | undefined {
	let named: string | undefined;
	let conflicting = false;
	let direct: any;
	for (const { node, routeId } of originEntries) {
		if (routeId === nodeId) direct = node;
		if (typeof node.originGeneration !== 'string') continue;
		if (named === undefined) named = node.originGeneration;
		else if (node.originGeneration !== named) conflicting = true;
	}
	if (!conflicting) return named;
	const current = direct?.originGeneration;
	const replaced = direct?.replacedGenerations;
	if (typeof current !== 'string' || !Array.isArray(replaced) || replaced.includes(current)) return;
	for (const { node } of originEntries) {
		const generation = node.originGeneration;
		if (typeof generation === 'string' && generation !== current && !replaced.includes(generation)) return;
	}
	return current;
}

/**
 * `replaced` appended to the generations the direct route saw its origin leave, keeping the newest
 * `MAX_REPLACED_GENERATIONS`; a dropped one can only leave the origin unordered. A generation the route returns to stays
 * listed, so a reversal reads as the contradiction it is.
 */
export function withReplacedGeneration(replacedGenerations: unknown, replaced: string): string[] {
	const generations = Array.isArray(replacedGenerations)
		? replacedGenerations.filter((generation) => typeof generation === 'string' && generation !== replaced)
		: [];
	generations.push(replaced);
	return generations.slice(-MAX_REPLACED_GENERATIONS);
}

function qualifies(state: OriginState): boolean {
	return (
		isValidFloor(state.floor) &&
		typeof state.generation === 'string' &&
		state.fullCoverage === true &&
		state.partialHistory !== true &&
		state.hole !== true &&
		state.floorRevoked !== true &&
		typeof state.certifiedFrom === 'number' &&
		!(state.certifiedFrom > state.floor!)
	);
}

/** The logs the audit store holds, by name; each is an origin this node has history of. */
function knownLogNames(auditStore: any): string[] {
	const names: string[] = [];
	for (const log of auditStore.loadLogs?.() ?? []) {
		if (log?.name && log.name !== 'local') names.push(log.name);
	}
	return names;
}

export interface CertifiedFloors {
	/** By local origin node id. */
	origins: Map<number, OriginState>;
	capturedAt: number;
	/** The origin-state epoch read before the capture: a qualifier or copy bound committed since may void it. */
	epoch: number;
}

/**
 * Strict availability: every origin this database knows — its own, every seq-row origin and every log — must hold
 * a qualifying floor, or nothing is captured.
 */
export function captureCertifiedFloors(auditStore: any, dbisDb: any): CertifiedFloors | undefined {
	const epoch = readOriginStateEpoch(auditStore.rootStore);
	const states = readOriginStates(auditStore, dbisDb);
	if (states.size > MAX_ORIGINS) return;
	for (const state of states.values()) if (!qualifies(state)) return;
	const byName = new Map<string, OriginState>();
	for (const state of states.values()) byName.set(state.name, state);
	for (const name of knownLogNames(auditStore)) if (!byName.has(name)) return;
	return { origins: states, capturedAt: Date.now(), epoch };
}

const KEY_SCRATCH = new Float64Array(1);
const KEY_BITS = new BigInt64Array(KEY_SCRATCH.buffer);
/** The greatest double below a log key, so a replay after it starts at the key. */
export function positionBefore(key: number): number {
	if (key === 0) return -Number.MIN_VALUE;
	// doubles of one sign order by their bit patterns, read as signed integers
	KEY_SCRATCH[0] = key;
	KEY_BITS[0] += key > 0 ? -1n : 1n;
	return KEY_SCRATCH[0];
}

function positionAfter(key: number): number {
	if (key === 0) return Number.MIN_VALUE;
	KEY_SCRATCH[0] = key;
	KEY_BITS[0] += 1n;
	return KEY_SCRATCH[0];
}

/** Folds per-origin boundaries into the compact form; a boundary is never raised. */
export function encodeCheckpoint(scope: string, boundaries: Map<string, MemberBoundary>): SubscriptionCheckpoint {
	let time = 0;
	let lowest = Infinity;
	for (const { boundary } of boundaries.values()) {
		if (boundary > time) time = boundary;
		if (boundary < lowest) lowest = boundary;
	}
	const common = Math.max(lowest, time - MAX_OVERLAP_MS);
	const exceptions: { [originName: string]: number } = {};
	const members: [string, string][] = [];
	for (const [name, { boundary, generation }] of boundaries) {
		if (boundary < common) exceptions[name] = boundary;
		members.push([name, generation]);
	}
	return { v: 1, scope, time, overlap: time - common, exceptions, members: membersDigest(members) };
}

export function validateCheckpoint(value: unknown): SubscriptionCheckpoint {
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ClientError('resume must be a checkpoint');
	const token = value as any;
	if (token.v !== 1) throw new ClientError('Unsupported checkpoint version; this node supports checkpoint v1');
	if (typeof token.scope !== 'string' || token.scope.length === 0 || token.scope.length > 4096) {
		throw new ClientError('A checkpoint names its scope');
	}
	const inKeyDomain = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0;
	if (!inKeyDomain(token.time) || !(token.time === 0 || isValidFloor(token.time))) {
		throw new ClientError('A checkpoint time must be a log key');
	}
	if (!inKeyDomain(token.overlap) || token.overlap > token.time) {
		throw new ClientError('A checkpoint overlap must be between 0 and its time');
	}
	if (typeof token.members !== 'string' || !/^[0-9a-f]{64}$/.test(token.members)) {
		throw new ClientError('A checkpoint carries a 64-hex members digest');
	}
	const exceptions = token.exceptions ?? {};
	if (!exceptions || typeof exceptions !== 'object' || Array.isArray(exceptions)) {
		throw new ClientError('Checkpoint exceptions must map origin names to log keys');
	}
	const names = Object.keys(exceptions);
	if (names.length > MAX_ORIGINS) throw new ClientError(`A checkpoint names at most ${MAX_ORIGINS} exceptions`);
	const common = token.time - token.overlap;
	for (const name of names) {
		const boundary = exceptions[name];
		if (name.length === 0 || name.length > 512) throw new ClientError('A checkpoint exception names an origin');
		if (!inKeyDomain(boundary) || !(boundary === 0 || isValidFloor(boundary)) || !(boundary < common)) {
			throw new ClientError(`Checkpoint exception for ${name} must be a log key below the common boundary`);
		}
	}
	return {
		v: 1,
		scope: token.scope,
		time: token.time,
		overlap: token.overlap,
		exceptions: { ...exceptions },
		members: token.members,
	};
}

export interface Membership {
	/** Member origins by name, with the boundary the token certifies for each. */
	members: Map<string, number>;
	/** Candidate origins the token does not certify. */
	excluded: Set<string>;
}

/**
 * Finds the subset of `candidates` whose digest is the token's, excluding at most `MAX_EXCLUSIONS` of the
 * candidates in `excludable`, in order of exclusion count; undefined when no bounded subset matches.
 */
export function resolveMembership(
	token: SubscriptionCheckpoint,
	candidates: Map<string, string>,
	excludable: Iterable<string>
): Membership | undefined {
	const wanted = Buffer.from(token.members, 'hex');
	const all = Buffer.alloc(DIGEST_BYTES);
	const hashes = new Map<string, Buffer>();
	for (const [name, generation] of candidates) {
		const hash = originHash(name, generation);
		hashes.set(name, hash);
		xorInto(all, hash);
	}
	// target: the XOR of the excluded set's hashes
	const target = Buffer.alloc(DIGEST_BYTES);
	xorInto(target, all);
	xorInto(target, wanted);
	const pool = [...excludable].filter((name) => hashes.has(name));
	const common = token.time - token.overlap;
	const build = (excluded: string[]): Membership => {
		const members = new Map<string, number>();
		const excludedSet = new Set(excluded);
		for (const name of candidates.keys()) {
			if (excludedSet.has(name)) continue;
			members.set(name, Object.hasOwn(token.exceptions, name) ? token.exceptions[name] : common);
		}
		return { members, excluded: excludedSet };
	};
	if (target.equals(Buffer.alloc(DIGEST_BYTES))) return build([]);
	let combinations = 0;
	const scratch = Buffer.alloc(DIGEST_BYTES);
	const chosen: number[] = [];
	const search = (size: number, from: number): string[] | undefined => {
		if (chosen.length === size) {
			if (++combinations > MAX_COMBINATIONS) return;
			scratch.fill(0);
			for (const index of chosen) xorInto(scratch, hashes.get(pool[index])!);
			return scratch.equals(target) ? chosen.map((index) => pool[index]) : undefined;
		}
		for (let i = from; i <= pool.length - (size - chosen.length); i++) {
			chosen.push(i);
			const found = search(size, i + 1);
			chosen.pop();
			if (found || combinations > MAX_COMBINATIONS) return found;
		}
	};
	for (let size = 1; size <= Math.min(MAX_EXCLUSIONS, pool.length); size++) {
		const excluded = search(size, 0);
		if (excluded) return build(excluded);
		if (combinations > MAX_COMBINATIONS) return;
	}
}

export interface ResumePlan {
	/** Inclusive start per transaction-log name; `0` for an admitted late joiner. */
	startByLog: Map<string, number>;
	/** Whether every log started at 0 still holds its first segment; a prune there ends a reader silently. */
	retainsZeroStarts: () => boolean;
	/** The per-origin boundaries the replay reports until it has handled past them, by origin name. */
	boundaries: Map<string, MemberBoundary>;
}

/** Whether this node's log of the origin is whole from the origin's first entry and still retains it. */
function retainsBeginning(auditStore: any, state: OriginState): boolean {
	// only the route that certifies the floor proves a continuous prefix, so a whole-log replay needs that route
	// to have begun at the origin's first entry; a revoked or floorless origin cannot be shown whole
	if (!qualifies(state) || state.certifiedFrom !== 0) return false;
	// read, never useLog: that would create the log
	const log = auditStore.logByName?.get(state.nodeId === 0 ? 'local' : state.name);
	if (!log) return true; // no log yet: nothing of the origin has arrived, so nothing is behind
	try {
		const stats = log.getStats();
		return stats.fileCount === 0 || stats.oldestSequenceNumber === 1;
	} catch {
		return false;
	}
}

/**
 * Admission against this node's current origin state: membership through the digest,
 * every member boundary above the resume floor, its origin not revoked, and this node holding a complete
 * full-coverage route for it from at or below the boundary. Throws 410 with the reason; the planned replay seeks
 * each member's log inclusively at its boundary.
 */
export function admitCheckpoint(
	auditStore: any,
	dbisDb: any,
	token: SubscriptionCheckpoint,
	{ checkRetention = true } = {}
): ResumePlan {
	const states = readOriginStates(auditStore, dbisDb);
	if (typeof states.get(0)?.generation !== 'string') {
		throw new ClientError('This database has no readable generation; resubscribe to resynchronize', 409);
	}
	const candidates = new Map<string, string>();
	const byName = new Map<string, OriginState>();
	const excludable: string[] = [];
	for (const state of states.values()) {
		byName.set(state.name, state);
		if (typeof state.generation === 'string') candidates.set(state.name, state.generation);
		if (retainsBeginning(auditStore, state)) excludable.push(state.name);
	}
	const membership = resolveMembership(token, candidates, excludable);
	if (!membership) {
		throw new ResumeHistoryUnavailableError(
			'The checkpoint certifies an origin set this node cannot serve (an origin it lacks, a changed origin generation, or a route that does not certify); resubscribe to resynchronize'
		);
	}
	const resumeFloor = getAuditResumeFloor(auditStore);
	const startByLog = new Map<string, number>();
	const boundaries = new Map<string, MemberBoundary>();
	const logName = (state: OriginState) => (state.nodeId === 0 ? 'local' : state.name);
	for (const [name, boundary] of membership.members) {
		const state = byName.get(name)!;
		if (boundary === 0) {
			// a whole-log replay is complete while the log keeps its beginning, whatever the key-domain floor
			if (!retainsBeginning(auditStore, state)) {
				throw new ResumeHistoryUnavailableError(
					`The log of origin ${name} is no longer retained from its beginning; resubscribe to resynchronize`
				);
			}
			startByLog.set(logName(state), 0);
			boundaries.set(name, { boundary: 0, generation: state.generation! });
			continue;
		}
		if (checkRetention && !(boundary >= resumeFloor)) {
			throw new ResumeHistoryUnavailableError(
				`The history after the checkpoint boundary of ${name} is no longer retained; resubscribe to resynchronize`
			);
		}
		if (state.floorRevoked && boundary > 0) {
			throw new ResumeHistoryUnavailableError(
				`Origin ${name} may have written below its certified floor; resubscribe to resynchronize`
			);
		}
		if (state.nodeId === 0 && !(state.certifiedFrom! <= boundary)) {
			throw new ResumeHistoryUnavailableError(
				`A copy restored rows of this node's own origin above the checkpoint boundary; resubscribe to resynchronize`
			);
		}
		if (state.nodeId !== 0 && !(qualifies(state) && state.certifiedFrom <= boundary)) {
			throw new ResumeHistoryUnavailableError(
				`This node holds no complete route for origin ${name} from the checkpoint boundary; resubscribe to resynchronize`
			);
		}
		startByLog.set(logName(state), boundary);
		boundaries.set(name, { boundary, generation: state.generation! });
	}
	for (const name of membership.excluded) {
		const state = byName.get(name)!;
		startByLog.set(logName(state), 0);
		boundaries.set(name, { boundary: 0, generation: state.generation! });
	}
	// logs with no seq-row state at all (a legacy origin) were not candidates, so they are not members
	for (const name of knownLogNames(auditStore)) {
		if (!startByLog.has(name)) {
			throw new ResumeHistoryUnavailableError(
				`Origin ${name} has history here that no certificate covers; resubscribe to resynchronize`
			);
		}
	}
	const zeroStartLogs = [...startByLog].filter(([, start]) => start === 0).map(([name]) => name);
	const retainsZeroStarts = () =>
		zeroStartLogs.every((name) => {
			const log = auditStore.logByName?.get(name);
			if (!log) return true;
			try {
				const stats = log.getStats();
				return stats.fileCount === 0 || stats.oldestSequenceNumber === 1;
			} catch {
				return false;
			}
		});
	return { startByLog, boundaries, retainsZeroStarts };
}

/** Canonical scope identity: what a checkpoint's evaluation guarantee is bound to. */
export function checkpointScope(parts: {
	database: string;
	table: string;
	tableGeneration?: string | number;
	target: unknown;
	collection: boolean;
	rawEvents?: boolean;
	includeSuperseded?: boolean;
	onlyChildren?: boolean;
	filterKey?: string;
}): string {
	return JSON.stringify([
		parts.database,
		parts.table,
		parts.tableGeneration ?? null,
		parts.target ?? null,
		parts.collection,
		Boolean(parts.rawEvents),
		Boolean(parts.includeSuperseded),
		Boolean(parts.onlyChildren),
		parts.filterKey ?? null,
	]);
}
