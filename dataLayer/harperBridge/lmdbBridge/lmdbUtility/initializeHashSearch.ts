import * as environmentUtility from '../../../../utility/lmdb/environmentUtility.ts';
const searchValidator =
	require('../../../../validation/searchValidator.ts').default || require('../../../../validation/searchValidator.ts');
import { getSchemaPath } from './initializePaths.ts';

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
