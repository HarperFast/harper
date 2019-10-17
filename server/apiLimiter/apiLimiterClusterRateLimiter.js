"use strict";

const rate_limiter_flexible = require('rate-limiter-flexible');
const log = require('../../utility/logging/harper_logger');
const env = require('../../utility/environment/environmentManager');
const license = require('../../utility/registration/hdb_license');
const hdb_util = require('../../utility/common_utils');
const terms = require('../../utility/hdbTerms');
const ApiLimiterIF = require('./ApiLimiterIF');
const CounterObject = require('./CounterObject');
const crypto = require('crypto');
const fs = require('fs-extra');
const registration_handler = require('../../utility/registration/registrationHandler');
const path = require(`path`);
const os = require(`os`);
const moment = require('moment');

const HOME_HDB_PATH = path.join(os.homedir(), terms.HDB_HOME_DIR_NAME);
const RATE_LIMIT_MAX = 2;
const LIMIT_RESET_IN_SECONDS = 86400; // # seconds in a day, will reset after 1 day
const CONSUME_TIMEOUT_IN_MS = 3000;

let limiter = undefined;
let fingerprint = undefined;

function init(limiter_name, rate_limit, reset_duration_seconds, timeout_ms, new_limiter_bool) {
    registration_handler.getFingerprint()
        .then((finger) => {
            fingerprint = finger;
            let largest;
            if(new_limiter_bool === false) {
                let vals = [];

                try {
                    vals.push(readCFile(path.join(HOME_HDB_PATH, terms.LIMIT_COUNT_NAME)));
                } catch (err) {
                    log.error(err);
                }

                try {
                    vals.push(readCFile(path.join(`/tmp`, finger, `.${finger}1`)));
                } catch (err) {
                    log.error(err);
                }

                largest = vals[0];
                vals.forEach((val) => {
                    if (val && val.count && val.count > largest.count) {
                        largest = val;
                    }
                });
            }
            constructLimiter(limiter_name, rate_limit, hdb_util.getStartOfTomorrowInSeconds(), timeout_ms);
            if(largest.count > 0) {
                // This will remove the number of calls read.
                limiter.penalty(hdb_util.getLimitKey(), largest)
                    .then((res) => {
                        log.info(`limits configured`);
                })
                    .catch((err) => {
                       log.error('Error configuring limits');
                       log.error(err);
                    });
            }
        })
        .catch((err) => {
            log.error('Error getting fingerprint.');
            log.error(err);
        });
}

function readCFile(loc) {
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

function constructLimiter(limiter_name, rate_limit, reset_duration_seconds, timeout_ms) {
    try {
        limiter = new rate_limiter_flexible.RateLimiterCluster({
            keyPrefix: limiter_name,
            points: rate_limit,
            duration: reset_duration_seconds,
            timeoutMs: timeout_ms
        });
    } catch(err) {
        log.error('Error constructing limiter');
        log.error(err);
    }
}

/**
 * Express Middleware implementation of the rate limiter using rate-limiter-flexible
 * @param req - inbound request
 * @param res - outbound response
 * @param next - next function for express
 * @returns {Promise<*>}
 */
async function rateLimiter(req, res, next) {
    try {
        let result = await limiter.consume(hdb_util.getLimitKey());
        //await saveApiCallCount(result._consumedPoints, path.join(HOME_HDB_PATH, terms.LIMIT_COUNT_NAME));
        return next();
    } catch(err) {
        log.notify(`You have reached your API limit within 24 hours. ${terms.SUPPORT_HELP_MSG}`);
        res.status(terms.HTTP_STATUS_CODES.TOO_MANY_REQUESTS).send({error: `You have reached your request limit of ${RATE_LIMIT_MAX}. Your request limit will reset in ${Math.floor((err._msBeforeNext/1000)/3600)} hours.`});
    }
}

/**
 * Store the curr api count to path
 * @param count - A CounterObject type with the count to store
 * @param path - The path to store to
 * @returns {Promise<void>}
 */
async function saveApiCallCount(count, loc) {
    try {
        let finger = fingerprint;
        let cipher = crypto.createCipher('aes192', finger);
        let encrypted_exp = cipher.update(JSON.stringify(new CounterObject(count)), 'utf8', 'hex');
        encrypted_exp += cipher.final('hex');

        let backup_loc = path.join(`/tmp`, finger, `.${finger}1`);

        await fs.writeFile(loc, encrypted_exp, {encoding: 'utf8', mode: terms.HDB_FILE_PERMISSIONS}).catch((err) => {
            log.error(`Error writing count file to ${loc}`);
            log.error(err);
            throw new Error('There was an error writing the count');
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

async function removeLimiter(limiter_name_string) {
    log.debug('Remove Limit');
    if(!limiter) {
        log.info('No limiter found');
        return;
    }
    let remove_result = await limiter.delete(limiter_name_string);
    if(remove_result === true) {
        console.log('REMOVED!');
    }
    return remove_result;
}

function createLimiterResetTimeout(limiter_name_string, timout_interval_ms) {
    setTimeout(async (info) => {
        try {
            log.debug('Restoring limits');
            //let points = master_rate_limiter._rateLimiters[`apiclusterlimiter`].points;

        } catch(err) {
            log.log(err);
        }
    }, timout_interval_ms);
}


module.exports = {
    rateLimiter,
    saveApiCallCount,
    readCFile,
    init,
    removeLimiter
};