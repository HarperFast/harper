const validate = require('validate.js');

const constraints = {
    schema : {
        presence : {
            message : " is required"
        },
        format: {

            pattern: "^[a-zA-Z0-9_]*$",
            message: "schema must be alpha numeric"
        },
        length: {
            maximum:250,
            tooLong: 'cannot exceed 250 characters'
        }
    },
    table: {
        presence : {
            message : " is required"
        },
        format: {

            pattern: "^[a-zA-Z0-9_]*$",
            message: "table must be alpha numeric"
        },
        length: {
            maximum:250,
            tooLong: 'cannot exceed 250 characters'
        }
    },
    file_path :{
        presence : false
    },
    csv_url :{
        presence : false,
        url: {
            allowLocal: true
        }
    },
    data :{
        presence : false
    }
};

function dataObject(object){
    constraints.data.presence = {
        message : " is required"
    };
    return validate(object, constraints);
}

function urlObject(object){
    constraints.csv_url.presence = {
        message : " is required"
    };
    return validate(object, constraints);
}

function fileObject(object){
    constraints.file_path.presence = {
        message : " is required"
    };
    return validate(object, constraints);
}

module.exports =  {
    dataObject,
    urlObject,
    fileObject
};