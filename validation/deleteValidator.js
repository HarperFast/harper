const validator = require('./validationWrapper.js');
const Joi = require('joi');
const { hdbTable, hdbDatabase } = require('./common_validators.js');

const deleteSchema = Joi.object({
	schema: hdbDatabase,
	database: hdbDatabase,
	table: hdbTable,
	hash_values: Joi.array().required(),
	ids: Joi.array(),
});

module.exports = function (deleteObject) {
	return validator.validateBySchema(deleteObject, deleteSchema);
};
