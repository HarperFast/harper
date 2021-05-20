'use strict';

const hdb_terms = require('../../utility/hdbTerms');
const hdb_logger = require('../../utility/logging/harper_logger');
const enterprise_util = require('../../utility/enterpriseInitialization');
const { restartHDB } = require('../../server/clustering/clusterUtilities');
const children_stopped_event = require('../../events/AllChildrenStoppedEvent');
const { validateEvent } = require('../../server/ipc/utility/ipcUtils');
const util = require('util');
const child_process = require('child_process');
const path = require('path');


let started_forks = {};
let child_event_count = 0;

const hdb_parent_ipc_handlers = {
    [hdb_terms.IPC_EVENT_TYPES.CHILD_STARTED]: childStartedHandler,
    [hdb_terms.IPC_EVENT_TYPES.CHILD_STOPPED]: childStoppedHandler,
    [hdb_terms.IPC_EVENT_TYPES.RESTART]: restartHandler
};

async function childStartedHandler(event) {
    const validate = validateEvent(event);
    if (validate) {
        hdb_logger.error(validate);
        return;
    }

    hdb_logger.trace(`Got child started event`);
    if(started_forks[event.message]) {
        hdb_logger.warn(`Got a duplicate child started event for pid ${event.message}`);
    } else {
        child_event_count++;
        hdb_logger.info(`Received ${child_event_count} child started event(s).`);
        started_forks[event.message] = true;
        if (Object.keys(started_forks).length === global.forks.length) {
            //all children are started, kick off enterprise.
            child_event_count = 0;

            hdb_logger.trace('clusterUtilities kickOffEnterprise');
            try {
                if(global.clustering_on === true) {
                    await enterprise_util.kickOffEnterprise();
                    hdb_logger.info('HDB server children initialized');
                }
            } catch (err) {
                hdb_logger.error(`HDB server children failed to start: ${err}`);
            }
        }
    }
}

function childStoppedHandler(event) {
    hdb_logger.trace(`Got child stopped event`);
    if(started_forks[event.message] === false) {
        hdb_logger.warn(`Got a duplicate child started event for pid ${event.message}`);
    } else {
        child_event_count++;
        hdb_logger.info(`Received ${child_event_count} child stopped event(s).`);
        hdb_logger.info(`started forks: ${util.inspect(started_forks)}`);
        started_forks[event.message] = false;
        for(let fork of Object.keys(started_forks)) {
            // We still have children running, break;
            if(started_forks[fork] === true) {
                return;
            }
        }
        //All children are stopped, emit event
        hdb_logger.debug(`All children stopped, restarting.`);
        child_event_count = 0;
        children_stopped_event.allChildrenStoppedEmitter.emit(children_stopped_event.EVENT_NAME, new children_stopped_event.AllChildrenStoppedMessage());
    }
}

function restartHandler(event) {
    hdb_logger.info('Received restart event.');

    if(event.message) {
        restartHDB();
        hdb_logger.info('Force shutting down processes.');
        return;
    }

    // Try to shutdown all SocketServer and SocketClient connections.
    if(global.cluster_server) {
        // Close server will emit an event once it is done
        global.cluster_server.closeServer();
    }
}

module.exports = hdb_parent_ipc_handlers;