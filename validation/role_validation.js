const validate = require('validate.js'),
    validator = require('./validationWrapper'),
    terms = require('../utility/hdbTerms'),
    { handleHDBError, hdb_errors } = require('../utility/errors/hdbError'),
    _ = require('lodash');

const { COMMON_ERROR_MSGS, HTTP_STATUS_CODES } = hdb_errors;

const constraints_template = () => ({
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
});

const ROLE_TYPES_ENUM = {
    SUPER_USER: 'super_user',
    CLUSTER_USER: 'cluster_user'
};
const ROLE_TYPES = Object.values(ROLE_TYPES_ENUM);
const ATTR_PERMS_KEY = "attribute_permissions";
const ATTR_NAME_KEY = "attribute_name";
const ROLE_PERM_KEYS = ["operation", "role", "permission"];
const { PERMS_CRUD_ENUM } = terms;
const TABLE_PERM_KEYS = [ATTR_PERMS_KEY, ...Object.values(PERMS_CRUD_ENUM)];
const ATTR_PERMS_KEYS = [PERMS_CRUD_ENUM.READ, PERMS_CRUD_ENUM.INSERT, PERMS_CRUD_ENUM.UPDATE];

function addRoleValidation(object) {
    const constraints = constraints_template();
    constraints.role.presence = true;
    constraints.id.presence = false;
    constraints.permission.presence = true;
    return customValidate(object, constraints);
}

function alterRoleValidation(object) {
    const constraints = constraints_template();
    constraints.role.presence = false;
    constraints.id.presence = true;
    constraints.permission.presence = true;
    return customValidate(object, constraints);
}

function dropRoleValidation(object) {
    const constraints = constraints_template();
    constraints.role.presence = false;
    constraints.id.presence = true;
    constraints.permission.presence = false;
    return validator.validateObject(object, constraints);
}

function customValidate(object, constraints) {
    let validationErrors = {
        main_permissions: [],
        schema_permissions: {}
    };

    let validate_result = validator.validateObject(object, constraints);
    if (validate_result) {
        validate_result.message.split(',').forEach(validation_err => {
            addPermError(validation_err, validationErrors);
        })
    }

    ROLE_TYPES.forEach(role => {
        if (object.permission && object.permission[role]) {
            validateNoSUPerms(object);
            if (!validate.isBoolean(object.permission[role])) {
                addPermError(COMMON_ERROR_MSGS.SU_CU_ROLE_BOOLEAN_ERROR(role), validationErrors);
            }
        }
    })

    for (let item in object.permission) {
        if (ROLE_TYPES.indexOf(item) < 0) {
            let schema = object.permission[item];
            if(!item || !global.hdb_schema[item]) {
                addPermError(COMMON_ERROR_MSGS.SCHEMA_NOT_FOUND(item), validationErrors, schema);
                continue;
            }
            if(schema.tables) {
                for(let t in schema.tables) {
                    let table = schema.tables[t];
                    if(!t || !global.hdb_schema[item][t]) {
                        addPermError(COMMON_ERROR_MSGS.TABLE_NOT_FOUND(item, t), validationErrors, item, t);
                        continue;
                    }

                    //validate all table perm keys are valid
                    Object.keys(table).forEach(table_key => {
                        if (!TABLE_PERM_KEYS.includes(table_key)) {
                            addPermError(COMMON_ERROR_MSGS.INVALID_PERM_KEY(table_key), validationErrors, item, t);
                        }
                    });

                    //validate table CRUD perms
                    Object.values(PERMS_CRUD_ENUM).forEach(perm_key => {
                        if(!validate.isDefined(table[perm_key])) {
                            addPermError(COMMON_ERROR_MSGS.TABLE_PERM_MISSING(perm_key), validationErrors, item, t);
                        } else if (!validate.isBoolean(table[perm_key])) {
                            addPermError(COMMON_ERROR_MSGS.TABLE_PERM_NOT_BOOLEAN(perm_key), validationErrors, item, t);
                        }
                    });

                    //validate table ATTRIBUTE_PERMISSIONS perm
                    if(!validate.isDefined(table.attribute_permissions)) {
                        addPermError(COMMON_ERROR_MSGS.ATTR_PERMS_ARRAY_MISSING, validationErrors, item, t);
                        continue;
                    } else if (!validate.isArray(table.attribute_permissions)) {
                        addPermError(COMMON_ERROR_MSGS.ATTR_PERMS_NOT_ARRAY, validationErrors, item, t);
                        continue;
                    }

                    if (table.attribute_permissions) {
                        let table_attribute_names = global.hdb_schema[item][t].attributes.map(({attribute}) => attribute);
                        const attr_perms_check = {
                            read: false,
                            insert: false,
                            update: false
                        };

                        for (let r in table.attribute_permissions) {
                            let permission = table.attribute_permissions[r];

                            //validate that attribute_name is included
                            if(!validate.isDefined(permission.attribute_name)) {
                                addPermError(COMMON_ERROR_MSGS.ATTR_PERM_MISSING_NAME, validationErrors, item, t);
                                continue;
                            }

                            const attr_name = permission.attribute_name;
                            //validate that attr exists in schema for table
                            if(!table_attribute_names.includes(attr_name)) {
                                addPermError(COMMON_ERROR_MSGS.INVALID_ATTRIBUTE_IN_PERMS(attr_name), validationErrors, item, t);
                                continue;
                            }

                            //validate table attribute CRU perms
                            ATTR_PERMS_KEYS.forEach(perm_key => {
                                if(!validate.isDefined(permission[perm_key])) {
                                    addPermError(COMMON_ERROR_MSGS.ATTR_PERM_MISSING(perm_key, attr_name), validationErrors, item, t);
                                } else if (!validate.isBoolean(permission[perm_key])) {
                                    addPermError(COMMON_ERROR_MSGS.ATTR_PERM_NOT_BOOLEAN(perm_key, attr_name), validationErrors, item, t);
                                }
                            });

                            //confirm that false table perms are not set to true for an attribute
                            if (!attr_perms_check.read && permission.read === true) {
                                attr_perms_check.read = true;
                            }
                            if (!attr_perms_check.insert && permission.insert === true) {
                                attr_perms_check.insert = true;
                            }
                            if (!attr_perms_check.update && permission.update === true) {
                                attr_perms_check.update = true;
                            }
                        }
                        if(table.read === false && attr_perms_check.read === true ||
                            table.insert === false && attr_perms_check.insert === true ||
                            table.update === false && attr_perms_check.update === true) {
                            const schema_name = `${item}.${t}`;
                            addPermError(COMMON_ERROR_MSGS.MISMATCHED_TABLE_ATTR_PERMS(schema_name), validationErrors, item, t);
                        }
                    }
                }
            }
        }
    }

    return generateRolePermResponse(validationErrors);
}

module.exports = {
    addRoleValidation: addRoleValidation,
    alterRoleValidation: alterRoleValidation,
    dropRoleValidation: dropRoleValidation

};

function validateNoSUPerms(obj) {
    const { operation, permission } = obj;
    if (operation === terms.OPERATIONS_ENUM.ADD_ROLE || operation === terms.OPERATIONS_ENUM.ALTER_ROLE) {
        //Check if role type is super user or cluster user
        const is_su_cu_role = permission.super_user === true || permission.cluster_user === true;
        const has_perms = Object.keys(permission).length > 1;
        if (is_su_cu_role && has_perms) {
            const role_type = permission.super_user ? ROLE_TYPES_ENUM.SUPER_USER : ROLE_TYPES_ENUM.CLUSTER_USER
            throw handleHDBError(new Error(), COMMON_ERROR_MSGS.SU_CU_ROLE_NO_PERMS_ALLOWED(role_type), HTTP_STATUS_CODES.BAD_REQUEST, );
        }
    }
}

function generateRolePermResponse(validationErrors) {
    const { main_permissions, schema_permissions } = validationErrors;
    if (main_permissions.length > 0 || Object.keys(schema_permissions).length > 0) {
        let validation_message = {
            error: COMMON_ERROR_MSGS.ROLE_PERMS_ERROR,
            ...validationErrors
        };

        return handleHDBError(new Error(), validation_message, HTTP_STATUS_CODES.BAD_REQUEST, );
    } else {
        return null;
    }

}

function addPermError(err, invalid_perms_obj, schema, table) {
    if (!schema) {
        invalid_perms_obj.main_permissions.push(err);
    } else {
        const schema_key = table ? schema + "_" + table : schema;
        if (!invalid_perms_obj.schema_permissions[schema_key]) {
            invalid_perms_obj.schema_permissions[schema_key] = [err];
        } else {
            invalid_perms_obj.schema_permissions[schema_key].push(err);
        }
    }
}
