var validate = require('validate.js');

var constraints = {
   schema : {
        presence : true


    },
    table: {
        presence : true


    }
};
module.exports = function(describe_table_object) {
    return validate(describe_table_object, constraints);
};