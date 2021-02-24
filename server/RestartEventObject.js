"use strict";

const log = require('../utility/logging/harper_logger');

/**
 * This class represents a Job as it resides in the jobs table.
 */
class RestartEventObject {
    constructor() {
        this.restart_in_progress = false;
        this.sio_connections_stopped = false;
        this.fastify_connections_stopped = false;
    }

    isReadyForRestart() {
        // We want to ignore this if clustering is not established.  We need to constantly check it in case connections
        // are added after startup.
        if (!global.cluster_server) {
            this.sio_connections_stopped = true;
        }


        log.debug(`Server connections stopped: ${this.sio_connections_stopped}`);
        log.debug(`Fastify connections stopped: ${this.fastify_connections_stopped}`);

        const connections_stopped = this.sio_connections_stopped && this.fastify_connections_stopped;

        if (connections_stopped && !this.restart_in_progress) {
            this.restart_in_progress = true;
            return true;
        } else {
            return false;
        }
    }
}

module.exports = RestartEventObject;
