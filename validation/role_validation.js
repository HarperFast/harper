const validate = require('validate.js'),
    validator = require('./validationWrapper.js');

const constraints = {
    role: {
        presence: true,
        format: "[\\w\\-\\_]+"
    },
    id: {
        presence: true,
        format: "[\\w\\-\\_]+"
    },
    permission: {
        presence: true
    }
};

function addRoleValidation(object) {
    constraints.role.presence = true;
    constraints.id.presence = false;
    constraints.permission.presence = true;
    return customValidate(object);
}

function alterRoleValidation(object) {
    constraints.role.presence = false;
    constraints.id.presence = true;
    constraints.permission.presence = true;
    return customValidate(object);
}

function dropRoleValidation(object) {
    constraints.role.presence = false;
    constraints.id.presence = true;
    constraints.permission.presence = false;
    return validator.validateObject(object, constraints);
}

function customValidate(object) {
    let validationErrors = [];

    let validate_result = validator.validateObject(object, constraints);
    if(validate_result) {
        validationErrors.push(validate_result);
    }

    if (object.permission.super_user) {
        if (!validate.isBoolean(object.permission.super_user))
            validationErrors.push(validate.isBoolean(object.permission.super_user));
    }

    for (item in  object.permission) {
        if (item != 'super_user') {
            let schema = object.permission[item];
            if(schema.tables ){
                for(t in schema.tables){
                    let table = schema.tables[t];
                    if(!validate.isDefined(table.read)){
                        validationErrors.push(new Error(`Missing read permission on ${t}`));
                    }

                    if(!validate.isDefined(validate.isBoolean(table.read))){
                        validationErrors.push(new Error(`${t}.read must be a boolean`));
                    }

                    if(!validate.isDefined(table.insert)){
                        validationErrors.push(new Error(`Missing insert permission on ${t}`));
                    }

                    if(!validate.isDefined(validate.isBoolean(table.insert))){
                        validationErrors.push(new Error(`${t}.insert must be a boolean`));
                    }

                    if(!validate.isDefined(table.update)){
                        validationErrors.push(new Error(`Missing update permission on ${t}`));
                    }

                    if(!validate.isBoolean(table.update)){
                        validationErrors.push(new Error(`${t}.update must be a boolean`));
                    }

                    if(!validate.isDefined(table.delete)){
                        validationErrors.push(new Error(`Missing delete permission on ${t}`));
                    }

                    if(!validate.isBoolean(table.delete)){
                        validationErrors.push(new Error(`${t}.delete must be a boolean`));
                    }

                    if(table.attribute_restrictions){
                        for(r in table.attribute_restrictions){
                            let restriction = table.attribute_restrictions[r];
                            if(!validate.isDefined(restriction.attribute_name))
                                validationErrors.push(new Error(`attribute_restriction must have an attribute_name`));
                            if(!validate.isDefined(restriction.read))
                                validationErrors.push(new Error(`attribute_restriction missing read permission`));
                            if(!validate.isDefined(restriction.insert))
                                validationErrors.push(new Error(`attribute_restriction missing insert permission`));
                            if(!validate.isDefined(restriction.update))
                                validationErrors.push(new Error(`attribute_restriction missing update permission`));
                            if(!validate.isDefined(restriction.delete))
                                validationErrors.push(new Error(`attribute_restriction missing delete permission`));
                            if(!validate.isBoolean(restriction.read))
                                validationErrors.push(new Error('attribute_restriction.read must be boolean'));
                            if(!validate.isBoolean(restriction.insert))
                                validationErrors.push(new Error('attribute_restriction.insert must be boolean'));
                            if(!validate.isBoolean(restriction.update))
                                validationErrors.push(new Error('attribute_restriction.update must be boolean'));
                            if(!validate.isBoolean(restriction.delete))
                                validationErrors.push(new Error('attribute_restriction.delete must be boolean'));
                        }
                    }
                }
            }
        }
    }
    if(validationErrors.length > 0) {
        let validation_message = '';
        validationErrors.forEach( (valError)=> {
            validation_message += `${valError.message}. `;
        });

        return new Error(validation_message);
    }
    return null;
}

module.exports = {
    addRoleValidation: addRoleValidation,
    alterRoleValidation: alterRoleValidation,
    dropRoleValidation: dropRoleValidation

};