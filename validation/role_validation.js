const validate = require('validate.js'),
    validator = require('./validationWrapper'),
    terms = require('../utility/hdbTerms'),
    { handleHDBError, hdb_errors } = require('../utility/errors/hdbError');

const { COMMON_ERROR_MSGS, HTTP_STATUS_CODES } = hdb_errors;

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

const ROLE_TYPES = ['super_user', 'cluster_user'];

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
    validateNoSUPerms(object);

    let validationErrors = [];

    let validate_result = validator.validateObject(object, constraints);
    if(validate_result) {
        validationErrors.push(validate_result);
    }

    if (object.permission.cluster_user) {
        if (!validate.isBoolean(object.permission.cluster_user))
            validationErrors.push(validate.isBoolean(object.permission.cluster_user));

        if(Object.keys(object.permission).length > 1){
            validationErrors.push(new Error(COMMON_ERROR_MSGS.CU_ROLE_NO_PERMS_MIX));
        }
    }

    if (object.permission.super_user) {
        if (!validate.isBoolean(object.permission.super_user))
            validationErrors.push(validate.isBoolean(object.permission.super_user));
    }

    for (let item in object.permission) {
        if (ROLE_TYPES.indexOf(item) < 0) {
            let schema = object.permission[item];
            if(!item || !global.hdb_schema[item]) {
                validationErrors.push(new Error(`Invalid schema ${item}`));
                continue;
            }
            if(schema.tables) {
                for(let t in schema.tables) {
                    let table = schema.tables[t];
                    if(!t || !global.hdb_schema[item][t]) {
                        validationErrors.push(new Error(`Invalid table ${t}`));
                        continue;
                    }
                    if(!validate.isDefined(table.read)) {
                        validationErrors.push(new Error(`Missing read permission on ${t}`));
                    }

                    if(!validate.isDefined(validate.isBoolean(table.read))) {
                        validationErrors.push(new Error(`${t}.read must be a boolean`));
                    }

                    if(!validate.isDefined(table.insert)) {
                        validationErrors.push(new Error(`Missing insert permission on ${t}`));
                    }

                    if(!validate.isDefined(validate.isBoolean(table.insert))) {
                        validationErrors.push(new Error(`${t}.insert must be a boolean`));
                    }

                    if(!validate.isDefined(table.update)) {
                        validationErrors.push(new Error(`Missing update permission on ${t}`));
                    }

                    if(!validate.isBoolean(table.update)) {
                        validationErrors.push(new Error(`${t}.update must be a boolean`));
                    }

                    if(!validate.isDefined(table.delete)) {
                        validationErrors.push(new Error(`Missing delete permission on ${t}`));
                    }

                    if(!validate.isBoolean(table.delete)) {
                        validationErrors.push(new Error(`${t}.delete must be a boolean`));
                    }

                    if (table.attribute_permissions) {
                        let table_attribute_names = global.hdb_schema[item][t].attributes.map(({attribute}) => attribute);
                        const attr_perms_check = {
                            read: false,
                            insert: false,
                            update: false
                        };
                        for(let r in table.attribute_permissions) {
                            let permission = table.attribute_permissions[r];
                            if(!permission.attribute_name || !table_attribute_names.includes(permission.attribute_name)) {
                                validationErrors.push(new Error(`Invalid attribute ${permission.attribute_name}`));
                                continue;
                            }

                            if(!validate.isDefined(permission.attribute_name))
                                validationErrors.push(new Error(`attribute_permission must have an attribute_name`));
                            if(!validate.isDefined(permission.read))
                                validationErrors.push(new Error(`attribute_permission missing read permission`));
                            if(!validate.isDefined(permission.insert))
                                validationErrors.push(new Error(`attribute_permission missing insert permission`));
                            if(!validate.isDefined(permission.update))
                                validationErrors.push(new Error(`attribute_permission missing update permission`));
                            if(!validate.isBoolean(permission.read))
                                validationErrors.push(new Error('attribute_permission.read must be boolean'));
                            if(!validate.isBoolean(permission.insert))
                                validationErrors.push(new Error('attribute_permission.insert must be boolean'));
                            if(!validate.isBoolean(permission.update))
                                validationErrors.push(new Error('attribute_permission.update must be boolean'));

                            //confirm that false table perms are not set to true for an attribute
                            if (!attr_perms_check.read && permission.read) {
                                attr_perms_check.read = true;
                            }
                            if (!attr_perms_check.insert && permission.insert) {
                                attr_perms_check.insert = true;
                            }
                            if (!attr_perms_check.update && permission.update) {
                                attr_perms_check.update = true;
                            }
                        }
                        if(!table.read && attr_perms_check.read ||
                            !table.insert && attr_perms_check.insert ||
                            !table.update && attr_perms_check.update) {
                            const schema_name = `${item}.${t}`;
                            validationErrors.push(new Error(COMMON_ERROR_MSGS.MISMATCHED_TABLE_ATTR_PERMS(schema_name)));
                        }
                    }
                }
            }
        }
    }
    if (validationErrors.length > 0) {
        let validation_message = "";
        validationErrors.forEach(valError => {
            validation_message += `${valError.message}. `;
        });

        return handleHDBError(new Error(), validation_message, HTTP_STATUS_CODES.BAD_REQUEST, );
    }
    return null;
}

function validateNoSUPerms(obj) {
    const { operation, permission } = obj;
    if (operation === terms.OPERATIONS_ENUM.ADD_ROLE || operation === terms.OPERATIONS_ENUM.ALTER_ROLE) {
        //Check if role type is super user or cluster user
        const is_su_cu_role = permission.super_user || permission.cluster_user;
        const has_perms = permission.attribute_permissions && Object.keys(permission.attribute_permissions).length > 1;
        if (is_su_cu_role && has_perms) {
            throw handleHDBError(new Error(), COMMON_ERROR_MSGS.SU_CU_ROLE_NO_PERMS_ALLOWED, HTTP_STATUS_CODES.BAD_REQUEST, );
        }
    }
}

module.exports = {
    addRoleValidation: addRoleValidation,
    alterRoleValidation: alterRoleValidation,
    dropRoleValidation: dropRoleValidation

};
