"use strict";

const env = require('../../../utility/environment/environmentManager');
env.initSync();
const terms = require('../../../utility/hdbTerms');

const { HDB_SETTINGS_NAMES, HDB_SETTINGS_DEFAULT_VALUES } = terms;
const PROPS_HEADER_TIMEOUT_KEY = HDB_SETTINGS_NAMES.SERVER_HEADERS_TIMEOUT_KEY;
const DEFAULT_HEADER_TIMEOUT = HDB_SETTINGS_DEFAULT_VALUES[PROPS_HEADER_TIMEOUT_KEY];

/**
 * Returns header timeout value from config file or, if not entered, the default value
 *
 * @returns {*}
 */
function getHeaderTimeoutConfig() {
  return env.get(PROPS_HEADER_TIMEOUT_KEY) ? env.get(PROPS_HEADER_TIMEOUT_KEY) : DEFAULT_HEADER_TIMEOUT;
}

module.exports = getHeaderTimeoutConfig;
