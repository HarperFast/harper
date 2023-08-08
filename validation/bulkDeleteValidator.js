const validator = require('./validationWrapper');
const Joi = require('joi');
const { hdb_table, hdb_database } = require('./common_validators');

const validation_schema = {
	schema: hdb_database,
	database: hdb_database,
	table: hdb_table,
};

const date_schema = {
	date: Joi.date().iso().required(),
};

const timestamp_schema = {
	timestamp: Joi.date().timestamp().required().messages({ 'date.format': "'timestamp' is invalid" }),
};

module.exports = function (delete_object, date_format) {
	const final_schema =
		date_format === 'timestamp'
			? { ...validation_schema, ...timestamp_schema }
			: { ...validation_schema, ...date_schema };
	const bulk_delete_schema = Joi.object(final_schema);
	return validator.validateBySchema(delete_object, bulk_delete_schema);
};
