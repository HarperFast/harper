"use strict";

const insert = require('../data_layer/insert');
const search = require('../data_layer/search');
const delete_ = require('../data_layer/delete');
const validation = require('../validation/role_validation');
const signalling = require('../utility/signalling');
const uuidV4 = require('uuid/v4');
const util = require('util');
const license = require('../utility/registration/hdb_license');
const terms = require('../utility/hdbTerms');
const hdb_utils = require('../utility/common_utils');
const p_search_search_by_value = util.promisify(search.searchByValue);
const p_search_search_by_conditions = util.promisify(search.searchByConditions);
const p_delete_delete = util.promisify(delete_.delete);

module.exports = {
    addRole: addRole,
    alterRole:alterRole,
    dropRole: dropRole,
    listRoles
};

function scrubRoleDetails(role) {
    try {
        if(role.hdb_auth_header) {
            delete role.hdb_auth_header;
        }
        if(role.HDB_INTERNAL_PATH) {
            delete role.HDB_INTERNAL_PATH;
        }
        if(role.operation) {
            delete role.operation;
        }
        if(role.hdb_user) {
            delete role.hdb_user;
        }
    } catch(err) {
        //no-op, failure is ok
    }
    return role;
}

async function addRole(role){
    let validation_resp = validation.addRoleValidation(role);
    if(validation_resp) {
        throw new Error(validation_resp);
    }

    let license_details = await license.getLicense();
    if(!license_details.enterprise) {
        //look to see if there is already a cluster_user role
        let roles = await listRoles();
        let has_cluster_role = checkClusterUserRole(role, roles);
        if(has_cluster_role){
            throw new Error(`Your current license only supports ${terms.BASIC_LICENSE_MAX_CLUSTER_USER_ROLES} cluster_user role. ${terms.SUPPORT_HELP_MSG}`);
        }

        if (roles.length >= 2) {
            throw new Error(`Your current license only supports ${terms.BASIC_LICENSE_MAX_NON_CU_ROLES + terms.BASIC_LICENSE_MAX_CLUSTER_USER_ROLES} roles.  ${terms.SUPPORT_HELP_MSG}`);
        }
    }

    role = scrubRoleDetails(role);

    let search_obj = {
        schema: 'system',
        table : 'hdb_role',
        search_attribute : 'role',
        search_value : role.role,
        hash_attribute : 'id',
        get_attributes: ['*']
    };

    let search_role = await p_search_search_by_value(search_obj).catch((err) => {
        throw err;
    });

    if(search_role && search_role.length > 0) {
        search_role = scrubRoleDetails(search_role);
        return search_role[0];
    }

    if(!role.id)
        role.id = uuidV4();

    let insert_object = {
        operation:'insert',
        schema :  'system',
        table:'hdb_role',
        hash_attribute: 'id',
        records: [role]
    };

    let success = await insert.insert(insert_object).catch((err) => {
       throw err;
    });
    signalling.signalUserChange({type: 'user'});

    role = scrubRoleDetails(role);
    return role;
}

function checkClusterUserRole(add_role, roles){
    let has_cluster_role = false;
    if(add_role.permission.cluster_user === true){
        for(let x = 0; x < roles.length; x++){
            let role = roles[x];
            let permission = role.permission;
            if(!hdb_utils.isEmpty(permission) && permission.cluster_user === true){
                has_cluster_role = true;
                return;
            }
        }
    }
    return has_cluster_role;
}

async function alterRole(role){
    let validation_resp = validation.alterRoleValidation(role);
    if(validation_resp){
        throw new Error(validation_resp);
    }

    role = scrubRoleDetails(role);

    let update_object = {
        operation:'update',
        schema :  'system',
        table:'hdb_role',
        hash_attribute: 'rolename',
        records: [role]
    };

    let success = await insert.update(update_object).catch((err) => {
       throw err;
    });
    signalling.signalUserChange({type: 'user'});
    return success;
}

async function dropRole(role){
    let validation_resp = validation.dropRoleValidation(role);
    if(validation_resp){
        throw new Error(validation_resp);
    }

    let conditions = [
        {
            "and":
                {"=":["role",role.id]}
        },
        {"and":
                {"=":["active",true]}
        }
    ];

    let search_for_users = {
        schema:'system',
        table : 'hdb_user',
        conditions: conditions,
        get_attributes: ['username']
    };

    let search_for_role_name = {
        schema:'system',
        table : 'hdb_role',
        conditions: [{"and":{"=":["id",role.id]}}],
        get_attributes: ['role']
    };

    //TODO: This can be updated to searchByHash the next time this method is worked on - not critical
    let role_name = await p_search_search_by_conditions(search_for_role_name).catch((err) => {
        throw err;
    });
    if(role_name.length === 0) {
        throw new Error(`Role not found`);
    }

    let users = await p_search_search_by_conditions(search_for_users).catch((err) => {
       throw err;
    });
    if(users && users.length > 0){
        const dynamic_text = users.length === 1 ? "user is" : "users are";
        throw new Error(`Cannot drop role ${role_name[0].role} - ${users.length} ${dynamic_text} tied to this role`);
    }
    let delete_object = {
        table:"hdb_role",
        schema:"system",
        hash_values: [role.id]
    };

    await p_delete_delete(delete_object).catch((err) => {
       throw err;
    });

    signalling.signalUserChange({type: 'user'});
    return `${role_name[0].role} successfully deleted`;
}

async function listRoles(){
    let search_obj = {
        table: "hdb_role",
        schema: "system",
        hash_attribute:"id",
        search_attribute:"id",
        search_value:"*",
        get_attributes: ["*"]
    };

    let roles = await p_search_search_by_value(search_obj).catch((err) => {
       throw err;
    });

    return roles;
}

