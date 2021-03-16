const { schema_joi } = require('./common_validators');
const validator = require('./validationWrapper');
const Joi = require('joi');
const INVALID_ATTRIBUTE_NAMES = {
    "undefined":"undefined",
    "null":"null"
};

const custom_records_val = (value, helpers) => {
    const attributes = Object.keys(value);
    const attributes_length = attributes.length;
    let error_msg = undefined;
    for (let i = 0; i < attributes_length; i++) {
        const attribute = attributes[i];
        if (!attribute || attribute.length === 0 || INVALID_ATTRIBUTE_NAMES[attribute] !== undefined) {
            if (error_msg === undefined) {
                error_msg = `Invalid attribute name: '${attribute}'`;
            } else {
                error_msg += `. Invalid attribute name: '${attribute}'`;
            }
        }
    }

    if (error_msg) {
        return helpers.message(error_msg);
    }

    return value;
};

const insert_schema = Joi.object({
    schema: schema_joi,
    table: schema_joi,
    records: Joi.array().items(Joi.object().custom(custom_records_val)).min(1).required()
});

module.exports = function (insert_object) {
    return validator.validateBySchema(insert_object, insert_schema);
};
