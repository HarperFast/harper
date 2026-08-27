import { hdbTable, hdbDatabase } from './common_validators.ts';
import * as validator from './validationWrapper.ts';
import Joi from 'joi';
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

export default function (insertObject: any) {
	return validator.validateBySchema(insertObject, insertSchema);
}
