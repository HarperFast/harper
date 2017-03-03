var validate = require('validate.js');

var constraints = {
    schema : {
        presence : true,
        format: "[\\w\\-\\_]+",
        exclusion: {
            within: ["system"],
            message: "You cannot create tables within the system schema"
        }

    },
    table: {
        presence : true,
        format: "[\\w\\-\\_]+"

    },
    hash_attribute :{
        presence : true,
        format: "[\\w\\-\\_]+"

    }
};
module.exports = function(table_create_object) {
    return validate(table_create_object, constraints);
};