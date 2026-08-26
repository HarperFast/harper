import { hdbTable, hdbDatabase } from './common_validators.ts';
import * as validator from './validationWrapper.ts';
import { UNSET_ATTRIBUTES } from '../utility/hdbTerms.ts';
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

	const unsetError = unsetAttributesError(value[UNSET_ATTRIBUTES]);
	if (unsetError) {
		return helpers.message(unsetError);
	}

	return value;
};

/**
 * `__unset__` names the attributes a write should remove (see `ResourceBridge.upsertRecords`). It is
 * a reserved record key rather than a stored attribute, so it is validated here per record instead
 * of by the operation schema below.
 *
 * An array of names, not a map with ignored values: the value would carry no meaning, and a shape
 * that accepts anything invites callers to read significance into it.
 */
function unsetAttributesError(unset: unknown): string | undefined {
	if (unset === undefined) {
		return undefined;
	}
	if (!Array.isArray(unset)) {
		return `'${UNSET_ATTRIBUTES}' must be an array of attribute names`;
	}
	for (const name of unset) {
		if (typeof name !== 'string' || name.length === 0) {
			return `'${UNSET_ATTRIBUTES}' must contain only non-empty attribute names`;
		}
		// Managed timestamps are NOT refused here. This validator has no table schema, so a static
		// list would catch only the legacy `__createdtime__`/`__updatedtime__` and miss a
		// schema-declared `createdAt: Float @createdTime` — which the write path then silently
		// re-asserts, a 200 that changes nothing. `ResourceBridge.takeUnsetAttributes` refuses them
		// instead, off `Table.createdTimeProperty`/`updatedTimeProperty`, which resolve both spellings.
		// One check in the layer that can do it completely, rather than two that disagree.
		if (name === UNSET_ATTRIBUTES) {
			return `'${UNSET_ATTRIBUTES}' is not an attribute and cannot be unset`;
		}
	}
	return undefined;
}

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
