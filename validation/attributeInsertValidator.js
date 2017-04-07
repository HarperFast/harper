var validate = require('validate.js');

var constraints = {
    schema : {
        presence : true,
        format: "[\\w\\-\\_]+"

    },
    table: {
        presence : true,
        format: "[\\w\\-\\_]+"

    },
    attribute :{
        presence : true,
        format: "[\\w\\-\\_]+"

    }
};
module.exports = function(attribute_create_object) {
    return validate(attribute_create_object, constraints);
};