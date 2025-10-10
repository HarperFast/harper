const validator = require('./validationWrapper.js');
const Joi = require('joi');
const { hdbTable, hdbDatabase } = require('./common_validators.js');

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

module.exports = function (deleteObject, dateFormat) {
	const finalSchema =
		dateFormat === 'timestamp'
			? { ...validationSchema, ...timestampSchema }
			: { ...validationSchema, ...dateSchema };
	const bulkDeleteSchema = Joi.object(finalSchema);
	return validator.validateBySchema(deleteObject, bulkDeleteSchema);
};
