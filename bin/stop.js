"use strict";
const ps_list = require('../utility/psList');
const hdb_terms = require('../utility/hdbTerms');
const os = require('os');
const async_set_timeout = require('util').promisify(setTimeout);
const log = require('../utility/logging/harper_logger');
const signal = require('../utility/signalling');

const HDB_PROC_END_TIMEOUT = 100;
const RESTART_RESPONSE_SOFT = `Restarting HarperDB. This may take up to ${hdb_terms.RESTART_TIMEOUT_MS/1000} seconds.`;
const RESTART_RESPONSE_HARD = `Force restarting HarperDB`;
const CHECK_PROCS_LOOP_LIMIT = 5;

module.exports = {
    stop: stop,
    restartProcesses: restartProcesses
};

/**
 * Send a signal to the master process that HDB needs to be restarted.
 * @param json_message
 * @returns {Promise}
 */
async function restartProcesses(json_message) {
    if(!json_message.force) {
        json_message.force = false;
    }
    try {
        if (json_message.force === 'true') {
            signal.signalRestart(json_message.force);
            return RESTART_RESPONSE_HARD;
        }
        signal.signalRestart(json_message.force);
        return RESTART_RESPONSE_SOFT;
    } catch(err) {
        let msg = `There was an error restarting HarperDB. ${err}`;
        log.error(msg);
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
        await killProcs(hdb_terms.HDB_PROC_NAME, hdb_terms.HDB_PROC_DESCRIPTOR);
        log.info(`Stopping ${hdb_terms.HDB_PROC_NAME} - ${hdb_terms.HDB_PROC_DESCRIPTOR}.`);
        await killProcs(hdb_terms.SC_PROC_NAME, hdb_terms.SC_PROC_DESCRIPTOR);
        log.info(`Stopping ${hdb_terms.SC_PROC_NAME} - ${hdb_terms.SC_PROC_DESCRIPTOR}.`);
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
        log.notify(`HarperDB has stopped`);
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
        log.error('Unable to stop all the processes');
        console.error('Unable to stop all the processes');
    }
}
