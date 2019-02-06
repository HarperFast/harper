"use strict";
const signal = require('../utility/signalling');
const log = require('../utility/logging/harper_logger');

/** This module was created because we could not have restartProcess residing in stop.js, as it requires signalling
 * which requires gobalSchema, which requires search, which tries to instantiate a properties reader. This prevents
 * the install from working correctly.  Once we use the environment manager everywhere, we could consider moving this
 * back into stop.js.
 */

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

module.exports = {
    restartProcesses: restartProcesses
};