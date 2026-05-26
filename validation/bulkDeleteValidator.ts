import * as validator from './validationWrapper.ts';
import Joi from 'joi';
import { hdbTable, hdbDatabase } from './common_validators.ts';

const validationSchema = {
	schema: hdbDatabase,
	database: hdbDatabase,
	table: hdbTable,
};

const dateSchema = {
	date: Joi.date().iso().required(),
};

const timestampSchema = {
	timestamp: Joi.date().timestamp().required().messages({ 'date.format': "'timestamp' is invalid" }),
};

export default function (deleteObject: any, dateFormat: any) {
	const finalSchema =
		dateFormat === 'timestamp' ? { ...validationSchema, ...timestampSchema } : { ...validationSchema, ...dateSchema };
	const bulkDeleteSchema = Joi.object(finalSchema);
	return validator.validateBySchema(deleteObject, bulkDeleteSchema);
}
