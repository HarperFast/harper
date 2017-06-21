const validate = require('validate.js');

const constraints = {
    schema : {
        presence : true,
        format: "[\\w\\-\\_]+"

    },
    table: {
        presence : true,
        format: "[\\w\\-\\_]+"

    }
    ,
    hash_values :{
        presence : true,
    }
};
module.exports = function(delete_object) {
    return validate(delete_object, constraints);
};