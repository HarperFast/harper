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

class ApiLimiterIF {
    constructor(limiter_name, rate_limit, reset_duration_seconds, timeout_ms) {
        this.limiter_name = limiter_name;
        this.rate_limit = rate_limit;
        this.reset_duration_seconds = reset_duration_seconds;
        this.timeout_ms = timeout_ms;
    }

    async rateLimiter(req, res, next) {
        throw new Error('Not Implemented');
    }

    async saveApiCallCount() {
        throw new Error('Not Implemented');
    }

    async readCallCount(loc) {
        throw new Error('Not Implemented');
    }
}

module.exports = ApiLimiterIF;