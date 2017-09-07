const validate = require('validate.js');

const constraints = {
    schema : {
        presence : true,
        format: {
            pattern: "^[a-zA-Z0-9_]*$",
            message: "schema must be alpha numeric"
        },
        length: {
            maximum:250,
            tooLong: 'cannot exceed 250 characters'
        }
    },
    table : {
        presence : true,
        format: {
            pattern: "^[a-zA-Z0-9_]*$",
            message: "schema must be alpha numeric"
        },
        length: {
            maximum:250,
            tooLong: 'cannot exceed 250 characters'
        }
    },
    records: {
        presence : true,
        format: function(value) {
            if(!validate.isArray(value)){
                return {message: 'must be an array'};
            }

            return null;
        }
    }
};

module.exports = function(insert_object) {
    return validate(insert_object, constraints);
};

