'use strict';

const hdb_logger = require('../../../utility/logging/harper_logger');

module.exports = {
    sendIpcEvent
};

function sendIpcEvent(event) {
    if (global.hdb_ipc) {
        global.hdb_ipc.emitToServer(event);
    } else {
        hdb_logger.warn(`Tried to send event: ${event} to HDB IPC client but it does not exist`);
    }
}