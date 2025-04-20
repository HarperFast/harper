'use strict';

const hdbUtils = require('../../../utility/common_utils.js');

module.exports = checkForNewAttributes;

/**
 * Compares the existing schema attributes to attributes from a record set and returns only the ones that exist.
 * @param hdbAuthHeader
 * @param tableSchema
 * @param dataAttributes
 * @returns {Promise<void>}
 */
function checkForNewAttributes(tableSchema, dataAttributes) {
	if (hdbUtils.isEmptyOrZeroLength(dataAttributes)) {
		return;
	}

	let rawAttributes = [];
	if (!hdbUtils.isEmptyOrZeroLength(tableSchema.attributes)) {
		tableSchema.attributes.forEach((attribute) => {
			rawAttributes.push(attribute.attribute);
		});
	}

	let new_attributes = dataAttributes.filter((attribute) => {
		return rawAttributes.indexOf(attribute) < 0;
	});

	if (new_attributes.length === 0) {
		return;
	}

	return new_attributes;
}
