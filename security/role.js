const insert = require('../data_layer/insert');
const search = require('../data_layer/search');
const delete_ = require('../data_layer/delete');
const validation = require('../validation/role_validation');
const signalling = require('../utility/signalling');
const uuidV4 = require('uuid/v4');
const {promisify} = require('util');

const p_search_search_by_value = promisify(search.searchByValue);
const p_search_search_by_conditions = promisify(search.searchByConditions);
const p_delete_delete = promisify(delete_.delete);

module.exports = {
    addRole: addRoleCB,
    alterRole:alterRoleCB,
    dropRole: dropRoleCB,
    listRoles: listRolesCB
};

function addRoleCB(role, callback){
    let added_role = {};
    addRole(role).then((result) => {
        added_role = result;
        return callback(null, added_role);
    }).catch((err) => {
        return callback(err, null);
    });
}

function scrubRoleDetails(role) {
    try {
        if(role.hdb_auth_header) {
            delete role.hdb_auth_header;
        }
        if(role.HDB_INTERNAL_PATH) {
            delete role.HDB_INTERNAL_PATH;
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

    role = scrubRoleDetails(role);

    let search_obj = {
        schema: 'system',
        table : 'hdb_role',
        search_attribute : 'role',
        search_value : role.role,
        hash_attribute : 'id',
        get_attributes: ['id']
    };

    let search_role = await p_search_search_by_value(search_obj).catch((err) => {
        throw err;
    });

    if(search_role && search_role.length > 0) {
        search_role = scrubRoleDetails(search_role);
        return search_role;
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

function alterRoleCB(role, callback){
    let updated_role = {};
    alterRole(role).then((result) => {
        updated_role = result;
        return callback(null, updated_role);
    }).catch((err) => {
        return callback(err, null);
    });
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

function dropRoleCB(role, callback){
    let dropped_role = {};
    dropRole(role).then((result) => {
        dropped_role = result;
        return callback(null, dropped_role);
    }).catch((err) => {
        return callback(err, null);
    });
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
        throw new Error(`Cannot drop role ${role_name[0].role} ${users.length} users are tied to this role`);
    }
    let delete_object = {
        table:"hdb_role",
        schema:"system",
        hash_values: [role.id]
    };

    let success = await p_delete_delete(delete_object).catch((err) => {
       throw err;
    });

    signalling.signalUserChange({type: 'user'});
    return `${role_name[0].role} successfully deleted`;
}

function listRolesCB(req_body, callback){
    let role_list = {};
    listRoles().then((result) => {
        role_list = result;
        return callback(null, role_list);
    }).catch((err) => {
        return callback(err, null);
    });
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

