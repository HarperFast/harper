#!/usr/bin/env node
"use strict";
const ps_list = require('../utility/psList');
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

    ps_list.findPs(hdb_terms.HDB_PROC_NAME).then(harperdb_instances => {

        if(harperdb_instances.length === 0) {
            console.log("No instances of HarperDB are running.");
            return callback(null);
        } else {
            harperdb_instances.forEach(function killProcs(proc) {
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
        }

        return callback(null);

    }).catch( function stopErr(err) {
        if(err) {
            console.error(err);
            return callback(err);
        }
    });
}
