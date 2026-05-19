'use strict';

const hdbTerms = require('../../../../utility/hdbTerms.ts');
const environmentUtility = require('../../../../utility/lmdb/environmentUtility.ts');
const writeUtility = require('../../../../utility/lmdb/writeUtility.ts');
const { getSystemSchemaPath, getSchemaPath } = require('../lmdbUtility/initializePaths.js');
const { validateBySchema } = require('../../../../validation/validationWrapper.ts');
const Joi = require('joi');
const LMDBCreateAttributeObject =
	require('../lmdbUtility/LMDBCreateAttributeObject.js').default ||
	require('../lmdbUtility/LMDBCreateAttributeObject.js');
const returnObject = require('../../bridgeUtility/insertUpdateReturnObj.js');
const { handleHDBError, hdbErrors, ClientError } = require('../../../../utility/errors/hdbError.ts');
const hdbUtils = require('../../../../utility/common_utils.ts');
const { HTTP_STATUS_CODES } = hdbErrors;

const ACTION = 'inserted';

module.exports = lmdbCreateAttribute;

/**
 * First adds the attribute to the system attribute table, then creates the dbi.
 * @param {LMDBCreateAttributeObject} createAttributeObj
 * @returns {{skipped_hashes: *, update_hashes: *, message: string}}
 */
async function lmdbCreateAttribute(createAttributeObj) {
	const validation = validateBySchema(
		createAttributeObj,
		Joi.object({
			database: Joi.string(),
			schema: Joi.string(),
			table: Joi.string().required(),
			attribute: Joi.string().required(),
		})
	);
	if (validation) throw new ClientError(validation.message);

	//check if schema.table does not exist throw error
	let checkSchemaTable =
		!createAttributeObj.skip_table_check &&
		hdbUtils.checkGlobalSchemaTable(createAttributeObj.schema, createAttributeObj.table);
	if (checkSchemaTable) {
		throw handleHDBError(new Error(), checkSchemaTable, HTTP_STATUS_CODES.NOT_FOUND);
	}

	//the validator strings everything so we need to recast the booleans on createAttributeObj
	createAttributeObj.isPrimaryKey = createAttributeObj.isPrimaryKey == 'true';
	createAttributeObj.dup_sort = hdbUtils.isEmpty(createAttributeObj.dup_sort) || createAttributeObj.dup_sort == 'true';

	let attributesObjArray = [];
	//on initial creation of a table it will not exist in hdbSchema yet
	if (
		global.hdb_schema[createAttributeObj.schema] &&
		global.hdb_schema[createAttributeObj.schema][createAttributeObj.table]
	) {
		attributesObjArray = global.hdb_schema[createAttributeObj.schema][createAttributeObj.table]['attributes'];
	}
	if (Array.isArray(attributesObjArray) && attributesObjArray.length > 0) {
		for (let attribute of attributesObjArray) {
			if (attribute.attribute === createAttributeObj.attribute) {
				throw new Error(
					`attribute '${attribute.attribute}' already exists in ${createAttributeObj.schema}.${createAttributeObj.table}`
				);
			}
		}
	}

	//insert the attribute metaData into system.hdb_attribute
	let record = new LMDBCreateAttributeObject(
		createAttributeObj.schema,
		createAttributeObj.table,
		createAttributeObj.attribute,
		createAttributeObj.id
	);

	try {
		//create dbi into the environment for this table
		let env = await environmentUtility.openEnvironment(
			getSchemaPath(createAttributeObj.schema, createAttributeObj.table),
			createAttributeObj.table
		);
		if (env.dbis[createAttributeObj.attribute] !== undefined) {
			throw new Error(
				`attribute '${createAttributeObj.attribute}' already exists in ${createAttributeObj.schema}.${createAttributeObj.table}`
			);
		}
		environmentUtility.createDBI(
			env,
			createAttributeObj.attribute,
			createAttributeObj.dup_sort,
			createAttributeObj.isPrimaryKey
		);

		let hdbAttributeEnv = await environmentUtility.openEnvironment(
			getSystemSchemaPath(),
			hdbTerms.SYSTEM_TABLE_NAMES.ATTRIBUTE_TABLE_NAME
		);

		let { written_hashes, skipped_hashes } = await writeUtility.insertRecords(
			hdbAttributeEnv,
			// I'm not sure what else to do with these for now, but I do want to eslint to check the rest of the codebase
			// for undefined vars. - WSM 2025-11-26
			// eslint-disable-next-line no-undef
			HDB_TABLE_INFO.hash_attribute,
			// eslint-disable-next-line no-undef
			hdbAttributeAttributes,
			[record]
		);

		return returnObject(ACTION, written_hashes, { records: [record] }, skipped_hashes);
	} catch (e) {
		throw e;
	}
}
