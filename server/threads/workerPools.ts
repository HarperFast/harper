/**
 * Dedicated worker pools: workers of a type other than `http` that run Harper's trusted built-ins
 * but no application code, and bind only the listeners a component declared as owned by their type
 * (`threadType` in the `server.http`/`server.ws`/`server.socket` options). See server/DESIGN.md.
 */
import { isMainThread, workerData } from 'node:worker_threads';
import { CONFIG_PARAMS, THREAD_TYPES } from '../../utility/hdbTerms.ts';
import * as harperLogger from '../../utility/logging/harper_logger.ts';
import * as env from '../../utility/environment/environmentManager.ts';
import { isolatedApplicationNames, maxIsolatedApplications } from './isolatedApplications.ts';

const DEDICATED_POOL_TYPES: readonly string[] = [THREAD_TYPES.REPLICATION];

let activePools: string[] = [];
let undecided: { types: string[]; decide: () => void; decided: Promise<void> } | undefined;
let admittedPools: string[] | undefined;

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

/** Worker: called before any listener binds. */
export function admitWorkerPools(types: string[]): void {
	admittedPools = types;
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

/** The HTTP worker count bin/run.ts asks startHTTPThreads for; unset means startHTTPThreads' default. */
export function configuredHttpThreadCount(): number | undefined {
	return process.env.DEV_MODE ? 1 : (env.get(CONFIG_PARAMS.THREADS_COUNT) ?? env.get(CONFIG_PARAMS.THREADS));
}

export function effectiveHttpThreadCount(threadCount: number, platform: NodeJS.Platform = process.platform): number {
	return platform === 'win32' && threadCount > 0 ? 1 : threadCount;
}

export function replicationThreadCount(httpThreadCount: number): { count: number; explicit: boolean } {
	const configured = env.get(CONFIG_PARAMS.REPLICATION_THREADS);
	if (configured === undefined || configured === null || configured === '') {
		return {
			count: Number.isFinite(httpThreadCount) && httpThreadCount >= 2 ? Math.floor(httpThreadCount / 2) : 0,
			explicit: false,
		};
	}
	return { count: Number(configured), explicit: true };
}

function portNumberOf(port: unknown): number | undefined {
	if (port == null || port === '') return undefined;
	const text = String(port);
	const number = Number(text.slice(text.lastIndexOf(':') + 1));
	return Number.isInteger(number) && number > 0 ? number : undefined;
}

/**
 * Why a replication pool cannot start, if it cannot. It needs a replication port of its own: without
 * one, replication falls back to the operations API ports, which only the main thread binds, and a port
 * shared with HTTP or the operations API cannot be owned by one worker type.
 */
export function replicationPortRefusal(): string | undefined {
	const replicationPorts = [
		portNumberOf(env.get(CONFIG_PARAMS.REPLICATION_PORT)),
		portNumberOf(env.get(CONFIG_PARAMS.REPLICATION_SECUREPORT)),
	].filter((port) => port !== undefined);
	if (replicationPorts.length === 0)
		return 'replication.threads requires replication.port or replication.securePort: without a dedicated replication port, replication shares the operations API port, which only the main thread binds';
	const sharedPorts = [
		['http.port', CONFIG_PARAMS.HTTP_PORT],
		['http.securePort', CONFIG_PARAMS.HTTP_SECUREPORT],
		['operationsApi.network.port', CONFIG_PARAMS.OPERATIONSAPI_NETWORK_PORT],
		['operationsApi.network.securePort', CONFIG_PARAMS.OPERATIONSAPI_NETWORK_SECUREPORT],
	];
	for (const [label, param] of sharedPorts) {
		const port = portNumberOf(env.get(param));
		if (port !== undefined && replicationPorts.includes(port))
			return `replication.threads requires a replication port of its own, but port ${port} is also ${label}`;
	}
	return undefined;
}

/**
 * The threads startHTTPThreads will start that open tables: main, the HTTP workers, the replication pool
 * and a worker per isolated application, as configured at startup. Workers started later (a job, an
 * application deployed as isolated) are not counted.
 */
export function plannedTableThreadCount(): number {
	const configured = configuredHttpThreadCount();
	const httpThreads = effectiveHttpThreadCount(
		typeof configured === 'number' && Number.isFinite(configured) && configured >= 0 ? Math.ceil(configured) : 2
	);
	if (httpThreads === 0) return 1;
	const { count } = replicationThreadCount(httpThreads);
	const replicationThreads = Number.isInteger(count) && count > 0 && !replicationPortRefusal() ? count : 0;
	return 1 + httpThreads + replicationThreads + configuredIsolatedApplications();
}

function configuredIsolatedApplications(): number {
	try {
		return Math.min(isolatedApplicationNames().length, maxIsolatedApplications());
	} catch {
		// no root config to read: a process opening databases outside an installed Harper
		return 0;
	}
}
