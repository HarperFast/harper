const insert = require('../data_layer/insert'),
    search = require('../data_layer/search'),
    delete_ = require('../data_layer/delete'),
    validation = require('../validation/role_validation'),
    signalling  = require('../utility/signalling'),
    uuidV4 = require('uuid/v4');

module.exports = {
    addRole: addRole,
    alterRole:alterRole,
    dropRole: dropRole,
    listRoles: listRoles
};

function addRole(role, callback){
    let validation_resp = validation.addRoleValidation(role);
    if(validation_resp){
        callback(validation_resp);
        return;
    }

    delete role.hdb_user;
    delete role.operation;

    let search_obj = {
        schema: 'system',
        table : 'hdb_role',
        search_attribute : 'role',
        search_value : role.role,
        hash_attribute : 'id',
        get_attributes: ['id']
    };

    search.searchByValue(search_obj, function (err, search_role) {
        if(err){
            return callback(err);
        }
        if(search_role && search_role.length > 0){
            return callback('Role already exists');

        }
        if(!role.id)
            role.id =  role.id = uuidV4();

        let insert_object = {
            operation:'insert',
            schema :  'system',
            table:'hdb_role',
            hash_attribute: 'id',
            records: [role]
        };

        insert.insert(insert_object, function(err, success){
            if(err){
                callback(err);
                return;
            }
            signalling.signalUserChange({type: 'user'});
            callback(null, role);
        });
    })
}

function alterRole(role, callback){
    let validation_resp = validation.alterRoleValidation(role);
    if(validation_resp){
        callback(validation_resp);
        return;
    }

    delete role.hdb_user;
    delete role.operation;

    let update_object = {
        operation:'update',
        schema :  'system',
        table:'hdb_role',
        hash_attribute: 'rolename',
        records: [role]
    };

    insert.update(update_object, function(err, success){
        if(err) {
            callback(err);
            return;
        }
        signalling.signalUserChange({type: 'user'});
        callback(null, success);
    });
}

function dropRole(role, callback){
    let validation_resp = validation.dropRoleValidation(role);
    if(validation_resp){
        callback(validation_resp);
        return;
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

    search.searchByConditions(search_for_role_name, function(err, role_name){        
        if(err)
            return callback(`${err}`);
        if(role_name.length === 0)
            return callback(`Role not found`);
        
        search.searchByConditions(search_for_users, function(err, users){
            if(users && users.length > 0){
                return callback(`Cannot drop role ${role_name[0].role} ${users.length} users are tied to this role`);
            }
            let delete_object = {
                table:"hdb_role",
                schema:"system",
                hash_values: [role.id]
            };
                        
            delete_.delete(delete_object, function(err, success){
                if(err){
                    callback(err);
                    return;
                }
                signalling.signalUserChange({type: 'user'});
                    callback(null, `${role_name[0].role} successfully deleted`);
            });
        });
    });
}

function listRoles(req_body, callback){
    var search_obj = {
        table: "hdb_role",
        schema: "system",
        hash_attribute:"id",
        search_attribute:"id",
        search_value:"*",
        get_attributes: ["*"]
    }

    search.searchByValue(search_obj, function(err, roles){
        if(err){
            return callback(err);
        }

        return callback(null, roles);
    });
}

function validatePermission(table_obj){
    if(!table_obj)
        return "Missing role";

    if(!table_obj.role)
        return "role.role must be defined";

    if(!table_obj.permission)
        return "role.permission must be defined";

    if(table_obj.su)
        return;
}

