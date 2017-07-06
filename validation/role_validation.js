var validate = require('validate.js');

var constraints = {
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
    return customValidate(object);
}

function customValidate(object) {
    var validationErrors = [];

    if(validate(object, constraints)){
        validationErrors.push(validate(object, constraints));
    }

    if (object.permission.super_admin) {
        if (!validate.isBoolean(object.permission.super_admin))
            validationErrors.push(validate.isBoolean(object.permission.super_admin));

    }

    for (item in  object.permission) {
        if (item != 'super_admin') {
            let schema = object.permission[item];
            if(schema.tables ){
                for(t in schema.tables){
                    let table = schema.tables[t];
                    if(!validate.isDefined(table.read)){
                        validationErrors.push(`Missing read permission on ${t}`)
                    }

                    if(!validate.isDefined(validate.isBoolean(table.read))){
                        validationErrors.push(`${t}.read must be a boolean`)
                    }

                    if(!validate.isDefined(table.insert)){
                        validationErrors.push(`Missing insert permission on ${t}`)
                    }

                    if(!validate.isDefined(validate.isBoolean(table.insert))){
                        validationErrors.push(`${t}.insert must be a boolean`)
                    }

                    if(!validate.isDefined(table.update)){
                        validationErrors.push(`Missing update permission on ${t}`)
                    }

                    if(!validate.isBoolean(table.update)){
                        validationErrors.push(`${t}.update must be a boolean`)
                    }


                    if(!validate.isDefined(table.delete)){
                        validationErrors.push(`Missing delete permission on ${t}`)
                    }

                    if(!validate.isBoolean(table.delete)){
                        validationErrors.push(`${t}.delete must be a boolean`)
                    }

                    if(table.attribute_restrictions){
                        for(r in table.attribute_restrictions){
                            let restriction = table.attribute_restrictions[r];
                            if(!validate.isDefined(restriction.attribute_name))
                                validationErrors.push(`attribute_restriction must have an attribute_name`);
                            if(!validate.isDefined(restriction.read))
                                validationErrors.push(`attribute_restriction missing read permission`);
                            if(!validate.isDefined(restriction.insert))
                                validationErrors.push(`attribute_restriction missing insert permission`);
                            if(!validate.isDefined(restriction.update))
                                validationErrors.push(`attribute_restriction missing update permission`);
                            if(!validate.isDefined(restriction.delete))
                                validationErrors.push(`attribute_restriction missing delete permission`);
                            if(!validate.isBoolean(restriction.read))
                                validationErrors.push('attribute_restriction.read must be boolean');
                            if(!validate.isBoolean(restriction.insert))
                                validationErrors.push('attribute_restriction.insert must be boolean');
                            if(!validate.isBoolean(restriction.update))
                                validationErrors.push('attribute_restriction.update must be boolean');
                            if(!validate.isBoolean(restriction.delete))
                                validationErrors.push('attribute_restriction.delete must be boolean');





                        }
                    }


                }
            }

        }
    }
    if(validationErrors.length > 0)
        return validationErrors;

    return null;

}




module.exports = {
    addRoleValidation: addRoleValidation,
    alterRoleValidation: alterRoleValidation,
    dropRoleValidation: dropRoleValidation

};