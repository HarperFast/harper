const validate = require('validate');

const constraints = {
    schema : {
        presence : true
    },
    table : {
        presence : true
    },
    hash_attribute :{
        presence : true
    },
    hash_value: {
        presence : true
    },
    object:{
        presence : true
    }
};
module.exports = function(insert_object) {
    return validate(insert_object, constraints);
};