'use strict';

const SearchObject = require('../../../SearchObject.js');
const DeleteObject = require('../../../DeleteObject.js');
const DropAttributeObject = require('../../../DropAttributeObject.js');
const hdbTerms = require('../../../../utility/hdbTerms.ts');
const commonUtils = require('../../../../utility/common_utils.js');
const environmentUtility = require('../../../../utility/lmdb/environmentUtility.js');
const systemSchema = require('../../../../json/systemSchema.json');
const searchByValue = require('./lmdbSearchByValue.js');
const deleteRecords = require('./lmdbDeleteRecords.js');
const { getSchemaPath } = require('../lmdbUtility/initializePaths.js');

module.exports = lmdbDropAttribute;

/**
 * First deletes the attribute/dbi from lmdb then removes its record from system table
 * @param {DropAttributeObject} dropAttributeObj
 * @param {Boolean} [removeData] - optional, defaults to false
 * @returns {undefined}
 */
async function lmdbDropAttribute(dropAttributeObj, removeData = true) {
	let tableInfo;
	if (dropAttributeObj.schema === hdbTerms.SYSTEM_SCHEMA_NAME) {
		tableInfo = systemSchema[dropAttributeObj.table];
	} else {
		tableInfo = global.hdb_schema[dropAttributeObj.schema][dropAttributeObj.table];
	}

	//remove meta data
	let deleteResults = await dropAttributeFromSystem(dropAttributeObj);
	//drop dbi
	let schemaPath = getSchemaPath(dropAttributeObj.schema, dropAttributeObj.table);
	let env = await environmentUtility.openEnvironment(schemaPath, dropAttributeObj.table);

	//in the scenario of drop table / schema we don't need to remove individual elements since we are removing entire environments
	if (removeData === true) {
		await removeAttributeFromAllObjects(dropAttributeObj, env, tableInfo.hash_attribute);
	}

	environmentUtility.dropDBI(env, dropAttributeObj.attribute);

	return deleteResults;
}

/**
 * iterates the hash attribute dbi and removes the attribute dropped
 * @param {DropAttributeObject} dropAttributeObj
 * @param {lmdb.RootDatabase} env
 * @param {String} hash_attribute
 */
async function removeAttributeFromAllObjects(dropAttributeObj, env, hash_attribute) {
	//get reference to hash attribute index (dbi)
	let dbi = environmentUtility.openDBI(env, hash_attribute);

	//declare just one promise for the bulk write, read the await below
	let promise;
	let attributeToDelete = dropAttributeObj.attribute;
	//iterate the entire hash attribute index to remove the dropped attribute and update the entry
	for (let { key, value, version } of dbi.getRange({ start: false, versions: true })) {
		//delete the attribute being dropped from the record
		let updatedValue = {};
		for (let property in value) {
			if (property !== attributeToDelete) updatedValue[property] = value[property];
		}
		// maintain the same version number as we re-save the data with the
		// property dropped
		promise = env.dbis[hash_attribute].put(key, updatedValue, version);
	}
	//since lmdb processes all promised writes in order we only need to wait for the last promise to execute to know all the previous ones have also finished
	await promise;
}

/**
 * Searches the system attributes table for attribute record then sends record to delete to be removed from system table.
 * @param {DropAttributeObject} dropAttributeObj
 * @returns {undefined}
 */
async function dropAttributeFromSystem(dropAttributeObj) {
	let searchObj = new SearchObject(
		hdbTerms.SYSTEM_SCHEMA_NAME,
		hdbTerms.SYSTEM_TABLE_NAMES.ATTRIBUTE_TABLE_NAME,
		hdbTerms.SYSTEM_DEFAULT_ATTRIBUTE_NAMES.ATTR_SCHEMA_TABLE_KEY,
		`${dropAttributeObj.schema}.${dropAttributeObj.table}`,
		undefined,
		[hdbTerms.SYSTEM_DEFAULT_ATTRIBUTE_NAMES.ATTR_ID_KEY, hdbTerms.SYSTEM_DEFAULT_ATTRIBUTE_NAMES.ATTR_ATTRIBUTE_KEY]
	);

	let tableAttributes = Array.from(await searchByValue(searchObj));
	let attribute = tableAttributes.filter(
		(attr) => attr[hdbTerms.SYSTEM_DEFAULT_ATTRIBUTE_NAMES.ATTR_ATTRIBUTE_KEY] === dropAttributeObj.attribute
	);
	if (commonUtils.isEmptyOrZeroLength(attribute)) {
		throw new Error(
			`Attribute '${drop_attribute_obj.attribute}' was not found in '${drop_attribute_obj.schema}.${drop_attribute_obj.table}'`
		);
	}

	let id = attribute.map((attr) => attr[hdbTerms.SYSTEM_DEFAULT_ATTRIBUTE_NAMES.ATTR_ID_KEY]);

	let deleteTableObj = new DeleteObject(
		hdbTerms.SYSTEM_SCHEMA_NAME,
		hdbTerms.SYSTEM_TABLE_NAMES.ATTRIBUTE_TABLE_NAME,
		id
	);

	return deleteRecords(deleteTableObj);
}
