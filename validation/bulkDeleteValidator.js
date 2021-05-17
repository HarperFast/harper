const validator = require('./validationWrapper');
const validate = require('validate.js');
const { common_validators } = require('./common_validators');

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
    }
};

const date_constraints = {
    date: {
        presence: { message: "is required" }
    }
};

const timestamp_constraints = {
    timestamp: {
        presence: { message: "is required" }
    }
};

module.exports = function (delete_object, date_format) {
    const final_constraints = date_format === 'timestamp' ? {...constraints, ...timestamp_constraints} : {...constraints, ...date_constraints};
    return validator.validateObject(delete_object, final_constraints);
};
