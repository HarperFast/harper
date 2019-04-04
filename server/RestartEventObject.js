"use strict";

const hdb_term = require('../utility/hdbTerms');
const log = require('../utility/logging/harper_logger');

/**
 * This class represents a Job as it resides in the jobs table.
 */
class RestartEventObject {
    constructor() {
        this.sio_connections_stopped = false;
        this.express_connections_stopped = false;
    }

    isReadyForRestart() {
        // We want to ignore this if clustering is not established.  We need to constantly check it in case connections
        // are added after startup.
        if(!global.cluster_server) {
            this.sio_connections_stopped = true;
        }
        log.debug(`Server connections stopped: ${this.sio_connections_stopped}`);
        log.debug(`Express connections stopped: ${this.express_connections_stopped}`);
        return (this.sio_connections_stopped && this.express_connections_stopped);
    }
}

module.exports = RestartEventObject;