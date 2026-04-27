'use strict';

import * as hdbUtils from '../common_utils.js';
import * as log from './harper_logger.js';
import { handleHDBError, hdbErrors } from '../errors/hdbError.js';
const { HTTP_STATUS_CODES } = hdbErrors;
import {
	readTransactionLogValidator,
	deleteTransactionLogsBeforeValidator,
} from '../../validation/transactionLogValidator.js';
import * as harperBridge from '../../dataLayer/harperBridge/harperBridge.js';

export {
	readTransactionLog,
	deleteTransactionLogsBefore,
};

async function readTransactionLog(req: any): Promise<any> {
	const validation = readTransactionLogValidator(req);
	if (validation) {
		throw handleHDBError(validation, validation.message, HTTP_STATUS_CODES.BAD_REQUEST, undefined, undefined, true);
	}

	req.database = req.database ?? req.schema ?? 'data';
	const invalidSchemaTableMsg = hdbUtils.checkSchemaTableExist(req.database, req.table);
	if (invalidSchemaTableMsg) {
		throw handleHDBError(new Error(), invalidSchemaTableMsg, HTTP_STATUS_CODES.NOT_FOUND, undefined, undefined, true);
	}

	log.info('Reading Harper logs used by Plexus');

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
async function deleteTransactionLogsBefore(req: any): Promise<string> {
	const validation = deleteTransactionLogsBeforeValidator(req);
	if (validation.error) {
		const err = new Error(validation.error.message);
		throw handleHDBError(err, err.message, HTTP_STATUS_CODES.BAD_REQUEST, undefined, undefined, true);
	}

	const { value } = validation;
	value.database = value.database ?? value.schema ?? 'data';

	log.info('Delete transaction logs called for Plexus');
	return harperBridge.deleteTransactionLogsBefore(value);
}
