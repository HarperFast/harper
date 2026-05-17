'use strict';

import _harperBridge from './harperBridge/harperBridge.ts';
// Lazy access to handle import cycle (insert.ts and harperBridge.ts both import each other transitively).
const harperBridge: any = new Proxy({}, { get: (_, p) => (_harperBridge as any)[p] });
// eslint-disable-next-line no-unused-vars
import ReadAuditLogObject from './ReadAuditLogObject.ts';
import * as hdbUtils from '../utility/common_utils.ts';
import * as hdbTerms from '../utility/hdbTerms.ts';
import * as envMgr from '../utility/environment/environmentManager.ts';
import { handleHDBError } from '../utility/errors/hdbError.ts';
import { HDB_ERROR_MSGS, HTTP_STATUS_CODES } from '../utility/errors/commonErrors.ts';

const SEARCH_TYPES = Object.values(hdbTerms.READ_AUDIT_LOG_SEARCH_TYPES_ENUM);
const LOG_NOT_ENABLED_ERR = 'To use this operation audit log must be enabled in harperdb-config.yaml';

/**
 *
 * @param {ReadAuditLogObject} readAuditLogObject
 * @returns {Promise<void>}
 */
export default async function readAuditLog(readAuditLogObject: any) {
	const database = readAuditLogObject.database || readAuditLogObject.schema;
	if (hdbUtils.isEmpty(database)) {
		throw new Error(HDB_ERROR_MSGS.SCHEMA_REQUIRED_ERR);
	}

	if (hdbUtils.isEmpty(readAuditLogObject.table)) {
		throw new Error(HDB_ERROR_MSGS.TABLE_REQUIRED_ERR);
	}

	// system.hdb_secret audit rows carry full record images — i.e. secret envelopes — and
	// read_audit_log is delegable to non-super_user roles via the `operations` allowlist. Table
	// audit itself must stay on (mount_hdb forces audit:true for every system table; on RocksDB it
	// is load-bearing for data retention), so the read surface is blocked instead, regardless of
	// config or role. Secret mutations are separately audited via value-free logger.notify events
	// (components/secretOperations.ts).
	if (
		database === hdbTerms.SYSTEM_SCHEMA_NAME &&
		readAuditLogObject.table === hdbTerms.SYSTEM_TABLE_NAMES.SECRET_TABLE_NAME
	) {
		const msg = `read_audit_log is not supported on ${database}.${readAuditLogObject.table}; secret mutations are audited via structured log events that never contain values`;
		throw handleHDBError(new Error(), msg, HTTP_STATUS_CODES.FORBIDDEN, undefined, undefined, true);
	}

	if (!envMgr.get(hdbTerms.CONFIG_PARAMS.LOGGING_AUDITLOG)) {
		throw handleHDBError(
			new Error(),
			LOG_NOT_ENABLED_ERR,
			HTTP_STATUS_CODES.BAD_REQUEST,
			hdbTerms.LOG_LEVELS.ERROR,
			LOG_NOT_ENABLED_ERR,
			true
		);
	}

	const invalidSchemaTableMsg = hdbUtils.checkSchemaTableExist(database, readAuditLogObject.table);
	if (invalidSchemaTableMsg) {
		throw handleHDBError(
			new Error(),
			invalidSchemaTableMsg,
			HTTP_STATUS_CODES.NOT_FOUND,
			hdbTerms.LOG_LEVELS.ERROR,
			invalidSchemaTableMsg,
			true
		);
	}

	if (!hdbUtils.isEmpty(readAuditLogObject.search_type) && SEARCH_TYPES.indexOf(readAuditLogObject.search_type) < 0) {
		throw new Error(`Invalid searchType '${readAuditLogObject.search_type}'`);
	}

	return await harperBridge.readAuditLog(readAuditLogObject);
}
