"use strict";

const rate_limiter_flexible = require('rate-limiter-flexible');
const log = require('../../utility/logging/harper_logger');
const license = require('../../utility/registration/hdb_license');
const hdb_util = require('../../utility/common_utils');
const terms = require('../../utility/hdbTerms');

const RATE_LIMIT_MAX = 2;
const LIMIT_RESET_IN_SECONDS = 86400; // # seconds in a day, will reset after 1 day
const CONSUME_TIMEOUT_IN_MS = 3000;

let limiter = undefined;

/**
 * Initialize a limiter to be used by express to limit number of api calls based on license.
 * @param limiter_name - Limiter name as used to reference it
 * @param rate_limit - The number of API calls defined in license
 * @param reset_duration_seconds - Number of seconds before the limiter rolls over
 * @param timeout_ms - timeout for waiting from response from master.
 * @returns {Promise<void>}
 */
async function init(limiter_name, rate_limit, reset_duration_seconds, timeout_ms) {
    try {
        constructLimiter(limiter_name, rate_limit, hdb_util.getStartOfTomorrowInSeconds(), timeout_ms);
        //initialize the current limiter entry on master so it will be available immediately
        let result = await limiter.consume(hdb_util.getLimitKey());
    } catch(err) {
        log.error('Error getting fingerprint.');
        log.error(err);
    }
}

/**
 * Sends a message to master to construct a limiter
 * @param limiter_name - name of the limiter
 * @param rate_limit - number of API calls before limiter enforces
 * @param reset_duration_seconds - How long in seconds before the limiter rolls over
 * @param timeout_ms - timeout before response from server
 */
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
        let temp = hdb_util.getLimitKey();
        let result = await limiter.consume(hdb_util.getLimitKey());
        //await saveApiCallCount(result._consumedPoints, path.join(HOME_HDB_PATH, terms.LIMIT_COUNT_NAME));
        return next();
    } catch(err) {
        log.notify(`You have reached your API limit within 24 hours. ${terms.SUPPORT_HELP_MSG}`);
        res.status(terms.HTTP_STATUS_CODES.TOO_MANY_REQUESTS).send({error: `You have reached your request limit of ${RATE_LIMIT_MAX}. Your request limit will reset in ${Math.floor((err._msBeforeNext/1000)/3600)} hours.`});
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

module.exports = {
    rateLimiter,
    init,
    removeLimiter
};