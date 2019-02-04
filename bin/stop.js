#!/usr/bin/env node
"use strict";
const ps = require('find-process');
const hdb_terms = require('../utility/hdbTerms');
const os = require('os');
const log = require('../utility/logging/harper_logger');
const signal = require('../utility/signalling');

module.exports = {
    stop: stop,
    restartProcesses: restartProcesses
};

/**
 * Stop all instances of harperDB running on the system.  If the current logged in user is not root or the installed user
 * this will fail.
 */
function stop(callback) {
    let curr_user = os.userInfo();
    console.log("Stopping HarperDB.")
    ps('name', hdb_terms.HDB_PROC_NAME).then(function (list) {
        if( list.length === 0 ) {
            console.log("No instances of HarperDB are running.");
            return callback(null);
        }
        list.forEach(function killProcs(proc) {
            // Note we are doing loose equality (==) rather than strict
            // equality here, as find-process returns the uid as a string.  No point in spending time converting it.
            // if curr_user.uid is 0, the user has run stop using sudo or logged in as root.
            if(curr_user.uid == 0 || proc.uid == curr_user.uid) {
                try {
                    process.kill(proc.pid);
                } catch (e) {
                    console.error(e);
                }
            }
        });
        return callback(null);
    }).catch( function stopErr(err) {
        if(err) {
            console.error(err);
            return callback(err);
        }
    });
}

function restartProcesses(json_message, callback) {
    try {
        signal.signalRestart(json_message.force_restart, () => {
            return callback(null, 'Sent restart signal.');
        });
    } catch(err) {
        log.error(`There was an error getting the fingerprint for this machine ${err}`);
        return callback(err, null);
    }
}

