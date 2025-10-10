'use strict';

const hdbTerms = require('../hdbTerms.ts');
const hdbUtils = require('../common_utils.js');
const envMgr = require('../environment/environmentManager.js');
const cryptoHash = require('../../security/cryptoHash.js');
const log = require('./harper_logger.js');
const { handleHDBError, hdbErrors } = require('../errors/hdbError.js');
const { HTTP_STATUS_CODES } = hdbErrors;
const {
	readTransactionLogValidator,
	deleteTransactionLogsBeforeValidator,
} = require('../../validation/transactionLogValidator.js');
const harperBridge = require('../../dataLayer/harperBridge/harperBridge.js');

const PARTIAL_DELETE_SUCCESS_MSG = 'Logs successfully deleted from transaction log.';
const ALL_DELETE_SUCCESS_MSG = 'All logs successfully deleted from transaction log.';

module.exports = {
	readTransactionLog,
	deleteTransactionLogsBefore,
};

async function readTransactionLog(req) {
	const validation = readTransactionLogValidator(req);
	if (validation) {
		throw handleHDBError(validation, validation.message, HTTP_STATUS_CODES.BAD_REQUEST, undefined, undefined, true);
	}

	req.database = req.database ?? req.schema ?? 'data';
	const invalidSchemaTableMsg = hdbUtils.checkSchemaTableExist(req.database, req.table);
	if (invalidSchemaTableMsg) {
		throw handleHDBError(new Error(), invalidSchemaTableMsg, HTTP_STATUS_CODES.NOT_FOUND, undefined, undefined, true);
	}

	log.info('Reading HarperDB logs used by Plexus');

	if (req.from || req.to) {
		req.search_type = 'timestamp';
		req.search_values = [req.from ?? 0];
		if (req.to) req.search_values[1] = req.to;
	}

	return harperBridge.readAuditLog(req);
}

/**
 * Deletes messages from a tables local stream (persistence layer),
 * where all transactions against that table are stored.
 * @param req - {schema, table, timestamp}
 * @returns {Promise<string>}
 */
async function deleteTransactionLogsBefore(req) {
	const validation = deleteTransactionLogsBeforeValidator(req);
	if (validation) {
		throw handleHDBError(validation, validation.message, HTTP_STATUS_CODES.BAD_REQUEST, undefined, undefined, true);
	}

	req.database = req.database ?? req.schema ?? 'data';

	log.info('Delete transaction logs called for Plexus');
	return harperBridge.deleteAuditLogsBefore(req);
}
