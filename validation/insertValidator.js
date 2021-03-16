const { schema_joi } = require('./common_validators');
const validator = require('./validationWrapper');
const Joi = require('joi');
const INVALID_ATTRIBUTE_NAMES = {
    "undefined":"undefined",
    "null":"null"
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
