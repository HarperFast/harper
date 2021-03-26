const schema_regex = /^[\x20-\x2E|\x30-\x5F|\x61-\x7E]*$/;
const Joi = require('joi');

const common_validators = {
    schema_format: {
        pattern: schema_regex,
        message: "names cannot include backticks or forward slashes"
    },
    schema_length: {
        maximum: 250,
        tooLong: 'cannot exceed 250 characters'
    }
};

// A Joi schema that can be used to validate hdb schemas and tables.
const hdb_schema_table = Joi.alternatives(
    Joi.string().min(1).max(common_validators.schema_length.maximum).pattern(schema_regex)
        .messages({'string.pattern.base': '{:#label} ' + common_validators.schema_format.message}),
    Joi.number()).required();

module.exports = {
    common_validators,
    schema_regex,
    hdb_schema_table
};
