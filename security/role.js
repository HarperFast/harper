const insert = require('../data_layer/insert'),
    delete_ = require('../data_layer/delete'),
    validation = require('../validation/role_validation');

module.exports = {
    addRole: addRole,
    alterRole:alterRole,
    dropRole: dropRole

}




function addRole(role, callback){
    let validation_resp = validation.addRoleValidation(role);
    if(validation_resp){
        callback(validation_resp);
        return;
    }

    var insert_object = {
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

        callback(null, `${role.rolename} successfully added`);

    });

}

function alterRole(role, callback){
    let validation_resp = validation.alterRoleValidation(role);
    if(validation_resp){
        callback(validation_resp);
        return;
    }

    var update_object = {
        operation:'update',
        schema :  'system',
        table:'hdb_role',
        hash_attribute: 'rolename',
        records: [role]
    };

    insert.update(insert_object, function(err, success){
        if(err){
            callback(err);
            return;
        }

        callback(null, `${role.rolename} successfully altered`);

    });


}

function dropRole(role, callback){
    let validation_resp = validation.dropRoleValidation(role);
    if(validation_resp){
        callback(validation_resp);
        return;
    }
    var delete_object = {"table":"hdb_role", "schema":"system", "hash_value": role.rolename}
    delete_.delete(delete_object, function(err, success){
        if(err){
            callback(err);
            return;
        }

        callback(null, `${role.rolename} successfully deleted`);

    });

}

