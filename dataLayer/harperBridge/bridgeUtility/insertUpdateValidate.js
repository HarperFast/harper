'use strict';

const hdbUtils = require('../../../utility/common_utils.js');
const log = require('../../../utility/logging/harper_logger.js');
const insertValidator = require('../../../validation/insertValidator.js');
const { getDatabases } = require('../../../resources/databases.ts');
const { ClientError } = require('../../../utility/errors/hdbError.js');

module.exports = insertUpdateValidate;

//IMPORTANT - This code is the same code as the async validation() function in dataLayer/insert - make sure any changes
// below are also made there.  This is to resolve a circular dependency.
/**
 * Takes an insert/update object and validates attributes, also looks for dups and get a list of all attributes from the record set
 * @param {Object} writeObject
 * @returns {Promise<{tableSchema, hashes: any[], attributes: string[]}>}
 */
function insertUpdateValidate(writeObject) {
	// Need to validate these outside of the validator as the getTableSchema call will fail with
	// invalid values.

	if (hdbUtils.isEmpty(writeObject)) {
		throw new ClientError('invalid update parameters defined.');
	}
	if (hdbUtils.isEmptyOrZeroLength(writeObject.schema)) {
		throw new ClientError('invalid schema specified.');
	}
	if (hdbUtils.isEmptyOrZeroLength(writeObject.table)) {
		throw new ClientError('invalid table specified.');
	}

	if (!Array.isArray(writeObject.records)) {
		throw new ClientError('records must be an array');
	}

	let schemaTable = getDatabases()[writeObject.schema]?.[writeObject.table];
	if (hdbUtils.isEmpty(schemaTable)) {
		throw new ClientError(`could not retrieve schema:${writeObject.schema} and table ${writeObject.table}`);
	}

	let hash_attribute = schemaTable.primaryKey;
	let dups = new Set();
	let attributes = {};

	let isUpdate = false;
	if (writeObject.operation === 'update') {
		isUpdate = true;
	}

	writeObject.records.forEach((record) => {
		if (isUpdate && hdbUtils.isEmptyOrZeroLength(record[hash_attribute])) {
			log.error('a valid hash attribute must be provided with update record:', record);
			throw new ClientError('a valid hash attribute must be provided with update record, check log for more info');
		}

		if (
			!hdbUtils.isEmptyOrZeroLength(record[hash_attribute]) &&
			(record[hash_attribute] === 'null' || record[hash_attribute] === 'undefined')
		) {
			log.error(`a valid hash value must be provided with ${writeObject.operation} record:`, record);
			throw new ClientError(
				`Invalid hash value: '${record[hash_attribute]}' is not a valid hash attribute value, check log for more info`
			);
		}

		if (
			!hdbUtils.isEmpty(record[hash_attribute]) &&
			record[hash_attribute] !== '' &&
			dups.has(hdbUtils.autoCast(record[hash_attribute]))
		) {
			record.skip = true;
		}

		dups.add(hdbUtils.autoCast(record[hash_attribute]));

		for (let attr in record) {
			attributes[attr] = 1;
		}
	});

	//in case the hash_attribute was not on the object(s) for inserts where they want to auto-key we manually add the hash_attribute to attributes
	attributes[hash_attribute] = 1;

	return {
		schema_table: schemaTable,
		hashes: Array.from(dups),
		attributes: Object.keys(attributes),
	};
}
