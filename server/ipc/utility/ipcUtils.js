'use strict';

const hdb_logger = require('../../../utility/logging/harper_logger');
const hdb_utils = require('../../../utility/common_utils');
const hdb_terms = require('../../../utility/hdbTerms');
const { IPC_ERRORS } = require('../../../utility/errors/commonErrors');

module.exports = {
    sendIpcEvent,
    validateEvent
};

/**
 * Emits an IPC event to the IPC server.
 * @param event
 */
function sendIpcEvent(event) {
    if (global.hdb_ipc) {
        global.hdb_ipc.emitToServer(event);
    } else {
        hdb_logger.warn(`Tried to send event: ${JSON.stringify(event)} to HDB IPC client but it does not exist`);
    }
}

/**
 * Does some basic validation on an IPC event.
 * @param event
 * @returns {string}
 */
function validateEvent(event) {
    if (typeof event !== 'object') {
        return IPC_ERRORS.INVALID_IPC_DATA_TYPE;
    }

    if (!event.hasOwnProperty('type') || hdb_utils.isEmpty(event.type)) {
        return IPC_ERRORS.MISSING_TYPE;
    }

    if (!event.hasOwnProperty('message') || hdb_utils.isEmpty(event.message)) {
        return IPC_ERRORS.MISSING_MSG;
    }

    if (hdb_terms.IPC_EVENT_TYPES[event.type.toUpperCase()] === undefined) {
        return IPC_ERRORS.INVALID_EVENT(event.type);
    }
}