const validate = require('validate.js');

const constraints = {
    schema : {
        presence : true,
        format: {

            pattern: "^[a-zA-Z0-9_]*$",
            message: "must be alpha numeric"
        },
        length: {
            maximum:250,
            tooLong: 'cannot exceed 250 characters'
        }
    },
    table: {
        presence : true,
        format: {

            pattern: "^[a-zA-Z0-9_]*$",
            message: "must be alpha numeric"
        },
        length: {
            maximum:250,
            tooLong: 'cannot exceed 250 characters'
        }
    },
    attribute :{
        presence : true,
        format: {

            pattern: "^[a-zA-Z0-9_]*$",
            message: "must be alpha numeric"
        }

    },
    hash_attribute :{
        presence : true,
        format: {

            pattern: "^[a-zA-Z0-9_]*$",
            message: "must be alpha numeric"
        },
        length: {
            maximum:250,
            tooLong: 'cannot exceed 250 characters'
        }
    }
};


function makeAttributesStrings(object){
    for(attr in object){
        object[attr] = object[attr].toString();
    }


    return object;
}

function schema_object(object){
    object = makeAttributesStrings(object);
    constraints.schema.presence = {"message":" is required"};
    constraints.table.presence = false;
    constraints.attribute.presence = false;
    constraints.hash_attribute.presence = false;

    return validate(object, constraints);
}

function table_object(object){
    object = makeAttributesStrings(object);
    constraints.schema.presence = {"message":" is required"};
    constraints.table.presence = {"message":" is required"};
    constraints.attribute.presence = false;
    constraints.hash_attribute.presence = false;
    return validate(object, constraints);
}

function create_table_object(object){
    object = makeAttributesStrings(object);
    constraints.schema.presence = {"message":" is required"};
    constraints.table.presence = {"message":" is required"};
    constraints.attribute.presence = false;
    constraints.hash_attribute.presence = {"message":" is required"};
    return validate(object, constraints);
}

function attribute_object(object){
    object = makeAttributesStrings(object);
    constraints.schema.presence = {"message":" is required"};
    constraints.table.presence = {"message":" is required"};
    constraints.attribute.presence = {"message":" is required"};
    constraints.hash_attribute.presence = false;
    return validate(object, constraints);
}

function describe_table(object){
    object = makeAttributesStrings(object);
    constraints.schema.presence = {"message":" is required"};
    constraints.table.presence = {"message":" is required"};
    constraints.attribute.presence = false;
    constraints.hash_attribute.presence = false;

    return validate(object, constraints);
}



module.exports =  {
    schema_object: schema_object,
    create_table_object: create_table_object,
    table_object: table_object,
    attribute_object: attribute_object,
    describe_table: describe_table

};