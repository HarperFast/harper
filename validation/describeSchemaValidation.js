var validate = require('validate.js');

var constraints = {
    schema : {
        presence : true,
        format: "[\\w\\-\\_]+"

    }
};
module.exports = function(describe_table_object) {
    return validate(describe_table_object, constraints);
};