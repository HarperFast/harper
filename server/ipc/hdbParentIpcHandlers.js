'use strict';

const hdb_terms = require('../../utility/hdbTerms');
const hdb_logger = require('../../utility/logging/harper_logger');
const enterprise_util = require('../../utility/enterpriseInitialization');
const { restartHDB } = require('../../server/clustering/clusterUtilities');
const children_stopped_event = require('../../events/AllChildrenStoppedEvent');
const { validateEvent } = require('../../server/ipc/utility/ipcUtils');
const util = require('util');

let started_forks = {};
let child_event_count = 0;

const hdb_parent_ipc_handlers = {
    [hdb_terms.IPC_EVENT_TYPES.CHILD_STARTED]: childStartedHandler,
    [hdb_terms.IPC_EVENT_TYPES.CHILD_STOPPED]: childStoppedHandler,
    [hdb_terms.IPC_EVENT_TYPES.RESTART]: restartHandler
};

/**
 * Checks that all HDB child processes have started. Starts SC if clustering true.
 * @param event
 * @returns {Promise<void>}
 */
async function childStartedHandler(event) {
    if (global.service === event.message.service) {
        const validate = validateEvent(event);
        if (validate) {
            hdb_logger.error(validate);
            return;
        }

        hdb_logger.trace(`HDB parent with ${hdb_terms.HDB_IPC_CLIENT_PREFIX}${process.pid} received child_started event: ${JSON.stringify(event)}`);

        if(started_forks[event.message.originator]) {
            hdb_logger.warn(`Got a duplicate child started event for pid ${event.message.originator}`);
        } else {
            child_event_count++;
            hdb_logger.info(`Received ${child_event_count} child started event(s).`);
            started_forks[event.message.originator] = true;
            if (Object.keys(started_forks).length === global.forks.length) {
                //all children are started, kick off enterprise.
                child_event_count = 0;

                hdb_logger.trace('childStartedHandler kickOffEnterprise');
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
}

/**
 * Makes sure all HDB child processes have stopped. Used by restart.
 * @param event
 */
function childStoppedHandler(event) {
    if (global.service === event.message.service) {
        const validate = validateEvent(event);
        if (validate) {
            hdb_logger.error(validate);
            return;
        }

        hdb_logger.trace(`HDB parent with ${hdb_terms.HDB_IPC_CLIENT_PREFIX}${process.pid} received child_stopped event: ${JSON.stringify(event)}`);
        if(started_forks[event.message.originator] === false) {
            hdb_logger.warn(`Got a duplicate child stopped event for pid ${event.message.originator}`);
        } else {
            child_event_count++;
            hdb_logger.info(`Received ${child_event_count} child stopped event(s).`);
            hdb_logger.info(`started forks: ${util.inspect(started_forks)}`);
            started_forks[event.message.originator] = false;
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
}

/**
 * restarts HDB
 * @param event
 */
function restartHandler(event) {
    const validate = validateEvent(event);
    if (validate) {
        hdb_logger.error(validate);
        return;
    }

    hdb_logger.trace(`HDB parent with ${hdb_terms.HDB_IPC_CLIENT_PREFIX}${process.pid} received restart event: ${JSON.stringify(event)}`);

    // Only the core process needs to call a forced restart.
    if(event.message.force === true && global.service === hdb_terms.SERVICES.HDB_CORE) {
        restartHDB();
        hdb_logger.info('Force shutting down processes.');
        return;
    } else if(event.message.force === true) {
        return;
    }

    // Try to shutdown all SocketServer and SocketClient connections.
    if(global.cluster_server) {
        // Close server will emit an event once it is done
        global.cluster_server.closeServer();
    }
}

module.exports = hdb_parent_ipc_handlers;