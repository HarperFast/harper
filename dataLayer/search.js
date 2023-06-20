'use strict';

const SelectValidator = require('../sqlTranslator/SelectValidator');

module.exports = {
	searchByConditions,
	searchByHash,
	searchByValue,
	search,
};

const harperBridge = require('./harperBridge/harperBridge');
const util = require('util');
const SQLSearch = require('./SQLSearch');

async function searchByConditions(search_object) {
	return harperBridge.searchByConditions(search_object);
}

async function searchByHash(search_object, callback) {
	let array = [];
	for await (let record of harperBridge.searchByHash(search_object)) {
		if (record) array.push(record);
	}
	return array;
}

async function searchByValue(search_object, callback) {
	if (search_object.hasOwnProperty('desc') === true) {
		search_object.reverse = search_object.desc;
	}
	const array = [];
	for await (let record of harperBridge.searchByValue(search_object)) {
		array.push(record);
	}
	return array;
}

function search(statement, callback) {
	try {
		let validator = new SelectValidator(statement);
		validator.validate();

		let sql_search = new SQLSearch(validator.statement, validator.attributes);

		sql_search
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
