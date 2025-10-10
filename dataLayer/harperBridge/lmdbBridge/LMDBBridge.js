'use strict';

const log = require('../../../utility/logging/harper_logger.js');
const { handleHDBError } = require('../../../utility/errors/hdbError.js');
const BridgeMethods = require('../BridgeMethods.js');
const lmdbCreateAttribute = require('./lmdbMethods/lmdbCreateAttribute.js');
const lmdbCreateRecords = require('./lmdbMethods/lmdbCreateRecords.js');
const lmdbCreateSchema = require('./lmdbMethods/lmdbCreateSchema.js');
const lmdbDeleteRecords = require('./lmdbMethods/lmdbDeleteRecords.js');
const lmdbGetDataByHash = require('./lmdbMethods/lmdbGetDataByHash.js');
const lmdbSearchByHash = require('./lmdbMethods/lmdbSearchByHash.js');
const lmdbGetDataByValue = require('./lmdbMethods/lmdbGetDataByValue.js');
const lmdbSearchByValue = require('./lmdbMethods/lmdbSearchByValue.js');
const lmdbSearchByConditions = require('./lmdbMethods/lmdbSearchByConditions.js');
const lmdbDropSchema = require('./lmdbMethods/lmdbDropSchema.js');
const lmdbCreateTable = require('./lmdbMethods/lmdbCreateTable.js');
const lmdbUpdateRecords = require('./lmdbMethods/lmdbUpdateRecords.js');
const lmdbUpsertRecords = require('./lmdbMethods/lmdbUpsertRecords.js');
const lmdbDeleteAuditLogsBefore = require('./lmdbMethods/lmdbDeleteAuditLogsBefore.js');
const lmdbDropTable = require('./lmdbMethods/lmdbDropTable.js');
const lmdbDropAttribute = require('./lmdbMethods/lmdbDropAttribute.js');
const lmdbReadAuditLog = require('./lmdbMethods/lmdbReadAuditLog.js');
const lmdbTransaction = require('./lmdbMethods/lmdbTransaction.js');
const lmdbFlush = require('./lmdbMethods/lmdbFlush.js');
const lmdbGetBackup = require('./lmdbMethods/lmdbGetBackup.js');

class LMDBBridge extends BridgeMethods {
	async searchByConditions(searchObject) {
		return lmdbSearchByConditions(searchObject);
	}

	async getDataByHash(searchObject) {
		return await lmdbGetDataByHash(searchObject);
	}

	async searchByHash(searchObject) {
		return await lmdbSearchByHash(searchObject);
	}

	async getDataByValue(searchObject, comparator) {
		return await lmdbGetDataByValue(searchObject, comparator);
	}

	async searchByValue(searchObject) {
		return await lmdbSearchByValue(searchObject);
	}

	async createSchema(schemaCreateObj) {
		return await lmdbCreateSchema(schemaCreateObj);
	}

	async dropSchema(dropSchemaObj) {
		return await lmdbDropSchema(dropSchemaObj);
	}

	async createTable(table, tableCreateObj) {
		return await lmdbCreateTable(table, tableCreateObj);
	}

	async dropTable(dropTableObj) {
		return await lmdbDropTable(dropTableObj);
	}

	async createAttribute(createAttributeObj) {
		return await lmdbCreateAttribute(createAttributeObj);
	}

	async createRecords(insertObj) {
		return await lmdbCreateRecords(insertObj);
	}

	async updateRecords(updateObj) {
		return await lmdbUpdateRecords(updateObj);
	}

	async upsertRecords(upsertObj) {
		try {
			return await lmdbUpsertRecords(upsertObj);
		} catch (err) {
			//NOTE: this method call will either return the HdbError generated below this OR create a new HdbError w/ the
			// default system error msg and 500 code AND log the error caught here (the error log will only happen if the
			// error has not already been handled (i.e. translated and passed as a HdbError)
			throw handleHDBError(err, null, null, log.ERR, err);
		}
	}

	async deleteRecords(deleteObj) {
		return await lmdbDeleteRecords(deleteObj);
	}

	async dropAttribute(dropAttrObj) {
		return await lmdbDropAttribute(dropAttrObj);
	}

	async deleteAuditLogsBefore(deleteObj) {
		return await lmdbDeleteAuditLogsBefore(deleteObj);
	}

	async readAuditLog(readAuditLogObj) {
		return await lmdbReadAuditLog(readAuditLogObj);
	}

	writeTransaction(schema, table, callback) {
		return lmdbTransaction.writeTransaction(schema, table, callback);
	}

	flush(schema, table) {
		return lmdbFlush.flush(schema, table);
	}

	resetReadTxn(schema, table) {
		return lmdbFlush.resetReadTxn(schema, table);
	}
	getBackup(getBackupObj) {
		return lmdbGetBackup(getBackupObj);
	}
}

module.exports = LMDBBridge;
