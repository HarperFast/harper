const validate = require('validate.js');

var constraints = {
    schema : {
        presence : true


    },
    table: {
        presence : true


    },
    attribute :{
        presence : true


    }
};
module.exports = function(attribute_create_object) {
    return validate(attribute_create_object, constraints);
};