'use strict';
const LMDBBridge = require('./lmdbBridge/LMDBBridge');
const search_validator = require('../../validation/searchValidator');
const { handleHDBError } = require('../../utility/errors/hdbError');
const { Resource } = require('../../resources/Resource');

/**
 * Currently we are extending LMDBBridge so we can use the LMDB methods as a fallback until all are implemented
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
		let records = resource_snapshot.useTable(search_object.table, search_object.schema).search(search_object, search_object);
		records.onDone = () => resource_snapshot.doneReading();
		return records;
	}
}
module.exports = RAPIBridge;