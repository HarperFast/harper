import * as validator from './validationWrapper.js';
import Joi from 'joi';
import { hdbTable, hdbDatabase } from './common_validators.js';

const deleteSchema = Joi.object({
	schema: hdbDatabase,
	database: hdbDatabase,
	table: hdbTable,
	hash_values: Joi.array().required(),
	ids: Joi.array(),
});

export default function (deleteObject: any): Error | undefined {
	return validator.validateBySchema(deleteObject, deleteSchema);
};
