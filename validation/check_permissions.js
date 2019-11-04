const validator = require('./validationWrapper');

const constraints = {
    user: {
        presence: true
    },
    schema: {
        presence: true,
    },
    table: {
        presence: true
    },
    operation: {
        presence: true,
    }
};
module.exports = function (delete_object) {
    return validator.validateObject(delete_object, constraints);
};