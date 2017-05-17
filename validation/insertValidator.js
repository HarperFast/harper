const validate = require('validate.js');

const constraints = {
    schema : {
        presence : true
    },
    table : {
        presence : true
    },
    records: {
        presence : true
    }
};

module.exports = function(insert_object) {
    return validate(insert_object, constraints);
};

