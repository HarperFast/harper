'use strict';

import harperBridge from './harperBridge/harperBridge.js';
import { transformReq } from '../utility/common_utils.js';
import { default as SelectValidator } from '../sqlTranslator/SelectValidator.js';
import { default as SQLSearch } from './SQLSearch.js';

export {
	searchByConditions,
	searchByHash,
	searchByValue,
	search,
};

async function searchByConditions(searchObject: any): Promise<any> {
	transformReq(searchObject);
	return harperBridge.searchByConditions(searchObject);
}

async function searchByHash(searchObject: any): Promise<any[]> {
	transformReq(searchObject);
	if (searchObject.ids) searchObject.hash_values = searchObject.ids;
	let array = [];
	for await (let record of harperBridge.searchByHash(searchObject)) {
		if (record) array.push(record);
	}
	return array;
}

async function searchByValue(searchObject: any): Promise<any[]> {
	transformReq(searchObject);
	if (searchObject.hasOwnProperty('desc') === true) {
		searchObject.reverse = searchObject.desc;
	}
	const array = [];
	for await (let record of harperBridge.searchByValue(searchObject)) {
		array.push(record);
	}
	return array;
}

function search(statement: any, callback: (err: any, data?: any) => void) {
	try {
        let validator = new SelectValidator(statement);
        validator.validate();

        let sqlSearch = new SQLSearch(validator.statement, validator.attributes);

        sqlSearch
			.search()
			.then((data) => {
				callback(null, data);
			})
			.catch((e) => {
				callback(e, null);
			});
    } catch (e: any) {
		return callback(e);
	}
}
