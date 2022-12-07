'use strict';

const log = require('../../../utility/logging/harper_logger');
const { handleHDBError } = require('../../../utility/errors/hdbError');
const BridgeMethods = require('../BridgeMethods');
const lmdbCreateAttribute = require('./lmdbMethods/lmdbCreateAttribute');
const lmdbCreateRecords = require('./lmdbMethods/lmdbCreateRecords');
const lmdbCreateSchema = require('./lmdbMethods/lmdbCreateSchema');
const lmdbDeleteRecords = require('./lmdbMethods/lmdbDeleteRecords');
const lmdbGetDataByHash = require('./lmdbMethods/lmdbGetDataByHash');
const lmdbSearchByHash = require('./lmdbMethods/lmdbSearchByHash');
const lmdbGetDataByValue = require('./lmdbMethods/lmdbGetDataByValue');
const lmdbSearchByValue = require('./lmdbMethods/lmdbSearchByValue');
const lmdbSearchByConditions = require('./lmdbMethods/lmdbSearchByConditions');
const lmdbDropSchema = require('./lmdbMethods/lmdbDropSchema');
const lmdbCreateTable = require('./lmdbMethods/lmdbCreateTable');
const lmdbUpdateRecords = require('./lmdbMethods/lmdbUpdateRecords');
const lmdbUpsertRecords = require('./lmdbMethods/lmdbUpsertRecords');
const lmdbDeleteRecordsBefore = require('./lmdbMethods/lmdbDeleteRecordsBefore');
const lmdbDeleteAuditLogsBefore = require('./lmdbMethods/lmdbDeleteAuditLogsBefore');
const lmdbDropTable = require('./lmdbMethods/lmdbDropTable');
const lmdbDropAttribute = require('./lmdbMethods/lmdbDropAttribute');
const lmdbReadAuditLog = require('./lmdbMethods/lmdbReadAuditLog');
const lmdbTransaction = require('./lmdbMethods/lmdbTransaction');
const lmdbFlush = require('./lmdbMethods/lmdbFlush');

class LMDBBridge extends BridgeMethods {
	async searchByConditions(search_object) {
		return lmdbSearchByConditions(search_object);
	}

	async getDataByHash(search_object) {
		return await lmdbGetDataByHash(search_object);
	}

	async searchByHash(search_object) {
		return await lmdbSearchByHash(search_object);
	}

	async getDataByValue(search_object, comparator) {
		return await lmdbGetDataByValue(search_object, comparator);
	}

	async searchByValue(search_object) {
		return await lmdbSearchByValue(search_object);
	}

	async createSchema(schema_create_obj) {
		return await lmdbCreateSchema(schema_create_obj);
	}

	async dropSchema(drop_schema_obj) {
		return await lmdbDropSchema(drop_schema_obj);
	}

	async createTable(table, table_create_obj) {
		return await lmdbCreateTable(table, table_create_obj);
	}

	async dropTable(drop_table_obj) {
		return await lmdbDropTable(drop_table_obj);
	}

	async createAttribute(create_attribute_obj) {
		return await lmdbCreateAttribute(create_attribute_obj);
	}

	async createRecords(insert_obj) {
		return await lmdbCreateRecords(insert_obj);
	}

	async updateRecords(update_obj) {
		return await lmdbUpdateRecords(update_obj);
	}

	async upsertRecords(upsert_obj) {
		try {
			return await lmdbUpsertRecords(upsert_obj);
		} catch (err) {
			//NOTE: this method call will either return the HdbError generated below this OR create a new HdbError w/ the
			// default system error msg and 500 code AND log the error caught here (the error log will only happen if the
			// error has not already been handled (i.e. translated and passed as a HdbError)
			throw handleHDBError(err, null, null, log.ERR, err);
		}
	}

	async deleteRecords(delete_obj) {
		return await lmdbDeleteRecords(delete_obj);
	}

	async deleteRecordsBefore(delete_obj) {
		return await lmdbDeleteRecordsBefore(delete_obj);
	}

	async dropAttribute(drop_attr_obj) {
		return await lmdbDropAttribute(drop_attr_obj);
	}

	async deleteAuditLogsBefore(delete_obj) {
		return await lmdbDeleteAuditLogsBefore(delete_obj);
	}

	async readAuditLog(read_audit_log_obj) {
		return await lmdbReadAuditLog(read_audit_log_obj);
	}

	writeTransaction(schema, table, callback) {
		return lmdbTransaction.writeTransaction(schema, table, callback);
	}

	flush(schema, table) {
		return lmdbFlush.flush(schema, table);
	}
}

module.exports = LMDBBridge;
