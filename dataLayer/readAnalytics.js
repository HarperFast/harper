'use strict';

const harperBridge = require('./harperBridge/harperBridge.js');
// eslint-disable-next-line no-unused-vars
const hdbUtils = require('../utility/common_utils.js');
const hdbTerms = require('../utility/hdbTerms.ts');
const envMgr = require('../utility/environment/environmentManager.js');
const { handleHDBError, hdbErrors } = require('../utility/errors/hdbError.js');
const { HDB_ERROR_MSGS, HTTP_STATUS_CODES } = hdbErrors;

const SEARCH_TYPES = Object.values(hdbTerms.READ_AUDIT_LOG_SEARCH_TYPES_ENUM);
const LOG_NOT_ENABLED_ERR = 'To use this operation audit log must be enabled in harperdb-config.yaml';

module.exports = readAnalytics;

/**
 *
 * @param readAnalyticsObject
 * @returns {Promise<void>}
 */
async function readAnalytics(readAuditLogObject) {
	if (!envMgr.get(hdbTerms.CONFIG_PARAMS.ANALYTICS)) {
		throw handleHDBError(
			new Error(),
			LOG_NOT_ENABLED_ERR,
			HTTP_STATUS_CODES.BAD_REQUEST,
			hdbTerms.LOG_LEVELS.ERROR,
			LOG_NOT_ENABLED_ERR,
			true
		);
	}

	return await harperBridge.readAnalytics(readAuditLogObject);
}
