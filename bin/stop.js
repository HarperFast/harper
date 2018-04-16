#!/usr/bin/env node
"use strict";
const ps = require('find-process');
const hdb_terms = require('../utility/hdbTerms');
const os = require('os');

module.exports = {
    stop: stop
}

/**
 * Stop all instances of harperDB running on the system.  If the current logged in user is not root or the installed user
 * this will fail.
 */
function stop(callback) {
    let curr_user = os.userInfo();
    ps('name', hdb_terms.HDB_PROC_NAME).then(function (list) {
        if( list.length === 0 ) {
            console.log("No instances of HarperDB are running.");
            return callback(null);
        } else {
            list.forEach(function killProcs(proc) {
                // Note we are doing loose equality (==) rather than strict
                // equality here, as find-process returns the uid as a string.  No point in spending time converting it.
                // if curr_user.uid is 0, the user has run stop using sudo or logged in as root.
                if(curr_user.uid == 0 || proc.uid == curr_user.uid) {
                    process.kill(proc.pid);
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



