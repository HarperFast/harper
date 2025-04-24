import { table } from '../resources/databases';
import * as logger from '../utility/logging/logger';
import { OperationRequestBody } from './operationsServer';

module.exports = {
    clear: clearStatus,
    get: getStatus,
    set: setStatus,
};

const STATUS_DEFAULT = 'primary';

type StatusOperationRequestBody = OperationRequestBody & {
    id?: string;
    status?: string;
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

function clearStatus({ id }: StatusOperationRequestBody) {
    // todo: not allow clearing default status?
    // todo: throw if the status doesn't exist?
    logger.debug?.('clearStatus', id);
    return Status.delete(id);
}

function getAllStatus() {
    logger.debug?.('getAllStatus');
    return Status.get({});
}

// todo: update to 'also report any additional real-time information about current status'. maybe as a different func
// todo: is there a reason to get a single status?
function getStatus({ id }: StatusOperationRequestBody) {
    if (!id) {
        logger.debug?.('getStatus', 'all');
        return getAllStatus();
    }

    logger.debug?.('getStatus', id);
    return Status.get(id);;
}

function setStatus({ status, id = STATUS_DEFAULT }: StatusOperationRequestBody) {
    // todo: validate
    // todo: return all, or just this status, or just success...or just the put operation
    logger.debug?.('setStatus', id, status);
    return Status.put(id, { status });
}