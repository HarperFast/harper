/**
 * Dedicated worker pools: workers of a type other than `http` that run Harper's trusted built-ins
 * but no application code, and bind only the listeners a component declared as owned by their type
 * (`threadType` in the `server.http`/`server.ws`/`server.socket` options). See server/DESIGN.md.
 */
import { isMainThread, workerData } from 'node:worker_threads';
import { THREAD_TYPES } from '../../utility/hdbTerms.ts';

const DEDICATED_POOL_TYPES: readonly string[] = [THREAD_TYPES.REPLICATION];

let activePools: string[] = [];

/** Main thread: record the pool types started, so every worker spawned from here learns them. */
export function setActiveWorkerPools(types: string[]): void {
	activePools = types;
}

/**
 * The pool types the main thread admitted at startup. A pool stays active while its members restart
 * or crash, so a listener it owns is never handed back to the HTTP workers in the meantime.
 */
export function activeWorkerPools(): string[] {
	return isMainThread ? activePools : ((workerData as any)?.workerPools ?? []);
}

export function isWorkerPoolActive(type: string): boolean {
	return activeWorkerPools().includes(type);
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
