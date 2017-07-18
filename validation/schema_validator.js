const validate = require('validate.js');

const constraints = {
    schema : {
        presence : true,
        format: "^[a-zA-Z0-9_]*$"


    },
    table: {
        presence : true,
        format: "^[a-zA-Z0-9_]*$"

    },
    attribute :{
        presence : true,
        format: "^[a-zA-Z0-9_]*$"

    },
    hash_attribute :{
        presence : true,
        format: "[\\w\\-\\_]+"

    }
};




function schema_object(object){
    constraints.schema.presence = true;
    constraints.table.presence = false;
    constraints.attribute.presence = false;
    constraints.hash_attribute.presence = false;

    return validate(object, constraints);
}

function table_object(object){
    constraints.schema.presence = true;
    constraints.table.presence = true;
    constraints.attribute.presence = false;
    constraints.hash_attribute.presence = true;
    return validate(object, constraints);
}

function attribute_object(object){
    constraints.schema.presence = true;
    constraints.table.presence = true;
    constraints.attribute.presence = true;
    constraints.hash_attribute.presence = false;
    return validate(object, constraints);
}

function describe_table(object){
    constraints.schema.presence = true;
    constraints.table.presence = false;
    constraints.attribute.presence = false;
    constraints.hash_attribute.presence = false;

    return validate(object, constraints);
}



module.exports =  {
    schema_object: schema_object,
    table_object: table_object,
    attribute_object: attribute_object,
    describe_table: describe_table

};