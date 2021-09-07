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
const lmdbDeleteTransactionLogsBefore = require('./lmdbMethods/lmdbDeleteTransactionLogsBefore');
const lmdbDropTable = require('./lmdbMethods/lmdbDropTable');
const lmdbDropAttribute = require('./lmdbMethods/lmdbDropAttribute');
const lmdbReadTransactionLog = require('./lmdbMethods/lmdbReadTransactionLog');

class LMDBBridge extends BridgeMethods {
	async searchByConditions(search_object) {
		try {
			return lmdbSearchByConditions(search_object);
		} catch (err) {
			log.error(err);
			throw err;
		}
	}

	async getDataByHash(search_object) {
		try {
			return await lmdbGetDataByHash(search_object);
		} catch (err) {
			log.error(err);
			throw err;
		}
	}

	async searchByHash(search_object) {
		try {
			return await lmdbSearchByHash(search_object);
		} catch (err) {
			log.error(err);
			throw err;
		}
	}

	async getDataByValue(search_object, comparator) {
		try {
			return await lmdbGetDataByValue(search_object, comparator);
		} catch (err) {
			log.error(err);
			throw err;
		}
	}

	async searchByValue(search_object) {
		try {
			return await lmdbSearchByValue(search_object);
		} catch (err) {
			log.error(err);
			throw err;
		}
	}

	async createSchema(schema_create_obj) {
		try {
			return await lmdbCreateSchema(schema_create_obj);
		} catch (err) {
			log.error(err);
			throw err;
		}
	}

	async dropSchema(drop_schema_obj) {
		try {
			return await lmdbDropSchema(drop_schema_obj);
		} catch (err) {
			log.error(err);
			throw err;
		}
	}

	async createTable(table, table_create_obj) {
		try {
			return await lmdbCreateTable(table, table_create_obj);
		} catch (err) {
			log.error(err);
			throw err;
		}
	}

	async dropTable(drop_table_obj) {
		try {
			return await lmdbDropTable(drop_table_obj);
		} catch (err) {
			log.error(err);
			throw err;
		}
	}

	async createAttribute(create_attribute_obj) {
		try {
			return await lmdbCreateAttribute(create_attribute_obj);
		} catch (err) {
			log.error(err);
			throw err;
		}
	}

	async createRecords(insert_obj) {
		try {
			return await lmdbCreateRecords(insert_obj);
		} catch (err) {
			log.error(err);
			throw err;
		}
	}

	async updateRecords(update_obj) {
		try {
			return await lmdbUpdateRecords(update_obj);
		} catch (err) {
			log.error(err);
			throw err;
		}
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
		try {
			return await lmdbDeleteRecords(delete_obj);
		} catch (err) {
			log.error(err);
			throw err;
		}
	}

	async deleteRecordsBefore(delete_obj) {
		try {
			return await lmdbDeleteRecordsBefore(delete_obj);
		} catch (err) {
			log.error(err);
			throw err;
		}
	}

	async dropAttribute(drop_attr_obj) {
		try {
			return await lmdbDropAttribute(drop_attr_obj);
		} catch (err) {
			log.error(err);
			throw err;
		}
	}

	async deleteTransactionLogsBefore(delete_obj) {
		try {
			return await lmdbDeleteTransactionLogsBefore(delete_obj);
		} catch (err) {
			log.error(err);
			throw err;
		}
	}

	async readTransactionLog(read_transaction_log_obj) {
		try {
			return await lmdbReadTransactionLog(read_transaction_log_obj);
		} catch (err) {
			log.error(err);
			throw err;
		}
	}
}

module.exports = LMDBBridge;
