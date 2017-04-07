var validate = require('validate.js');

var constraints = {
    schema : {
        presence : true,
        format: "[\\w\\-\\_]+",
        exclusion: {
            within: ["system"],
            message: "Invalid Schema"
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
    ,
    hash_value :{
        presence : true,

    }
};
module.exports = function(delete_object) {
    return validate(delete_object, constraints);
};