const validate = require('validate.js');

const constraints = {
    name : {
        presence : true
    },
    port : {
        presence : true
    },
    host: {
        presence : true
    }
};

module.exports = function(insert_object) {
    return validate(insert_object, constraints);
};

