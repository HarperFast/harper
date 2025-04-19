'use strict';

const SearchByHashObject = require('../../../SearchByHashObject.js');

const searchUtility = require('../../../../utility/lmdb/searchUtility.js');
const hashSearchInit = require('../lmdbUtility/initializeHashSearch.js');

module.exports = lmdbSearchByHash;

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
