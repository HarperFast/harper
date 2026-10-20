import { createHash } from 'node:crypto';
import { getThisNodeName } from '../server/nodeName.ts';
import { ClientError, ResumeHistoryUnavailableError } from '../utility/errors/hdbError.ts';
import { getAuditResumeFloor, getDatabaseGeneration } from './auditStore.ts';
import { getNodeNameForId } from './nodeIdMapping.ts';
import { getOriginClosedFloor, isValidFloor } from './originClosedFloor.ts';

/**
 * Compact per-origin subscription checkpoint (harper-pro#922 items 3–4). `S = time - overlap` is the inclusive
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
export const SEQ_KEY = Symbol.for('seq');
/** Above the 30 s certificate cadence plus the 5 s idle round, so a healthy cluster folds into one boundary. */
export const MAX_OVERLAP_MS = 60_000;
export const MAX_ORIGINS = 1024;
const MAX_EXCLUSIONS = 4;
const MAX_COMBINATIONS = 100_000;
const DIGEST_BYTES = 32;

/** One origin's checkpoint-grade state, merged over every seq row that names it. */
export interface OriginState {
	nodeId: number;
	name: string;
	/** The highest closed floor from a route whose stored prefix below it is complete and full-coverage. */
	floor?: number;
	/** The origin's database generation as certified; undefined from a level-1 route. */
	generation?: string;
	/** The origin key this node's route has been floor-only from (`0`: the origin's first entry). */
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

/** Order-independent so that a resume can test candidate member sets by subtraction. */
export function membersDigest(members: Iterable<[name: string, generation: string]>): string {
	const digest = Buffer.alloc(DIGEST_BYTES);
	for (const [name, generation] of members) xorInto(digest, originHash(name, generation));
	return digest.toString('hex');
}

/** Reads every `[seq, peerId]` row and merges the checkpoint-grade state of each origin it names. */
export function readOriginStates(auditStore: any, dbisDb: any): Map<number, OriginState> {
	const states = new Map<number, OriginState>();
	const generation = getDatabaseGeneration(auditStore)?.id;
	const own: OriginState = {
		nodeId: 0,
		name: getThisNodeName(),
		generation,
		certifiedFrom: 0,
		fullCoverage: true,
	};
	const published = getOriginClosedFloor(auditStore.rootStore);
	if (published) own.floor = published.floor;
	states.set(0, own);
	for (const { key, value } of dbisDb.getRange({ start: SEQ_KEY, end: [SEQ_KEY, Buffer.from([0xff])] })) {
		const nodes = value?.nodes;
		if (!Array.isArray(nodes) || typeof key?.[1] !== 'number') continue;
		for (const node of nodes) {
			if (!node || typeof node.id !== 'number' || node.id === 0) continue;
			let state = states.get(node.id);
			if (!state) {
				const name = getNodeNameForId(auditStore, node.id, true);
				if (name === undefined) continue;
				states.set(node.id, (state = { nodeId: node.id, name }));
			}
			// revocation and holes are sticky across every row; a floor qualifies only with its own row's qualifiers
			if (node.floorRevoked === true) state.floorRevoked = true;
			if (node.hole === true) state.hole = true;
			if (
				isValidFloor(node.closedFloor) &&
				typeof node.originGeneration === 'string' &&
				node.fullCoverage === true &&
				node.partialHistory !== true &&
				node.hole !== true &&
				node.floorRevoked !== true &&
				typeof node.certifiedFrom === 'number' &&
				!(state.floor >= node.closedFloor)
			) {
				state.floor = node.closedFloor;
				state.generation = node.originGeneration;
				state.certifiedFrom = node.certifiedFrom;
				state.fullCoverage = true;
			}
			if (typeof node.certifiedFrom === 'number' && !(state.certifiedFrom <= node.certifiedFrom)) {
				state.certifiedFrom = node.certifiedFrom;
			}
		}
	}
	return states;
}

function qualifies(state: OriginState): boolean {
	return (
		isValidFloor(state.floor) &&
		typeof state.generation === 'string' &&
		state.fullCoverage === true &&
		state.partialHistory !== true &&
		state.hole !== true &&
		state.floorRevoked !== true &&
		typeof state.certifiedFrom === 'number'
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
}

/**
 * Strict availability: every origin this database knows — its own, every seq-row origin and every log — must hold
 * a qualifying floor, or nothing is captured.
 */
export function captureCertifiedFloors(auditStore: any, dbisDb: any): CertifiedFloors | undefined {
	const states = readOriginStates(auditStore, dbisDb);
	if (states.size > MAX_ORIGINS) return;
	for (const state of states.values()) if (!qualifies(state)) return;
	const byName = new Map<string, OriginState>();
	for (const state of states.values()) byName.set(state.name, state);
	for (const name of knownLogNames(auditStore)) if (!byName.has(name)) return;
	return { origins: states, capturedAt: Date.now() };
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
	/** The per-origin boundaries the replay reports until it has handled past them, by origin name. */
	boundaries: Map<string, MemberBoundary>;
}

/** Whether `name`'s log here begins at that origin's first entry and still retains it. */
function retainsBeginning(auditStore: any, state: OriginState): boolean {
	if (state.certifiedFrom !== 0) return false;
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
 * Admission (harper-pro#922 item 4) against this node's current origin state: membership through the digest,
 * every member boundary above the resume floor, its origin not revoked, and this node holding a complete
 * full-coverage route for it from at or below the boundary. Throws 410 with the reason; the planned replay seeks
 * each member's log inclusively at its boundary.
 */
export function admitCheckpoint(auditStore: any, dbisDb: any, token: SubscriptionCheckpoint): ResumePlan {
	const states = readOriginStates(auditStore, dbisDb);
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
		if (!(boundary >= resumeFloor)) {
			throw new ResumeHistoryUnavailableError(
				`The history after the checkpoint boundary of ${name} is no longer retained; resubscribe to resynchronize`
			);
		}
		if (state.floorRevoked && boundary > 0) {
			throw new ResumeHistoryUnavailableError(
				`Origin ${name} may have written below its certified floor; resubscribe to resynchronize`
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
	return { startByLog, boundaries };
}

/** Canonical scope identity: what a checkpoint's evaluation guarantee is bound to. */
export function checkpointScope(parts: {
	database: string;
	table: string;
	tableGeneration?: string | number;
	target: unknown;
	rawEvents?: boolean;
	includeSuperseded?: boolean;
	omitCurrent?: boolean;
	onlyChildren?: boolean;
	filterKey?: string;
}): string {
	return JSON.stringify([
		parts.database,
		parts.table,
		parts.tableGeneration ?? null,
		parts.target ?? null,
		Boolean(parts.rawEvents),
		Boolean(parts.includeSuperseded),
		Boolean(parts.onlyChildren),
		parts.filterKey ?? null,
	]);
}
