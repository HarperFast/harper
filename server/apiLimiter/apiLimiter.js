"use strict";

const rate_limiter_flexible = require('rate-limiter-flexible');
const log = require('../../utility/logging/harper_logger');
const env = require('../../utility/environment/environmentManager');
const license = require('../../utility/registration/hdb_license');
const hdb_util = require('../../utility/common_utils');
const terms = require('../../utility/hdbTerms');

const LICENSE_LIMITER_NAME = 'hdblicenseapilimiter';
// TODO: Change this to be the result of the license
//let RATE_LIMIT_MAX = license.getLicense().api_call;
const RATE_LIMIT_MAX = 2;
const LIMIT_RESET_IN_SECONDS = 86400; // # seconds in a day, will reset after 1 day
const CONSUME_TIMEOUT_IN_MS = 3000;
    /**
 * const rateLimiterMiddleware = (req, res, next) => {
        rate_limiter.consume('localhost',1)
            .then(() => {
                harper_logger.info('Using 1 point');
                next();
            })
            .catch(() => {
                harper_logger.notify(`You have reached your API limit within 24 hours. ${terms.SUPPORT_HELP_MSG}`);
                res.status(429).send('Too Many Requests');
            });
    };
 */

let cluster_rate_limiter = new rate_limiter_flexible.RateLimiterCluster({
    keyPrefix: LICENSE_LIMITER_NAME,
    points: RATE_LIMIT_MAX,
    duration: LIMIT_RESET_IN_SECONDS,
    timeoutMs: CONSUME_TIMEOUT_IN_MS
});

async function rateLimiterMiddleware(req, res, next) {
    try {
        let result = await cluster_rate_limiter.consume('localhost');
        return next();
    } catch(err) {
        log.notify(`You have reached your API limit within 24 hours. ${terms.SUPPORT_HELP_MSG}`);
        res.status(terms.HTTP_STATUS_CODES.TOO_MANY_REQUESTS).send({error: `You have reached your request limit of ${RATE_LIMIT_MAX}. Your request limit will reset in ${Number.precise( (err._msBeforeNext/1000)/3600).toPrecision(2)} hours.`});
    }
}

async function rateLimiter(req, res, next) {
    await rateLimiterMiddleware(req, res, next);
}

module.exports = {
    rateLimiter
};