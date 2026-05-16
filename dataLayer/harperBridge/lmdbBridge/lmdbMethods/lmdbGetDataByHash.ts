import * as searchUtility from '../../../../utility/lmdb/searchUtility.ts';
import hashSearchInit from '../lmdbUtility/initializeHashSearch.ts';

export default lmdbGetDataByHash;

/**
 * fetches records by their hash values and returns a map of the results
 * @param {SearchByHashObject} searchObject
 */
async function lmdbGetDataByHash(searchObject) {
	let environment = await hashSearchInit(searchObject);
	let transaction = environment.useReadTransaction();
	transaction.database = environment;

	const tableInfo = global.hdb_schema[searchObject.schema][searchObject.table];
	try {
		return searchUtility.batchSearchByHashToMap(
			transaction,
			tableInfo.hash_attribute,
			searchObject.get_attributes,
			searchObject.hash_values
		);
	} finally {
		transaction.done();
	}
}
