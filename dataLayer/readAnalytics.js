'use strict';

const harperBridge = require('./harperBridge/harperBridge');
// eslint-disable-next-line no-unused-vars
const hdb_utils = require('../utility/common_utils');
const hdb_terms = require('../utility/hdbTerms');
const env_mgr = require('../utility/environment/environmentManager');
const { handleHDBError, hdb_errors } = require('../utility/errors/hdbError');
const { HDB_ERROR_MSGS, HTTP_STATUS_CODES } = hdb_errors;

const SEARCH_TYPES = Object.values(hdb_terms.READ_AUDIT_LOG_SEARCH_TYPES_ENUM);
const LOG_NOT_ENABLED_ERR = 'To use this operation audit log must be enabled in harperdb-config.yaml';

module.exports = readAnalytics;

/**
 *
 * @param read_analytics_object
 * @returns {Promise<void>}
 */
async function readAnalytics(read_audit_log_object) {
	if (!env_mgr.get(hdb_terms.CONFIG_PARAMS.ANALYTICS)) {
		throw handleHDBError(
			new Error(),
			LOG_NOT_ENABLED_ERR,
			HTTP_STATUS_CODES.BAD_REQUEST,
			hdb_terms.LOG_LEVELS.ERROR,
			LOG_NOT_ENABLED_ERR,
			true
		);
	}

	return await harperBridge.readAnalytics(read_audit_log_object);
}
