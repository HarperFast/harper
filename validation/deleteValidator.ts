import * as validator from './validationWrapper.ts';
import Joi from 'joi';
import { hdbTable, hdbDatabase } from './common_validators.ts';

const deleteSchema = Joi.object({
	schema: hdbDatabase,
	database: hdbDatabase,
	table: hdbTable,
	hash_values: Joi.array().required(),
	ids: Joi.array(),
});

export default function (deleteObject: any) {
	return validator.validateBySchema(deleteObject, deleteSchema);
}
