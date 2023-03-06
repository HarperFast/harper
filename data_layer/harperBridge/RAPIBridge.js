'use strict';
const LMDBBridge = require('./lmdbBridge/LMDBBridge');
const search_validator = require('../../validation/searchValidator');
const { handleHDBError, hdb_errors } = require('../../utility/errors/hdbError');
const { Resource } = require('../../resources/Resource');
const { table } = require('../../resources/database');
const { HTTP_STATUS_CODES } = hdb_errors;
/**
 * Currently we are extending LMDBBridge so we can use the LMDB methods as a fallback until all our RAPI methods are
 * implemented
 */
class RAPIBridge extends LMDBBridge {
	async searchByConditions(search_object) {
		let validation_error = search_validator(search_object, 'conditions');
		if (validation_error) {
			throw handleHDBError(
				validation_error,
				validation_error.message,
				HTTP_STATUS_CODES.BAD_REQUEST,
				undefined,
				undefined,
				true
			);
		}

		//set the operator to always be lowercase for later evaluations
		search_object.operator = search_object.operator ? search_object.operator.toLowerCase() : undefined;

		search_object.offset = Number.isInteger(search_object.offset) ? search_object.offset : 0;
		let resource_snapshot = new Resource();
		let records = resource_snapshot
			.useTable(search_object.table, search_object.schema)
			.search(search_object, search_object);
		records.onDone = () => resource_snapshot.doneReading();
		return records;
	}
	/**
	 * Writes new table data to the system tables creates the enivronment file and creates two datastores to track created and updated
	 * timestamps for new table data.
	 * @param table_system_data
	 * @param table_create_obj
	 */
	async createTable(table_system_data, table_create_obj) {
		return table({
			database: table_create_obj.schema,
			table: table_create_obj.table,
			attributes: [
				{
					name: table_create_obj.hash_attribute,
					is_primary_key: true,
				},
			],
		});
	}
}
module.exports = RAPIBridge;
