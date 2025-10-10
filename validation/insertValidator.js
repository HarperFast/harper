const { hdbTable, hdbDatabase } = require('./common_validators.js');
const validator = require('./validationWrapper.js');
const Joi = require('joi');
const INVALID_ATTRIBUTE_NAMES = {
	undefined: 'undefined',
	null: 'null',
};

const customRecordsVal = (value, helpers) => {
	const attributes = Object.keys(value);
	const attributesLength = attributes.length;
	let errorMsg = undefined;
	for (let i = 0; i < attributesLength; i++) {
		const attribute = attributes[i];
		if (!attribute || attribute.length === 0 || INVALID_ATTRIBUTE_NAMES[attribute] !== undefined) {
			if (errorMsg === undefined) {
				errorMsg = `Invalid attribute name: '${attribute}'`;
			} else {
				errorMsg += `. Invalid attribute name: '${attribute}'`;
			}
		}
	}

	if (errorMsg) {
		return helpers.message(errorMsg);
	}

	return value;
};

const insertSchema = Joi.object({
	database: hdbDatabase,
	schema: hdbDatabase,
	table: hdbTable,
	records: Joi.array().items(Joi.object().custom(customRecordsVal)).required(),
});

module.exports = function (insertObject) {
	return validator.validateBySchema(insertObject, insertSchema);
};
