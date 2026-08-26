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
	// Full replace rather than merge, for `update`/`upsert` (see ResourceBridge.upsertRecords).
	//
	// Declared even though `validateBySchema` allows unknown keys, and `.strict()` on this one key
	// (not the whole object, which would tighten the long-standing contract of the others) so it has
	// to be an actual boolean. Joi coerces by default and `validateBySchema` discards the converted
	// value, so without this a string `"false"` would validate and then reach the bridge still a
	// string — and a request that never asked for a replace decides the question by truthiness.
	// Rejecting is the safe direction: silently ignoring `"true"` would be just as wrong in reverse.
	// Same rationale as `analyticsValidator`'s `.strict()`.
	full_record: Joi.boolean().strict(),
});

export default function (insertObject: any) {
	return validator.validateBySchema(insertObject, insertSchema);
}
