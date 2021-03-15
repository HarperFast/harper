const { common_validators, schema_joi } = require('./common_validators');
const validator = require('./validationWrapper');
const Joi = require('joi');
const hdb_terms = require('../utility/hdbTerms');
const INVALID_ATTRIBUTE_NAMES = {
    "undefined":"undefined",
    "null":"null"
};

const constraints = {
    schema: {
        presence: true,
        format: common_validators.schema_format,
        length: common_validators.schema_length
    },
    table: {
        presence: true,
        format: common_validators.schema_format,
        length: common_validators.schema_length
    },
    records: function(value, attributes, attributeName, options, constraints) {
            for (let record of attributes.records) {
                for (let attribute_name of Object.keys(record)) {
                    if (!attribute_name || attribute_name.length === 0 || INVALID_ATTRIBUTE_NAMES[attribute_name] !== undefined) {
                        return {format: {message: `Invalid attribute name: '${attribute_name}'`}};
                    }
                }
            }
            return null;
        }
};

const records_customer_val = (value, helpers) => {
    const attribute = Object.keys(value)[0];
    if (!attribute || attribute.length === 0 || INVALID_ATTRIBUTE_NAMES[attribute] !== undefined) {
        return helpers.message(`Invalid attribute name: '${attribute}'`);
    }

    return attribute;
};

const insert_schema = Joi.object({
    schema: schema_joi,
    table: schema_joi,
    records: Joi.array().items(Joi.object().custom(records_customer_val, 'customer val'))
});

module.exports = function (insert_object) {
    return validator.validateBySchema(insert_object, insert_schema);
};
