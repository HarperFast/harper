const { common_validators } = require('./common_validators');
const validator = require('./validationWrapper');
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

module.exports = function (insert_object) {
    return validator.validateObject(insert_object, constraints);
};

