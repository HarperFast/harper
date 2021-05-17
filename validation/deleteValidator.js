const { common_validators } = require('./common_validators');
const validate = require('validate.js');
const validator = require('./validationWrapper');

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
        presence: { message: "is required" },
        format: common_validators.schema_format,
        length: common_validators.schema_length
    },
    table: {
        presence: { message: "is required" },
        format: common_validators.schema_format,
        length: common_validators.schema_length
    },
    hash_values: {
        presence: { message: "is required" },
        typeArray: true
    }
};

module.exports = function (delete_object) {
    return validator.validateObject(delete_object, constraints);
};
