/**
 * Dedicated worker pools: workers of a type other than `http` that run Harper's trusted built-ins
 * but no application code, and bind only the listeners a component declared as owned by their type
 * (`threadType` in the `server.http`/`server.ws`/`server.socket` options). See server/DESIGN.md.
 */
import { isMainThread, workerData } from 'node:worker_threads';
import { THREAD_TYPES } from '../../utility/hdbTerms.ts';
import * as harperLogger from '../../utility/logging/harper_logger.ts';

const DEDICATED_POOL_TYPES: readonly string[] = [THREAD_TYPES.REPLICATION];

let activePools: string[] = [];
let undecided: { types: string[]; decide: () => void; decided: Promise<void> } | undefined;
let admittedPools: string[] | undefined;
const poolUnsupportedTables: string[] = [];

/**
 * Main thread: record the pool types started, so every worker spawned from here learns them. A `pending` type (a
 * defaulted pool) is decided by the first admitted shared HTTP worker's load report: on the main thread it counts as active
 * until then, so placement defers to it; a worker treats it as not yet active until admitted.
 */
export function setActiveWorkerPools(types: string[], pending: string[] = []): void {
	activePools = types;
	undecided = undefined;
	if (pending.length === 0) return;
	const { promise, resolve } = Promise.withResolvers<void>();
	undecided = { types: pending, decide: resolve, decided: promise };
}

/**
 * The pool types the main thread admitted at startup. A pool stays active while its members restart
 * or crash, so a listener it owns is never handed back to the HTTP workers in the meantime.
 */
export function activeWorkerPools(): string[] {
	return isMainThread ? activePools : (admittedPools ?? (workerData as any)?.workerPools ?? []);
}

export function isWorkerPoolActive(type: string): boolean {
	return activeWorkerPools().includes(type);
}

export function pendingWorkerPools(): string[] {
	if (isMainThread) return undecided?.types ?? [];
	return admittedPools ? [] : ((workerData as any)?.pendingWorkerPools ?? []);
}

export function isWorkerPoolPending(type: string): boolean {
	return pendingWorkerPools().includes(type);
}

/** Main thread: resolves once the pending pools are decided; undefined when none are pending. */
export function workerPoolDecision(): Promise<void> | undefined {
	return undecided?.decided;
}

/**
 * Main thread: decide the pending pools from an admitted shared HTTP worker's load report. Every shared worker loads
 * the same applications, so the first one decides; a table that needs application code on the replication path keeps
 * replication on the HTTP workers. Later reports change nothing (a deploy is warned at registration, not re-decided).
 */
export function decideWorkerPools(unsupportedTables: string[] = []): void {
	if (!undecided) return;
	const { types, decide } = undecided;
	undecided = undefined;
	if (unsupportedTables.length > 0) {
		activePools = activePools.filter((type) => !types.includes(type));
		harperLogger.warn(
			`Starting no replication pool: replication.threads is not set and ${unsupportedTables.join(', ')} use deprecated features that replication pool workers do not support; replication runs on the HTTP workers. Set replication.threads: 0 in harper-config.yaml to keep this choice explicit.`
		);
	}
	decide();
}

/** Worker: apply the pools the main thread admitted this worker under, before it binds any listener. */
export function admitWorkerPools(types: string[]): void {
	admittedPools = types;
}

/** Record a table that needs application code on the replication path; reported in this worker's load report. */
export function notePoolUnsupportedTable(table: string): void {
	if (!poolUnsupportedTables.includes(table)) poolUnsupportedTables.push(table);
}

export function poolUnsupportedTablesHere(): string[] {
	return poolUnsupportedTables;
}

/** This thread's worker type, or undefined on the main thread. */
function thisThreadType(): string | undefined {
	return (workerData as any)?.name;
}

export function isDedicatedPoolWorker(type: string | undefined = thisThreadType()): boolean {
	return type !== undefined && DEDICATED_POOL_TYPES.includes(type);
}

/** This worker's position within its pool (0-based), or undefined outside a pool. */
export function poolMemberIndex(): number | undefined {
	return (workerData as any)?.poolIndex;
}

function assertListenerThreadType(threadType: unknown): void {
	if (threadType !== undefined && !DEDICATED_POOL_TYPES.includes(threadType as string))
		throw new Error(`Unknown listener threadType '${threadType}'; expected one of ${DEDICATED_POOL_TYPES.join(', ')}`);
}

const listenerOwners = new Map<string, string>();

/**
 * Declare that the listener keyed `key` (a port, host:port, or socket path, as keyed in SERVERS) is
 * owned by worker type `threadType`. A key can have one owner; a conflicting claim throws.
 */
export function claimListener(key: string | number, threadType: string): void {
	assertListenerThreadType(threadType);
	const normalized = String(key);
	const existing = listenerOwners.get(normalized);
	if (existing !== undefined && existing !== threadType)
		throw new Error(`Listener ${normalized} is already owned by '${existing}' workers, not '${threadType}'`);
	listenerOwners.set(normalized, threadType);
}

export function listenerOwner(key: string | number): string | undefined {
	return listenerOwners.get(String(key));
}

/**
 * Whether this thread binds the listener keyed `key`:
 * - a pool worker binds only listeners owned by its own type;
 * - every other thread skips a listener whose owning pool is active, and binds the rest as before.
 * An owned listener whose pool is not running (pool size 0, or no worker threads) binds as an
 * ordinary listener, so `replication.threads: 0` changes nothing.
 */
export function shouldBindListenerHere(
	key: string | number,
	type: string | undefined = thisThreadType(),
	owner: string | undefined = listenerOwner(key),
	active: string[] = activeWorkerPools()
): boolean {
	if (isDedicatedPoolWorker(type)) return owner === type;
	return owner === undefined || !active.includes(owner);
}
