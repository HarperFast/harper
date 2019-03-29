const validator = require('./validationWrapper.js');
const INVALID_ATTRIBUTE_NAMES = {
    "undefined":"undefined",
    "null":"null"
}
const constraints = {
    schema: {
        presence: true,
        format: {
            pattern: "^[a-zA-Z0-9_]*$",
            message: "schema must be alpha numeric"
        },
        length: {
            maximum: 250,
            tooLong: 'cannot exceed 250 characters'
        }
    },
    table: {
        presence: true,
        format: {
            pattern: "^[a-zA-Z0-9_]*$",
            message: "schema must be alpha numeric"
        },
        length: {
            maximum: 250,
            tooLong: 'cannot exceed 250 characters'
        }
    },
    records: function(value, attributes, attributeName, options, constraints) {
            for (let record of attributes.records) {
                for (let attribute_name of Object.keys(record)) {
                    if (!attribute_name || attribute_name.length === 0 || INVALID_ATTRIBUTE_NAMES[attribute_name] !== undefined) {
                        return {format: {message: `Invalid attribute name: ${attribute_name}`}};
                    }
                }
            }
            return null;
        }
};

module.exports = function (insert_object) {
    return validator.validateObject(insert_object, constraints);
};

