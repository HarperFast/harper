'use strict';

const hdb_utils = require('../../../utility/common_utils');

module.exports = checkForNewAttributes;

/**
 * Compares the existing schema attributes to attributes from a record set and returns only the ones that exist.
 * @param hdb_auth_header
 * @param table_schema
 * @param data_attributes
 * @returns {Promise<void>}
 */
function checkForNewAttributes(table_schema, data_attributes) {
	if (hdb_utils.isEmptyOrZeroLength(data_attributes)) {
		return;
	}

	let raw_attributes = [];
	if (!hdb_utils.isEmptyOrZeroLength(table_schema.attributes)) {
		table_schema.attributes.forEach((attribute) => {
			raw_attributes.push(attribute.attribute);
		});
	}

	let new_attributes = data_attributes.filter((attribute) => {
		return raw_attributes.indexOf(attribute) < 0;
	});

	if (new_attributes.length === 0) {
		return;
	}

	return new_attributes;
}
