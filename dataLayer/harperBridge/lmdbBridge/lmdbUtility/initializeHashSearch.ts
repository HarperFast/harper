'use strict';;
import * as environmentUtility from '../../../../utility/lmdb/environmentUtility.js';
import * as searchValidator from '../../../../validation/searchValidator.js';
import { getSchemaPath } from './initializePaths.js';
export default initialize;

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
