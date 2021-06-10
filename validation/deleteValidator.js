const validator = require('./validationWrapper');
const Joi = require('joi');
const { hdb_schema_table } = require('./common_validators');

const delete_schema = Joi.object({
    schema: hdb_schema_table,
    table: hdb_schema_table,
    hash_values: Joi.array().required()
});

module.exports = function (delete_object) {
    return validator.validateBySchema(delete_object, delete_schema);
};
