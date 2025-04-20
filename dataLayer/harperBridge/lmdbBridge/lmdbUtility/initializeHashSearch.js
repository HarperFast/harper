'use strict';

const environmentUtility = require('../../../../utility/lmdb/environmentUtility.js');
const searchValidator = require('../../../../validation/searchValidator.js');
const { getSchemaPath } = require('./initializePaths.js');

module.exports = initialize;

/**
 *
 * @param searchObject
 * @returns {*}
 */
function initialize(searchObject) {
	const validationError = searchValidator(searchObject, 'hashes');
	if (validationError) {
		throw validationError;
	}
	let envBasePath = getSchemaPath(searchObject.schema, searchObject.table);
	return environmentUtility.openEnvironment(envBasePath, searchObject.table);
}
