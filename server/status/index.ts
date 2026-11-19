import { table } from '../../resources/databases.ts';
import { handleHDBError, hdbErrors } from '../../utility/errors/hdbError.ts';
import { loggerWithTag } from '../../utility/logging/logger.ts';
import { validateStatus } from '../../validation/statusValidator.ts';
import { type StatusId, type StatusValueMap, type StatusRecord, DEFAULT_STATUS_ID } from './definitions.ts';
import { internal as statusInternal, type AggregatedComponentStatus } from '../../components/status/index.ts';
import type { ComponentStatusAbnormality } from '../../components/status/types.ts';
import { buildHierarchy, type StatusNode } from '../../components/status/hierarchy.ts';
import { restartNeeded } from '../../components/requestRestart.ts';
import { sendItcEvent } from '../threads/itc.ts';
import { onMessageByType, workers } from '../threads/manageThreads.ts';
import { CONFIG_PARAMS, ITC_EVENT_TYPES, THREAD_TYPES } from '../../utility/hdbTerms.ts';
import * as env from '../../utility/environment/environmentManager.ts';

export { clearStatus as clear, getStatus as get, setStatus as set };

// Re-export types for convenience
export type { StatusId, StatusRecord, StatusValueMap } from './definitions.ts';

export { STATUS_IDS, DEFAULT_STATUS_ID } from './definitions.ts';

const { HTTP_STATUS_CODES } = hdbErrors;
// For direct function calls, we don't need the operation fields
type StatusRequestBody = {
	id: StatusId;
	components?: boolean;
	// Opt in to the resolved HTTP/upgrade/WebSocket middleware chains in the aggregated (no-id)
	// response (#1573). Off by default so routine polling avoids the cross-thread lookup.
	middleware?: boolean;
};

type StatusWriteRequestBody<T extends StatusId = StatusId> = {
	id?: T;
	status: StatusValueMap[T];
};

// Lazy-initialize the Status table to avoid initialization issues during module import
let _statusTable: ReturnType<typeof table>;

function getStatusTable(): any {
	if (!_statusTable) {
		_statusTable = table({
			database: 'system',
			table: 'hdb_status',
			replicate: false,
			attributes: [
				{
					name: 'id',
					isPrimaryKey: true,
				},
				{
					name: 'status',
				},
				{
					name: '__createdtime__',
				},
				{
					name: '__updatedtime__',
				},
			],
		});
	}
	return _statusTable;
}

// Export Status as a getter for compatibility with modules that need direct table access
export const Status = {
	get primaryStore() {
		return getStatusTable().primaryStore;
	},
};

const statusLogger = loggerWithTag('status');

function clearStatus({ id }: StatusRequestBody): Promise<boolean> {
	statusLogger.debug?.('clearStatus', id);
	return getStatusTable().delete(id);
}

type SerializedComponentStatusAbnormality = Omit<ComponentStatusAbnormality, 'error'> & {
	error?: string;
};

interface AggregatedComponentStatusWithName extends Omit<AggregatedComponentStatus, 'error' | 'abnormalities'> {
	name: string;
	error?: string;
	abnormalities?: Record<string, SerializedComponentStatusAbnormality>;
}

function serializeAbnormalities(
	abnormalities: Map<string, ComponentStatusAbnormality> | Record<string, ComponentStatusAbnormality>
): Record<string, SerializedComponentStatusAbnormality> {
	const entries = abnormalities instanceof Map ? abnormalities.entries() : Object.entries(abnormalities);
	const serialized: Record<string, SerializedComponentStatusAbnormality> = {};
	for (const [threadKey, abnormality] of entries) {
		serialized[threadKey] = {
			...abnormality,
			...(abnormality.error !== undefined && {
				error: statusInternal.serializeStatusError(abnormality.error),
			}),
		};
	}
	return serialized;
}

interface AllStatusSummary {
	systemStatus: Promise<AsyncIterable<StatusRecord>> | StatusRecord[];
	componentStatus: AggregatedComponentStatusWithName[];
	components?: Record<string, StatusNode>;
	restartRequired: boolean;
	// Only present when the request opts in with `middleware: true`.
	middlewareChains?: MiddlewareChainsSummary | null;
}

type MiddlewareChainsSummary = ReturnType<typeof import('../http.ts').describeMiddlewareChains>;

let nextChainsRequestId = 1;
let chainsResponseListenerAttached = false;
const pendingChainsRequests = new Map<number, (chains: MiddlewareChainsSummary) => void>();

function attachChainsResponseListener(): void {
	if (chainsResponseListenerAttached) return;
	onMessageByType(ITC_EVENT_TYPES.MIDDLEWARE_CHAINS_RESPONSE, ({ message }: any) => {
		const resolve = pendingChainsRequests.get(message.requestId);
		if (resolve) {
			pendingChainsRequests.delete(message.requestId);
			resolve(message.chains);
		}
	});
	chainsResponseListenerAttached = true;
}

// App HTTP middleware is only registered on worker threads, so when get_status runs on the main
// thread we ask an HTTP worker for its resolved chains (all workers register identically). Returns
// null if no worker answers within the timeout — mirrors queryWorkerForOpenApi in operationsServer.
function queryWorkerForMiddlewareChains(): Promise<MiddlewareChainsSummary | null> {
	attachChainsResponseListener();
	const requestId = nextChainsRequestId++;
	return new Promise((resolve) => {
		const timeoutHandle = setTimeout(() => {
			pendingChainsRequests.delete(requestId);
			resolve(null);
		}, 5000);
		pendingChainsRequests.set(requestId, (chains) => {
			clearTimeout(timeoutHandle);
			resolve(chains);
		});
		sendItcEvent({ type: ITC_EVENT_TYPES.MIDDLEWARE_CHAINS_REQUEST, message: { requestId } }).catch(() => {
			clearTimeout(timeoutHandle);
			pendingChainsRequests.delete(requestId);
			resolve(null);
		});
	});
}

// Introspect the resolved HTTP/upgrade/WebSocket middleware order (#1573). In a multi-worker
// deployment the app middleware is registered on the HTTP worker threads while the main thread
// carries only the operations-API middleware, so when an HTTP worker exists we fetch the chains from
// one over ITC. With no HTTP worker this thread is the app server itself (single-thread mode, or a
// worker serving the request) and reports locally. Job workers don't serve HTTP, so they're ignored.
async function getMiddlewareChains(): Promise<MiddlewareChainsSummary | null> {
	try {
		if (workers.some((worker: { name?: string }) => worker.name === THREAD_TYPES.HTTP))
			return await queryWorkerForMiddlewareChains();
		const { describeMiddlewareChains } = await import('../http.ts');
		return describeMiddlewareChains();
	} catch (error) {
		statusLogger.debug?.('getMiddlewareChains failed', error);
		return null;
	}
}

async function getAllStatus({ components, middleware }: Partial<StatusRequestBody>): Promise<AllStatusSummary> {
	statusLogger.debug?.('getAllStatus');
	const statusRecords = getStatusTable().search([]);

	// With the drain on, one collection serves both the component list and the availability it implies.
	const threadStatuses = drainOnLoadFailure()
		? await statusInternal.crossThreadCollector.collect(statusInternal.componentStatusRegistry)
		: undefined;
	const aggregatedStatuses = threadStatuses
		? statusInternal.StatusAggregator.aggregate(threadStatuses)
		: await statusInternal.query.allThreads();
	const componentStatusArray: AggregatedComponentStatusWithName[] = Array.from(aggregatedStatuses.entries()).map(
		([name, status]) => ({
			name,
			...status,
			...(status.error !== undefined && { error: statusInternal.serializeStatusError(status.error) }),
			...(status.abnormalities !== undefined && {
				abnormalities: serializeAbnormalities(status.abnormalities),
			}),
		})
	);

	// Get restart flag status
	const restartRequired = restartNeeded();

	const summary: AllStatusSummary = {
		systemStatus: threadStatuses
			? await systemStatusWithAvailability(statusRecords, statusInternal.loaderFailures(threadStatuses))
			: (statusRecords as Promise<AsyncIterable<StatusRecord>>),
		componentStatus: componentStatusArray,
		restartRequired,
	};
	if (components === true) summary.components = buildHierarchy(aggregatedStatuses);
	if (middleware === true) summary.middlewareChains = await getMiddlewareChains();
	return summary;
}

function drainOnLoadFailure(): boolean {
	return env.get(CONFIG_PARAMS.STATUS_DRAINONLOADFAILURE) === true;
}

function resolveAvailability(
	stored: StatusRecord<'availability'> | undefined,
	failed: string[]
): StatusRecord<'availability'> | undefined {
	if (stored?.status === 'Unavailable' || failed.length === 0) return stored;
	return { id: 'availability', status: 'Unavailable', message: `Failed to load: ${failed.join(', ')}` };
}

// A plain array, not a lazy search result: the derived record has to replace the stored one in place.
async function systemStatusWithAvailability(statusRecords: unknown, failed: string[]): Promise<StatusRecord[]> {
	const records: StatusRecord[] = [];
	let availabilityIndex = -1;
	for await (const record of statusRecords as AsyncIterable<StatusRecord>) {
		if (record.id === 'availability') availabilityIndex = records.length;
		records.push(record);
	}
	const availability = resolveAvailability(records[availabilityIndex] as StatusRecord<'availability'>, failed);
	if (!availability) return records;
	if (availabilityIndex === -1) records.push(availability);
	else records[availabilityIndex] = availability;
	return records;
}

// Health endpoints poll often; serve the cross-thread result for a short TTL behind one shared refresh.
const LOADER_FAILURES_TTL_MS = 2000;
let loaderFailuresCache: { failed: string[]; at: number } | undefined;
let loaderFailuresRefresh: Promise<string[]> | undefined;

function currentLoaderFailures(): string[] | Promise<string[]> {
	if (loaderFailuresCache && Date.now() - loaderFailuresCache.at <= LOADER_FAILURES_TTL_MS)
		return loaderFailuresCache.failed;
	loaderFailuresRefresh ??= statusInternal.crossThreadCollector
		.collect(statusInternal.componentStatusRegistry)
		.then((threadStatuses) => {
			const failed = statusInternal.loaderFailures(threadStatuses);
			loaderFailuresCache = { failed, at: Date.now() };
			return failed;
		})
		.finally(() => {
			loaderFailuresRefresh = undefined;
		});
	return loaderFailuresRefresh;
}

export function resetLoaderFailuresCache(): void {
	loaderFailuresCache = undefined;
	loaderFailuresRefresh = undefined;
}

/**
 * Availability with `status.drainOnLoadFailure` on: an operator's Unavailable wins, otherwise
 * Unavailable while any thread's loader has a component recorded as failed to load. Derived at read
 * time, so a successful reload heals it and nothing can overwrite an operator drain. Reads every
 * thread because get_status runs on the main thread, which never runs `handleApplication`.
 */
async function getAvailabilityStatus(): Promise<StatusRecord<'availability'> | undefined> {
	const stored = (await getStatusTable().get('availability')) as StatusRecord<'availability'> | undefined;
	if (stored?.status === 'Unavailable') return stored;
	return resolveAvailability(stored, await currentLoaderFailures());
}

function getStatus({
	id,
	components,
	middleware,
}: Partial<StatusRequestBody>): Promise<StatusRecord | AllStatusSummary> {
	if (!id) {
		statusLogger.debug?.('getStatus', 'all');
		return getAllStatus({ components, middleware });
	}

	statusLogger.debug?.('getStatus', id);
	if (id === 'availability' && drainOnLoadFailure()) return getAvailabilityStatus() as Promise<StatusRecord>;
	return getStatusTable().get(id) as unknown as Promise<StatusRecord>;
}

function setStatus<T extends StatusId = StatusId>({
	status,
	id = DEFAULT_STATUS_ID as T,
}: StatusWriteRequestBody<T>): Promise<StatusRecord<T>> {
	const validation = validateStatus({ status, id });
	if (validation) {
		throw handleHDBError(validation, validation.message, HTTP_STATUS_CODES.BAD_REQUEST);
	}

	statusLogger.debug?.('setStatus', id, status);
	return getStatusTable().put(id, { status }) as Promise<StatusRecord<T>>;
}
