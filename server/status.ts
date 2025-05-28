import { table } from '../resources/databases.js';
import { Id } from '../resources/ResourceInterface.js';
import { handleHDBError, hdbErrors } from '../utility/errors/hdbError.js';
import { loggerWithTag } from '../utility/logging/logger.js';
import { OperationRequestBody } from './operationsServer.js';
import { validateStatus, STATUS_DEFAULT } from '../validation/statusValidator.js';

export { clearStatus as clear, getStatus as get, setStatus as set };

const { HTTP_STATUS_CODES } = hdbErrors;

type StatusOperationRequestBody = OperationRequestBody & {
	id: Id;
};

type StatusOperationWriteRequestBody = StatusOperationRequestBody & {
	status: string;
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

function clearStatus({ id }: StatusOperationRequestBody) {
	statusLogger.debug?.('clearStatus', id);
	return getStatusTable().delete(id);
}

function getAllStatus() {
	statusLogger.debug?.('getAllStatus');
	return getStatusTable().get({});
}

function getStatus({ id }: StatusOperationRequestBody) {
	if (!id) {
		statusLogger.debug?.('getStatus', 'all');
		return getAllStatus();
	}

	statusLogger.debug?.('getStatus', id);
	return getStatusTable().get(id);
}

function setStatus({ status, id = STATUS_DEFAULT }: StatusOperationWriteRequestBody) {
	const validation = validateStatus({ status, id });
	if (validation) {
		throw handleHDBError(validation, validation.message, HTTP_STATUS_CODES.BAD_REQUEST);
	}

	statusLogger.debug?.('setStatus', id, status);
	return getStatusTable().put(id, { status });
}
