import { table } from '../../resources/databases.js';
import { handleHDBError, hdbErrors } from '../../utility/errors/hdbError.js';
import { loggerWithTag } from '../../utility/logging/logger.js';
import { validateStatus } from '../../validation/statusValidator.js';
import { StatusId, StatusValueMap, StatusRecord, DEFAULT_STATUS_ID } from './definitions.js';
import { internal as statusInternal } from '../../components/status/index.ts';
import type { AggregatedComponentStatus } from '../../components/status/index.ts';
import { restartNeeded } from '../../components/requestRestart.ts';

export { clearStatus as clear, getStatus as get, setStatus as set };

// Re-export types for convenience
export type { 
	StatusId, 
	StatusRecord, 
	StatusValueMap
} from './definitions.js';

export { 
	STATUS_IDS,
	DEFAULT_STATUS_ID
} from './definitions.js';

const { HTTP_STATUS_CODES } = hdbErrors;

// For direct function calls, we don't need the operation fields
type StatusRequestBody = {
	id: StatusId;
};

type StatusWriteRequestBody<T extends StatusId = StatusId> = {
	id?: T;
	status: StatusValueMap[T];
};

// Lazy-initialize the Status table to avoid initialization issues during module import
let _statusTable: ReturnType<typeof table>;

function getStatusTable() {
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
	}
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
	systemStatus: Promise<AsyncIterable<StatusRecord>>;
	componentStatus: AggregatedComponentStatusWithName[];
	restartRequired: boolean;
}

async function getAllStatus(): Promise<AllStatusSummary> {
	statusLogger.debug?.('getAllStatus');
	const statusRecords = getStatusTable().get({});
	
	// Get aggregated component statuses from all threads
	const aggregatedStatuses = await statusInternal.query.allThreads();
	const componentStatusArray: AggregatedComponentStatusWithName[] = Array.from(aggregatedStatuses.entries()).map(([name, status]) => ({
		name,
		...status
	}));
	
	// Get restart flag status
	const restartRequired = restartNeeded();
	
	return {
		systemStatus: statusRecords as Promise<AsyncIterable<StatusRecord>>,
		componentStatus: componentStatusArray,
		restartRequired
	};
}

function getStatus({ id }: Partial<StatusRequestBody>): Promise<StatusRecord | AllStatusSummary> {
	if (!id) {
		statusLogger.debug?.('getStatus', 'all');
		return getAllStatus();
	}

	statusLogger.debug?.('getStatus', id);
	return getStatusTable().get(id) as unknown as Promise<StatusRecord>;
}

function setStatus<T extends StatusId = StatusId>({ 
	status, 
	id = DEFAULT_STATUS_ID as T 
}: StatusWriteRequestBody<T>): Promise<StatusRecord<T>> {
	const validation = validateStatus({ status, id });
	if (validation) {
		throw handleHDBError(validation, validation.message, HTTP_STATUS_CODES.BAD_REQUEST);
	}

	statusLogger.debug?.('setStatus', id, status);
	return getStatusTable().put(id, { status }) as Promise<StatusRecord<T>>;
}
