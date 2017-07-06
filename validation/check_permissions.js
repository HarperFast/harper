const validate = require('validate.js');

const constraints = {
    user : {
        presence : true


    },
    schema :{
        presence : true,
    },
    table: {
        presence : true


    }
    ,
    operation :{
        presence : true,
    }


};
module.exports = function(delete_object) {
    return validate(delete_object, constraints);
};