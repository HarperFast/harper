'use strict';

const environment_utility = require('../../../../utility/lmdb/environmentUtility');
const search_validator = require('../../../../validation/searchValidator');
const { getSchemaPath } = require('./initializePaths');

module.exports = initialize;

/**
 *
 * @param search_object
 * @returns {*}
 */
function initialize(search_object) {
	const validation_error = search_validator(search_object, 'hashes');
	if (validation_error) {
		throw validation_error;
	}
	let env_base_path = getSchemaPath(search_object.schema, search_object.table);
	return environment_utility.openEnvironment(env_base_path, search_object.table);
}
