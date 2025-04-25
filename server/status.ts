import { table } from '../resources/databases.js';
import { Id } from '../resources/ResourceInterface.js';
import { loggerWithTag } from '../utility/logging/logger.js';
import { OperationRequestBody } from './operationsServer.js';

export {
    clearStatus as clear,
    getStatus as get,
    setStatus as set,
};

const STATUS_DEFAULT = 'primary';

type StatusOperationRequestBody = OperationRequestBody & {
    id: Id;
};

type StatusOperationWriteRequestBody = StatusOperationRequestBody & {
    status: string;
};

const Status = table({
    database: 'system',
    table: 'hdb_status',
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

// todo: update to 'also report any additional real-time information about current status'. maybe as a different func
// todo: is there a reason to get a single status?
function getStatus({ id }: StatusOperationRequestBody) {
    if (!id) {
        statusLogger.debug?.('getStatus', 'all');
        return getAllStatus();
    }

    statusLogger.debug?.('getStatus', id);
    return Status.get(id);;
}

function setStatus({ status, id = STATUS_DEFAULT }: StatusOperationWriteRequestBody) {
    // todo: validate
    // todo: return all, or just this status, or just success...or just the put operation
    statusLogger.debug?.('setStatus', id, status);
    return Status.put(id, { status });
}