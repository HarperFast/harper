"use strict";
const ps_list = require('../utility/psList');
const hdb_terms = require('../utility/hdbTerms');
const os = require('os');
const async_set_timeout = require('util').promisify(setTimeout);
const log = require('../utility/logging/harper_logger');
const final_logger = log.finalLogger();
const signalling = require('../utility/signalling');
const { RestartMsg } = require('../server/ipc/utility/ipcUtils');
const hdb_utils = require('../utility/common_utils');
const path = require('path');
const { handleHDBError, hdb_errors } = require('../utility/errors/hdbError');
const { HTTP_STATUS_CODES } = hdb_errors;

const HDB_PROC_END_TIMEOUT = 100;
const RESTART_RESPONSE_SOFT = `Restarting HarperDB. This may take up to ${hdb_terms.RESTART_TIMEOUT_MS/1000} seconds.`;
const RESTART_RESPONSE_HARD = `Force restarting HarperDB`;
const RESTART_RESPONSE_CF = 'Restarting custom_functions';
const CHECK_PROCS_LOOP_LIMIT = 5;
const IPC_STOP_ERR = 'Error stopping the HDB IPC server. Check log for more detail.';
const CF_STOP_ERR = 'Error stopping the Custom Functions server. Check log for more detail.';
const NO_FORCE_ALLOWED_ERR = 'Force restarts are not available with service restart';
const INVALID_SERVICE_ERR = 'Invalid service';
const HDB_SERVER_CWD = path.resolve(__dirname, '../server');
const SC_SERVER_CWD = path.resolve(__dirname, '../server/socketcluster');
const IPC_SERVER_CWD = path.resolve(__dirname, '../server/ipc');
const CF_SERVER_CWD = path.resolve(__dirname, '../server/customFunctions');

module.exports = {
    stop,
    restartProcesses
};

/**
 * Send a signal to the parent process that HDB needs to be restarted.
 * @param json_message
 * @returns {Promise}
 */
async function restartProcesses(json_message) {
    const is_forced_restart = json_message.force === true || json_message.force === 'true';
    if (is_forced_restart && !hdb_utils.isEmpty(json_message.service)) {
        throw handleHDBError(new Error(), NO_FORCE_ALLOWED_ERR, HTTP_STATUS_CODES.BAD_REQUEST);
    }

    if (!hdb_utils.isEmpty(json_message.service) && json_message.service !== hdb_terms.SERVICES.CUSTOM_FUNCTIONS) {
        throw handleHDBError(new Error(), INVALID_SERVICE_ERR, HTTP_STATUS_CODES.BAD_REQUEST);
    }

    if(!json_message.force) {
        json_message.force = false;
    }

    try {
        if (is_forced_restart) {
            signalling.signalRestart(new RestartMsg(process.pid, true));
            return RESTART_RESPONSE_HARD;
        }

        if (json_message.service === hdb_terms.SERVICES.CUSTOM_FUNCTIONS) {
            signalling.signalRestart(new RestartMsg(process.pid, false, json_message.service));
            return RESTART_RESPONSE_CF;
        }

        signalling.signalRestart(new RestartMsg(process.pid, false));

        return RESTART_RESPONSE_SOFT;
    } catch(err) {
        let msg = `There was an error restarting HarperDB. ${err}`;
        final_logger.error(msg);
        return msg;
    }
}

/**
 * Stop all instances of harperDB running on the system.  If the current logged in user is not root or the installed user
 * this will fail.
 */
async function stop() {
    console.log("Stopping HarperDB.");
    try {
        final_logger.info(`Stopping ${hdb_terms.SC_PROC_NAME} - ${hdb_terms.SC_PROC_DESCRIPTOR}.`);
        await killProcs(path.join(SC_SERVER_CWD, hdb_terms.SC_PROC_NAME), hdb_terms.SC_PROC_DESCRIPTOR);
        final_logger.info(`Stopping ${hdb_terms.HDB_PROC_NAME} - ${hdb_terms.HDB_PROC_DESCRIPTOR}.`);
        await killProcs(path.join(HDB_SERVER_CWD, hdb_terms.HDB_PROC_NAME), hdb_terms.HDB_PROC_DESCRIPTOR);

        try {
            final_logger.info(`Stopping ${hdb_terms.HDB_IPC_SERVER}`);
            await hdb_utils.stopProcess(path.join(IPC_SERVER_CWD, hdb_terms.IPC_SERVER_MODULE));
        } catch(err) {
            console.error(IPC_STOP_ERR);
            final_logger.error(err);
        }

        try {
            final_logger.info(`Stopping ${hdb_terms.CUSTOM_FUNCTION_PROC_NAME}`);
            await hdb_utils.stopProcess(path.join(CF_SERVER_CWD, hdb_terms.CUSTOM_FUNCTION_PROC_NAME));
        } catch(err) {
            console.error(CF_STOP_ERR);
            final_logger.error(err);
        }

        final_logger.notify(`HarperDB has stopped`);
    } catch(err){
        console.error(err);
        throw err;
    }
}

async function killProcs(proc_name, descriptor){
    try {
        let curr_user = os.userInfo();
        let harperdb_instances = await ps_list.findPs(proc_name);
        if(harperdb_instances.length === 0) {
            console.log(`No instances of ${descriptor} are running.`);
            return;
        }

        harperdb_instances.forEach((proc) => {
            // Note we are doing loose equality (==) rather than strict
            // equality here, as find-process returns the uid as a string.  No point in spending time converting it.
            // if curr_user.uid is 0, the user has run stop using sudo or logged in as root.
            if (curr_user.uid == 0 || proc.uid == curr_user.uid) {
                try {
                    process.kill(proc.pid);
                } catch (err) {
                    console.error(err);
                }
            }
        });

        await checkHdbProcsEnd(proc_name);
    }catch( err) {
        throw err;
    }
}

/**
 * Verifies all processes have stopped before fulfilling promise.
 * @returns {Promise<void>}
 */
async function checkHdbProcsEnd(proc_name){
    let go_on = true;
    let x = 0;
    do{
        await async_set_timeout(HDB_PROC_END_TIMEOUT * x++);

        let instances = await ps_list.findPs(proc_name);
        if(instances.length === 0) {
            go_on = false;
        }
    } while(go_on && x < CHECK_PROCS_LOOP_LIMIT);

    if(go_on) {
        final_logger.error('Unable to stop all the processes');
        console.error('Unable to stop all the processes');
    }
}
