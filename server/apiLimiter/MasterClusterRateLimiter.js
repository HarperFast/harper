"use strict";

const log = require('../../utility/logging/harper_logger');
const crypto = require('crypto');
const registration_handler = require('../../utility/registration/registrationHandler');
const path = require('path');
const fs = require('fs-extra');
const CounterObject = require('./CounterObject');
const terms = require('../../utility/hdbTerms');
const {inspect} = require('util');
const os = require('os');
const hdb_util = require('../../utility/common_utils');
/*
* This class contains helper functions for interacting with an RateLimiterClusterMaster object.  There is no defined
* API for the Master in the API.
*/
const HOME_HDB_PATH = path.join(os.homedir(), terms.HDB_HOME_DIR_NAME);

/**
 * Store the curr api counter_object to path
 * @param counter_object - A CounterObject type with the counter_object to store
 * @param path - The path to store to
 * @returns {Promise<void>}
 */
async function saveApiCallCount(counter_object, loc) {
    try {
        if(counter_object.count === 0) {
            return;
        }
        log.trace('Store call counter_object');
        let finger = await registration_handler.getFingerprint();
        let cipher = crypto.createCipher('aes192', finger);
        let encrypted_exp = cipher.update(JSON.stringify(counter_object), 'utf8', 'hex');
        encrypted_exp += cipher.final('hex');

        let backup_loc = path.join(`/tmp`, finger, `.${finger}1`);
        await fs.writeFile(loc, encrypted_exp, {encoding: 'utf8', mode: terms.HDB_FILE_PERMISSIONS}).catch((err) => {
            log.error(`Error writing count file to ${loc}`);
            log.error(err);
            throw new Error('There was an error writing the counter_object');
        });

        await fs.outputFile(backup_loc, encrypted_exp, {
            encoding: 'utf8',
            mode: terms.HDB_FILE_PERMISSIONS
        });
    } catch(err) {
        log.error('Error saving calls');
        log.error(err);
    }
}

/**
 * Reads and decrypts stored limit calls.
 * @param loc
 * @param fingerprint
 * @returns {number|any}
 */
function readCFile(loc, fingerprint) {
    try {
        let result = fs.readFileSync(loc);
        let decipher = crypto.createDecipher('aes192', fingerprint);
        let decrypted = decipher.update(result.toString(), 'hex', 'utf8');
        decrypted.trim();
        decrypted += decipher.final('utf8');

        if (isNaN(decrypted)) {
            let count_obj = JSON.parse(decrypted);
            return count_obj;
        }
        fs.unlink(loc);
    } catch(err) {
        log.error('Error reading count');
        return 0;
    }
}

/**
 * Reads the stored limit counts to establish a somewhat accurate limit on API calls.
 * @returns {Promise<*>}
 */
async function readLimitFiles() {
    let vals = [];
    let fingerprint = await registration_handler.getFingerprint();
    try {
        let val1 = await readCFile(path.join(HOME_HDB_PATH, terms.LIMIT_COUNT_NAME), fingerprint);
        if(val1 && val1.count) {
            vals.push(val1);
        }
    } catch (err) {
        log.error(err);
    }

    try {
        let val2 = await readCFile(path.join(`/tmp`, fingerprint, `.${fingerprint}1`), fingerprint);
        if(val2 && val2.count) {
            vals.push(val2);
        }
    } catch (err) {
        log.error(err);
    }
    let largest;
    if(vals.length > 0) {
        largest = vals[0];
        vals.forEach((val) => {
            if (val && val.count && val.count > largest.count) {
                largest = val;
            }
        });
    }
    return largest;
}

/**
 * Will attempt to pull the rate limit from the master parameter.  Returns that value if found, undefined if not.
 * @param master_limiter - the initialized MasterClusterRateLimiter object.
 * @returns {integer|udefined}
 */
function getCallCount(master_limiter) {
    let limit = undefined;
    try {
        let limit_key = hdb_util.getLimitKey();
        limit = master_limiter._rateLimiters[hdb_util.getLimitKey()]._memoryStorage._storage[`${limit_key}:${limit_key}`]._value;
    } catch(err) {
        log.debug("failed to pull limits");
    }
    return limit;
}

/**
 * Will attempt to set the rate limit from the master parameter.  Returns true if successful, false if not.
 * @param master_limiter - the initialized MasterClusterRateLimiter object.
 * @returns {boolean}
 */
function setCallCount(master_limiter, new_value) {
    let success = true;
    try {
        let limit_key = hdb_util.getLimitKey();
        // This goes against the design of the limiter, but we have no way around forcing the limit value.  If we use the child limiter.penalty(), all children
        // would read the file and penalize resulting in a 4x penalty.  So we just hack around the problem here.

        master_limiter._rateLimiters[hdb_util.getLimitKey()]._memoryStorage._storage[`${limit_key}:${limit_key}`]._value = new_value;
        return true;
    } catch(err) {
        log.debug("failed to pull limits");
    }
    return false;
}

module.exports = {
    saveApiCallCount,
    readLimitFiles,
    getCallCount,
    setCallCount
};

