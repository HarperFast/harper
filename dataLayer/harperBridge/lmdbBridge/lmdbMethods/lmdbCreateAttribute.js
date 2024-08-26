'use strict';

const hdb_terms = require('../../../../utility/hdbTerms');
const environment_utility = require('../../../../utility/lmdb/environmentUtility');
const write_utility = require('../../../../utility/lmdb/writeUtility');
const { getSystemSchemaPath, getSchemaPath } = require('../lmdbUtility/initializePaths');
const system_schema = require('../../../../json/systemSchema');
const schema_validator = require('../../../../validation/schema_validator');
const LMDBCreateAttributeObject = require('../lmdbUtility/LMDBCreateAttributeObject');
const returnObject = require('../../bridgeUtility/insertUpdateReturnObj');
const { handleHDBError, hdb_errors } = require('../../../../utility/errors/hdbError');
const hdb_utils = require('../../../../utility/common_utils');
const { HTTP_STATUS_CODES } = hdb_errors;

const ACTION = 'inserted';

module.exports = lmdbCreateAttribute;

/**
 * First adds the attribute to the system attribute table, then creates the dbi.
 * @param {LMDBCreateAttributeObject} create_attribute_obj
 * @returns {{skipped_hashes: *, update_hashes: *, message: string}}
 */
async function lmdbCreateAttribute(create_attribute_obj) {
	let validation_error = schema_validator.attribute_object(create_attribute_obj);
	if (validation_error) {
		throw handleHDBError(
			new Error(),
			validation_error.message,
			hdb_errors.HTTP_STATUS_CODES.BAD_REQUEST,
			undefined,
			undefined,
			true
		);
	}
	//check if schema.table does not exist throw error
	let check_schema_table =
		!create_attribute_obj.skip_table_check &&
		hdb_utils.checkGlobalSchemaTable(create_attribute_obj.schema, create_attribute_obj.table);
	if (check_schema_table) {
		throw handleHDBError(new Error(), check_schema_table, HTTP_STATUS_CODES.NOT_FOUND);
	}

	//the validator strings everything so we need to recast the booleans on create_attribute_obj
	create_attribute_obj.is_hash_attribute = create_attribute_obj.is_hash_attribute == 'true';
	create_attribute_obj.dup_sort =
		hdb_utils.isEmpty(create_attribute_obj.dup_sort) || create_attribute_obj.dup_sort == 'true';

	let attributes_obj_array = [];
	//on initial creation of a table it will not exist in hdb_schema yet
	if (
		global.hdb_schema[create_attribute_obj.schema] &&
		global.hdb_schema[create_attribute_obj.schema][create_attribute_obj.table]
	) {
		attributes_obj_array = global.hdb_schema[create_attribute_obj.schema][create_attribute_obj.table]['attributes'];
	}
	if (Array.isArray(attributes_obj_array) && attributes_obj_array.length > 0) {
		for (let attribute of attributes_obj_array) {
			if (attribute.attribute === create_attribute_obj.attribute) {
				throw new Error(
					`attribute '${attribute.attribute}' already exists in ${create_attribute_obj.schema}.${create_attribute_obj.table}`
				);
			}
		}
	}

	//insert the attribute meta_data into system.hdb_attribute
	let record = new LMDBCreateAttributeObject(
		create_attribute_obj.schema,
		create_attribute_obj.table,
		create_attribute_obj.attribute,
		create_attribute_obj.id
	);

	try {
		//create dbi into the environment for this table
		let env = await environment_utility.openEnvironment(
			getSchemaPath(create_attribute_obj.schema, create_attribute_obj.table),
			create_attribute_obj.table
		);
		if (env.dbis[create_attribute_obj.attribute] !== undefined) {
			throw new Error(
				`attribute '${create_attribute_obj.attribute}' already exists in ${create_attribute_obj.schema}.${create_attribute_obj.table}`
			);
		}
		environment_utility.createDBI(
			env,
			create_attribute_obj.attribute,
			create_attribute_obj.dup_sort,
			create_attribute_obj.is_hash_attribute
		);

		let hdb_attribute_env = await environment_utility.openEnvironment(
			getSystemSchemaPath(),
			hdb_terms.SYSTEM_TABLE_NAMES.ATTRIBUTE_TABLE_NAME
		);

		let { written_hashes, skipped_hashes } = await write_utility.insertRecords(
			hdb_attribute_env,
			HDB_TABLE_INFO.hash_attribute,
			hdb_attribute_attributes,
			[record]
		);

		return returnObject(ACTION, written_hashes, { records: [record] }, skipped_hashes);
	} catch (e) {
		throw e;
	}
}
