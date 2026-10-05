import * as searchUtility from '../../../../utility/lmdb/searchUtility.ts';
import hashSearchInit from '../lmdbUtility/initializeHashSearch.ts';

export default lmdbSearchByHash;

/**
 * fetches records by their hash values and returns an Array of the results
 * @param {SearchByHashObject} searchObject
 */
async function lmdbSearchByHash(searchObject) {
	let environment = await hashSearchInit(searchObject);
	const tableInfo = global.hdb_schema[searchObject.schema][searchObject.table];
	return searchUtility.batchSearchByHash(
		environment,
		tableInfo.hash_attribute,
		searchObject.get_attributes,
		searchObject.hash_values
	);
}
