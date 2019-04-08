#!/usr/bin/env node
"use strict";
const ps_list = require("ps-list");
const hdb_terms = require('../utility/hdbTerms');
const os = require('os');

module.exports = {
    stop: stop
};

/**
 * Stop all instances of harperDB running on the system.  If the current logged in user is not root or the installed user
 * this will fail.
 */
function stop(callback) {
    let curr_user = os.userInfo();
    console.log("Stopping HarperDB.");

    runningHarperInstances().then( instances => {
        if(instances.length === 0) {
            console.log("No instances of HarperDB are running.");
            return callback(null);
        }

        instances.forEach(function killProcs(proc) {
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
    }).catch( err => {
        console.log(err);
        return callback(err);
    });
}

async function runningHarperInstances() {
    try {
        const list = await ps_list();
        let hdb_list = [];

        if(!list) {
            console.log("No instances of HarperDB are running.");
            return hdb_list;
        }

        for (let i = 0; i < list.length; i++) {
            let running_process = list[i];

            if (running_process.cmd.includes(hdb_terms.HDB_PROC_NAME)) {
                hdb_list.push(running_process);
            }
        }

        return hdb_list;

    } catch(err) {
        throw err;
    }
}
