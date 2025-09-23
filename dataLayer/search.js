'use strict';

module.exports = {
	searchByConditions,
	searchByHash,
	searchByValue,
	search,
};

const harperBridge = require('./harperBridge/harperBridge.js');
const { transformReq } = require('../utility/common_utils.js');

async function searchByConditions(searchObject) {
	transformReq(searchObject);
	return harperBridge.searchByConditions(searchObject);
}

async function searchByHash(searchObject) {
	transformReq(searchObject);
	if (searchObject.ids) searchObject.hash_values = searchObject.ids;
	let array = [];
	for await (let record of harperBridge.searchByHash(searchObject)) {
		if (record) array.push(record);
	}
	return array;
}

async function searchByValue(searchObject) {
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

function search(statement, callback) {
	try {
		const SelectValidator = require('../sqlTranslator/SelectValidator.js');
		const SQLSearch = require('./SQLSearch.js');
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
