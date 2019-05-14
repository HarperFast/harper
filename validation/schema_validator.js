const validate = require('validate.js'),
    validator = require('./validationWrapper.js');

const constraints = {
    schema: {
        presence: true,
        format: {
            pattern: "^[a-zA-Z0-9_]*$",
            message: "must be alpha numeric"
        },
        length: {
            maximum: 250,
            tooLong: 'cannot exceed 250 characters'
        }
    },
    table: {
        presence: true,
        format: {
            pattern: "^[a-zA-Z0-9_]*$",
            message: "must be alpha numeric"
        },
        length: {
            maximum: 250,
            tooLong: 'cannot exceed 250 characters'
        }
    },
    attribute: {
        presence: true,
        format: {
            pattern: "^[a-zA-Z0-9_]*$",
            message: "name can only contain alpha numeric characters or underscores"
        }

    },
    hash_attribute: {
        presence: true,
        format: {
            pattern: "^[a-zA-Z0-9_]*$",
            message: "name can only contain alpha numeric characters or underscores"
        },
        length: {
            maximum: 250,
            tooLong: 'cannot exceed 250 characters'
        }
    }
};


function makeAttributesStrings(object) {
    for (let attr in object) {
        object[attr] = object[attr].toString();
    }
    return object;
}

function schema_object(object) {
    object = makeAttributesStrings(object);
    constraints.schema.presence = {"message": " is required"};
    constraints.table.presence = false;
    constraints.attribute.presence = false;
    constraints.hash_attribute.presence = false;
    return validator.validateObject(object, constraints);
}

function table_object(object) {
    object = makeAttributesStrings(object);
    constraints.schema.presence = {"message": " is required"};
    constraints.table.presence = {"message": " is required"};
    constraints.attribute.presence = false;
    constraints.hash_attribute.presence = false;
    return validator.validateObject(object, constraints);
}

function create_table_object(object) {
    object = makeAttributesStrings(object);
    constraints.schema.presence = {"message": " is required"};
    constraints.table.presence = {"message": " is required"};
    constraints.attribute.presence = false;
    constraints.hash_attribute.presence = {"message": " is required"};
    return validator.validateObject(object, constraints);
}

function attribute_object(object) {
    object = makeAttributesStrings(object);
    constraints.schema.presence = {"message": " is required"};
    constraints.table.presence = {"message": " is required"};
    constraints.attribute.presence = {"message": " is required"};
    constraints.hash_attribute.presence = false;
    return validator.validateObject(object, constraints);
}

function describe_table(object) {
    object = makeAttributesStrings(object);
    constraints.schema.presence = {"message": " is required"};
    constraints.table.presence = {"message": " is required"};
    constraints.attribute.presence = false;
    constraints.hash_attribute.presence = false;
    return validator.validateObject(object, constraints);
}

/**
 * validates the residence attribute of the table object.  the residence must be an array of string if it is supplied
 * @param residence
 */
function validateTableResidence(residence){
    if(!residence){
        return;
    }

    if(!Array.isArray(residence)){
        throw new Error("residence must be a string array");
    }

    if(residence.length === 0) {
        throw new Error("residence cannot be an empty array");
    }

    for(let x = 0; x < residence.length; x++){
        if(typeof residence[x] !== 'string'){
            throw new Error(`residence must be a string array, item '${residence[x]}' is not a string`);
        }
    }

    return;
}

module.exports = {
    schema_object: schema_object,
    create_table_object: create_table_object,
    table_object: table_object,
    attribute_object: attribute_object,
    describe_table: describe_table,
    validateTableResidence: validateTableResidence
};