'use strict';

const SearchObject = require('../../../../data_layer/SearchObject');
const DeleteObject = require('../../../../data_layer/DeleteObject');
const DropAttributeObject = require('../../../../data_layer/DropAttributeObject');
const hdb_terms = require('../../../../utility/hdbTerms');
const common_utils = require('../../../../utility/common_utils');
const environment_utility = require('../../../../utility/lmdb/environmentUtility');
const system_schema = require('../../../../json/systemSchema.json');
const search_by_value = require('./lmdbSearchByValue');
const delete_records = require('./lmdbDeleteRecords');
const { getSchemaPath } = require('../lmdbUtility/initializePaths');

module.exports = lmdbDropAttribute;

/**
 * First deletes the attribute/dbi from lmdb then removes its record from system table
 * @param {DropAttributeObject} drop_attribute_obj
 * @param {Boolean} [remove_data] - optional, defaults to false
 * @returns {undefined}
 */
async function lmdbDropAttribute(drop_attribute_obj, remove_data = true) {
	let table_info;
	if (drop_attribute_obj.schema === hdb_terms.SYSTEM_SCHEMA_NAME) {
		table_info = system_schema[drop_attribute_obj.table];
	} else {
		table_info = global.hdb_schema[drop_attribute_obj.schema][drop_attribute_obj.table];
	}

	//remove meta data
	let delete_results = await dropAttributeFromSystem(drop_attribute_obj);
	//drop dbi
	let schema_path = getSchemaPath(drop_attribute_obj.schema, drop_attribute_obj.table);
	let env = await environment_utility.openEnvironment(schema_path, drop_attribute_obj.table);

	//in the scenario of drop table / schema we don't need to remove individual elements since we are removing entire environments
	if (remove_data === true) {
		await removeAttributeFromAllObjects(drop_attribute_obj, env, table_info.hash_attribute);
	}

	environment_utility.dropDBI(env, drop_attribute_obj.attribute);

	return delete_results;
}

/**
 * iterates the hash attribute dbi and removes the attribute dropped
 * @param {DropAttributeObject} drop_attribute_obj
 * @param {lmdb.RootDatabase} env
 * @param {String} hash_attribute
 */
async function removeAttributeFromAllObjects(drop_attribute_obj, env, hash_attribute) {
	//get reference to hash attribute index (dbi)
	let dbi = environment_utility.openDBI(env, hash_attribute);

	//declare just one promise for the bulk write, read the await below
	let promise;
	let attribute_to_delete = drop_attribute_obj.attribute;
	//iterate the entire hash attribute index to remove the dropped attribute and update the entry
	for (let { key, value, version } of dbi.getRange({ start: false, versions: true })) {
		//delete the attribute being dropped from the record
		let updated_value = {};
		for (let property in value) {
			if (property !== attribute_to_delete) updated_value[property] = value[property];
		}
		// maintain the same version number as we re-save the data with the
		// property dropped
		promise = env.dbis[hash_attribute].put(key, updated_value, version);
	}
	//since lmdb processes all promised writes in order we only need to wait for the last promise to execute to know all the previous ones have also finished
	await promise;
}

/**
 * Searches the system attributes table for attribute record then sends record to delete to be removed from system table.
 * @param {DropAttributeObject} drop_attribute_obj
 * @returns {undefined}
 */
async function dropAttributeFromSystem(drop_attribute_obj) {
	let search_obj = new SearchObject(
		hdb_terms.SYSTEM_SCHEMA_NAME,
		hdb_terms.SYSTEM_TABLE_NAMES.ATTRIBUTE_TABLE_NAME,
		hdb_terms.SYSTEM_DEFAULT_ATTRIBUTE_NAMES.ATTR_SCHEMA_TABLE_KEY,
		`${drop_attribute_obj.schema}.${drop_attribute_obj.table}`,
		undefined,
		[hdb_terms.SYSTEM_DEFAULT_ATTRIBUTE_NAMES.ATTR_ID_KEY, hdb_terms.SYSTEM_DEFAULT_ATTRIBUTE_NAMES.ATTR_ATTRIBUTE_KEY]
	);

	let table_attributes = Array.from(await search_by_value(search_obj));
	let attribute = table_attributes.filter(
		(attr) => attr[hdb_terms.SYSTEM_DEFAULT_ATTRIBUTE_NAMES.ATTR_ATTRIBUTE_KEY] === drop_attribute_obj.attribute
	);
	if (common_utils.isEmptyOrZeroLength(attribute)) {
		throw new Error(
			`Attribute '${drop_attribute_obj.attribute}' was not found in '${drop_attribute_obj.schema}.${drop_attribute_obj.table}'`
		);
	}

	let id = attribute.map((attr) => attr[hdb_terms.SYSTEM_DEFAULT_ATTRIBUTE_NAMES.ATTR_ID_KEY]);

	let delete_table_obj = new DeleteObject(
		hdb_terms.SYSTEM_SCHEMA_NAME,
		hdb_terms.SYSTEM_TABLE_NAMES.ATTRIBUTE_TABLE_NAME,
		id
	);

	return delete_records(delete_table_obj);
}
