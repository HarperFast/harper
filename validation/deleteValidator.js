const validator = require('./validationWrapper');
const Joi = require('joi');
const { hdb_table, hdb_database } = require('./common_validators');

const delete_schema = Joi.object({
	schema: hdb_database,
	database: hdb_database,
	table: hdb_table,
	hash_values: Joi.array().required(),
	ids: Joi.array(),
});

module.exports = function (delete_object) {
	return validator.validateBySchema(delete_object, delete_schema);
};
