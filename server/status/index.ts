import { table } from '../../resources/databases.ts';
import { handleHDBError, hdbErrors } from '../../utility/errors/hdbError.ts';
import { loggerWithTag } from '../../utility/logging/logger.ts';
import { validateStatus } from '../../validation/statusValidator.ts';
import { type StatusId, type StatusValueMap, type StatusRecord, DEFAULT_STATUS_ID } from './definitions.ts';
import { internal as statusInternal, type AggregatedComponentStatus } from '../../components/status/index.ts';
import { restartNeeded } from '../../components/requestRestart.ts';
import { sendItcEvent } from '../threads/itc.js';
import { onMessageByType, workers } from '../threads/manageThreads.js';
import { ITC_EVENT_TYPES, THREAD_TYPES } from '../../utility/hdbTerms.ts';

export { clearStatus as clear, getStatus as get, setStatus as set };

// Re-export types for convenience
export type { StatusId, StatusRecord, StatusValueMap } from './definitions.ts';

export { STATUS_IDS, DEFAULT_STATUS_ID } from './definitions.ts';

const { HTTP_STATUS_CODES } = hdbErrors;

// For direct function calls, we don't need the operation fields
type StatusRequestBody = {
	id: StatusId;
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

interface AggregatedComponentStatusWithName extends AggregatedComponentStatus {
	name: string;
}

interface AllStatusSummary {
	systemStatus: StatusRecord[];
	componentStatus: AggregatedComponentStatusWithName[];
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

async function getAllStatus(includeMiddleware = false): Promise<AllStatusSummary> {
	statusLogger.debug?.('getAllStatus');

	// Get aggregated component statuses from all threads
	const aggregatedStatuses = await statusInternal.query.allThreads();
	const componentStatusArray: AggregatedComponentStatusWithName[] = Array.from(aggregatedStatuses.entries()).map(
		([name, status]) => ({
			name,
			...status,
		})
	);

	// Get restart flag status
	const restartRequired = restartNeeded();

	// Resolve the availability record the same way the single-id read does, so the aggregate
	// response never contradicts get_status {id:'availability'} for the same component failure.
	const derivedAvailability = await getAvailabilityStatus();

	// Materialize the stored records into a plain array (not a generator): the serialized response
	// relies on toJSON, which an async generator lacks, so a generator emits systemStatus:{} to HTTP
	// callers. Substitute the derived availability for the stored record, appending it when none is stored.
	const systemStatus: StatusRecord[] = [];
	let sawAvailability = false;
	for await (const record of getStatusTable().search([]) as AsyncIterable<StatusRecord>) {
		if (record?.id === 'availability') {
			sawAvailability = true;
			systemStatus.push((derivedAvailability ?? record) as StatusRecord);
		} else systemStatus.push(record);
	}
	if (!sawAvailability && derivedAvailability) systemStatus.push(derivedAvailability as StatusRecord);

	const summary: AllStatusSummary = {
		systemStatus,
		componentStatus: componentStatusArray,
		restartRequired,
	};
	if (includeMiddleware) summary.middlewareChains = await getMiddlewareChains();
	return summary;
}

// Cached list of failed component names, so the availability read does not make a cross-thread
// round trip on every poll (a health endpoint is polled often). The all-threads aggregate is the
// authoritative source and is correct under worker churn on its own (a dead worker drops out of the
// broadcast, a restarted one reports its current state), so this only avoids the per-poll cost. The
// first read refreshes; later reads within the TTL are served locally and refresh once it lapses.
const COMPONENT_HEALTH_TTL_MS = 2000;
let componentHealthCache: { failed: string[]; at: number } | undefined;
// A single in-flight refresh shared by every concurrent stale read, so a burst of polls during one
// slow aggregate (e.g. a worker taking the collector's full timeout to answer) triggers one round
// trip rather than one per poll.
let componentHealthRefresh: Promise<void> | undefined;

function refreshComponentHealth(): Promise<void> {
	if (!componentHealthRefresh) {
		componentHealthRefresh = statusInternal.query
			.allThreads()
			.then((aggregated) => {
				const failed = Array.from(aggregated.values())
					.filter((component) => component.status === statusInternal.COMPONENT_STATUS_LEVELS.ERROR)
					.map((component) => component.componentName);
				componentHealthCache = { failed, at: Date.now() };
			})
			.finally(() => {
				componentHealthRefresh = undefined;
			});
	}
	return componentHealthRefresh;
}

async function failedComponents(): Promise<string[]> {
	if (!componentHealthCache || Date.now() - componentHealthCache.at > COMPONENT_HEALTH_TTL_MS)
		await refreshComponentHealth();
	return componentHealthCache!.failed;
}

// Drop the cache so the next read re-aggregates immediately; for tests that assert a state change
// without waiting out the TTL.
export function resetComponentHealthCache(): void {
	componentHealthCache = undefined;
	componentHealthRefresh = undefined;
}

/**
 * The availability status routing (GTM) consults, combining the operator-owned record with live
 * component health (#3184): an operator's Unavailable always wins, otherwise the node reads
 * Unavailable while any component is in error. Derived at read time so a component that recovers
 * heals on its own and no automatic write can clobber an operator drain; validation failures divert
 * to the sink, never the live registry, so a candidate cannot drain the node.
 *
 * Component health comes from the all-threads aggregate, not this thread's registry: get_status runs
 * on the operations thread, which loads with isWorker=false and never runs handleApplication, so a
 * wedged worker's load failure is only visible across threads. The aggregate is cached (see above) so
 * this is not a cross-thread round trip on every poll.
 */
async function getAvailabilityStatus(): Promise<StatusRecord<'availability'> | undefined> {
	const record = (await getStatusTable().get('availability')) as StatusRecord<'availability'> | undefined;
	if (record?.status === 'Unavailable') return record;
	const failed = await failedComponents();
	if (failed.length === 0) return record;
	return {
		id: 'availability',
		status: 'Unavailable',
		message: `Component failure: ${failed.join(', ')}`,
	};
}

function getStatus({ id, middleware }: Partial<StatusRequestBody>): Promise<StatusRecord | AllStatusSummary> {
	if (!id) {
		statusLogger.debug?.('getStatus', 'all');
		return getAllStatus(middleware === true);
	}

	statusLogger.debug?.('getStatus', id);
	if (id === 'availability') return getAvailabilityStatus() as Promise<StatusRecord>;
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
