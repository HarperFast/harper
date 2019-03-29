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
                for (let val of Object.keys(record)) {
                    if (!val || val.length === 0 || INVALID_ATTRIBUTE_NAMES[val] !== undefined) {
                        return {format: {message: `Invalid attribute name: ${val}`}};
                    }
                }
            }
            return null;
        }
};

module.exports = function (insert_object) {
    return validator.validateObject(insert_object, constraints);
};

