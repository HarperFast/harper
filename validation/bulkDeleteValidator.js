const validator = require('./validationWrapper.js');
const validate = require('validate.js');

validate.validators.typeArray = function(value, options, key, attributes) {
    if (options === true) {
        if (validate.isArray(value)) {
            return null;
        } else {
            return key + " has value " + value + " which is not an Array";
        }
    } else {
        return null;
    }
};

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
    hash_values: {
        presence: true,
        typeArray: true
    }
};
module.exports = function (delete_object) {
    return validator.validateObject(delete_object, constraints);
};