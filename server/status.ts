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

const Status = table({
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

const statusLogger = loggerWithTag('status');

function clearStatus({ id }: StatusOperationRequestBody) {
	statusLogger.debug?.('clearStatus', id);
	return Status.delete(id);
}

function getAllStatus() {
	statusLogger.debug?.('getAllStatus');
	return Status.get({});
}

function getStatus({ id }: StatusOperationRequestBody) {
	if (!id) {
		statusLogger.debug?.('getStatus', 'all');
		return getAllStatus();
	}

	statusLogger.debug?.('getStatus', id);
	return Status.get(id);
}

function setStatus({ status, id = STATUS_DEFAULT }: StatusOperationWriteRequestBody) {
	const validation = validateStatus({ status, id });
	if (validation) {
		throw handleHDBError(validation, validation.message, HTTP_STATUS_CODES.BAD_REQUEST);
	}

	statusLogger.debug?.('setStatus', id, status);
	return Status.put(id, { status });
}
