'use strict';

const hdb_utils = require('../../../utility/common_utils');
const log = require('../../../utility/logging/harper_logger');
const insert_validator = require('../../../validation/insertValidator');
const { getDatabases } = require('../../../resources/database');

module.exports = insertUpdateValidate;

//IMPORTANT - This code is the same code as the async validation() function in dataLayer/insert - make sure any changes
// below are also made there.  This is to resolve a circular dependency.
/**
 * Takes an insert/update object and validates attributes, also looks for dups and get a list of all attributes from the record set
 * @param {Object} write_object
 * @returns {Promise<{table_schema, hashes: any[], attributes: string[]}>}
 */
function insertUpdateValidate(write_object) {
	// Need to validate these outside of the validator as the getTableSchema call will fail with
	// invalid values.

	if (hdb_utils.isEmpty(write_object)) {
		throw new Error('invalid update parameters defined.');
	}
	if (hdb_utils.isEmptyOrZeroLength(write_object.schema)) {
		throw new Error('invalid schema specified.');
	}
	if (hdb_utils.isEmptyOrZeroLength(write_object.table)) {
		throw new Error('invalid table specified.');
	}

	if (!Array.isArray(write_object.records)) {
		throw new Error('records must be an array');
	}

	let schema_table = getDatabases()[write_object.schema]?.[write_object.table];
	if (hdb_utils.isEmpty(schema_table)) {
		throw new Error(`could not retrieve schema:${write_object.schema} and table ${write_object.table}`);
	}

	let hash_attribute = schema_table.primaryKey;
	let dups = new Set();
	let attributes = {};

	let is_update = false;
	if (write_object.operation === 'update') {
		is_update = true;
	}

	write_object.records.forEach((record) => {
		if (is_update && hdb_utils.isEmptyOrZeroLength(record[hash_attribute])) {
			log.error('a valid hash attribute must be provided with update record:', record);
			throw new Error('a valid hash attribute must be provided with update record, check log for more info');
		}

		if (
			!hdb_utils.isEmptyOrZeroLength(record[hash_attribute]) &&
			(record[hash_attribute] === 'null' || record[hash_attribute] === 'undefined')
		) {
			log.error(`a valid hash value must be provided with ${write_object.operation} record:`, record);
			throw new Error(
				`Invalid hash value: '${record[hash_attribute]}' is not a valid hash attribute value, check log for more info`
			);
		}

		if (
			!hdb_utils.isEmpty(record[hash_attribute]) &&
			record[hash_attribute] !== '' &&
			dups.has(hdb_utils.autoCast(record[hash_attribute]))
		) {
			record.skip = true;
		}

		dups.add(hdb_utils.autoCast(record[hash_attribute]));

		for (let attr in record) {
			attributes[attr] = 1;
		}
	});

	//in case the hash_attribute was not on the object(s) for inserts where they want to auto-key we manually add the hash_attribute to attributes
	attributes[hash_attribute] = 1;

	return {
		schema_table: schema_table,
		hashes: Array.from(dups),
		attributes: Object.keys(attributes),
	};
}
