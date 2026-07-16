import * as validator from './validationWrapper.ts';
import Joi from 'joi';
import { hdbTable, hdbDatabase } from './common_validators.ts';

// `hash_values`/`ids` are lists of primary keys. Items may be strings, numbers, or composite
// (array/object) keys, but never `null`/`undefined`: a null key is coerced downstream into a
// whole-collection target that wipes the table (see HarperFast/studio#1199), reject at the boundary.
const hashValue = Joi.any().invalid(null).messages({
	'any.invalid': `'hash_values' must not contain null`,
});

const deleteSchema = Joi.object({
	schema: hdbDatabase,
	database: hdbDatabase,
	table: hdbTable,
	hash_values: Joi.array().items(hashValue).required(),
	ids: Joi.array().items(hashValue),
});

export default function (deleteObject: any) {
	return validator.validateBySchema(deleteObject, deleteSchema);
}
