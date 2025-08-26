'use strict';

const dropAttribute = require('../lmdbMethods/lmdbDropAttribute.js');
const DropAttributeObject = require('../../../DropAttributeObject.js');
const hdbUtils = require('../../../../utility/common_utils.js');
const log = require('../../../../utility/logging/harper_logger.js');
const LMDB_ERROR = require('../../../../utility/errors/commonErrors.js').LMDB_ERRORS_ENUM;

module.exports = lmdbDropAllAttributes;

/**
 * drops all attributes from a table
 * @param dropObj
 */
async function lmdbDropAllAttributes(dropObj) {
	if (
		hdbUtils.isEmpty(global.hdb_schema[dropObj.schema]) ||
		hdbUtils.isEmpty(global.hdb_schema[dropObj.schema][dropObj.table])
	) {
		throw new Error(`unknown schema:${dropObj.schema} and table ${dropObj.table}`);
	}

	let schemaTable = global.hdb_schema[dropObj.schema][dropObj.table];

	let currentAttribute;
	try {
		for (let i = 0; i < schemaTable.attributes.length; i++) {
			currentAttribute = schemaTable.attributes[i].attribute;
			let dropAttrObject = new DropAttributeObject(dropObj.schema, dropObj.table, currentAttribute);
			try {
				await dropAttribute(dropAttrObject, false);
			} catch (e) {
				if (e.message !== LMDB_ERROR.DBI_DOES_NOT_EXIST) {
					log.error(`unable to drop attribute ${dropObj.schema}.${dropObj.table}.${currentAttribute}:` + e);
				}
			}
		}
	} catch (err) {
		log.error(`Error dropping attribute ${currentAttribute}`);
		throw err;
	}
}
