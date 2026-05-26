'use strict';

const harperBridge = require('./harperBridge/harperBridge').default;
import { transformReq } from '../utility/common_utils.ts';

export async function searchByConditions(searchObject: any) {
	transformReq(searchObject);
	return harperBridge.searchByConditions(searchObject);
}

export async function searchByHash(searchObject: any) {
	transformReq(searchObject);
	if (searchObject.ids) searchObject.hash_values = searchObject.ids;
	let array = [];
	for await (let record of harperBridge.searchByHash(searchObject)) {
		if (record) array.push(record);
	}
	return array;
}

export async function searchByValue(searchObject: any) {
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

export function search(statement: any, callback: any) {
	try {
		const SelectValidator =
			require('../sqlTranslator/SelectValidator').default || require('../sqlTranslator/SelectValidator');
		const SQLSearch = require('./SQLSearch').default || require('./SQLSearch');
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
	} catch (e) {
		return callback(e);
	}
}
