'use strict';

module.exports = {
    addUser: addUser,
    alterUser:alterUser,
    dropUser: dropUser,
    userInfo: user_info,
    listUsers: list_users,
    listUsersExternal : listUsersExternal,
    setUsersToGlobal: setUsersToGlobal
};

//requires must be declared after module.exports to avoid cyclical dependency
const insert = require('../data_layer/insert'),
    delete_ = require('../data_layer/delete'),
    password = require('../utility/password'),
    validation = require('../validation/user_validation'),
    search = require('../data_layer/search'),
    signalling  = require('../utility/signalling');

function addUser(user, callback){
    let validation_resp = validation.addUserValidation(user);
    if(validation_resp){
        return callback(validation_resp);
    }
    delete user.hdb_user;
    delete user.operation;

    let search_obj = {
        schema: 'system',
        table : 'hdb_role',
        hash_values: [user.role],
        hash_attribute : 'id',
        get_attributes: ['id']
    };

    search.searchByHash(search_obj, function (err, search_role) {
        if(!search_role || search_role.length < 1){
            return callback("Role not found!");
        }

        user.password = password.hash(user.password);

        let insert_object = {
            operation: 'insert',
            schema: 'system',
            table: 'hdb_user',
            hash_attribute: 'username',
            records: [user]
        };

        insert.insert(insert_object, function (err, success) {
            if (err) {
                return callback(err);
            }
            setUsersToGlobal((err) => {
                if (err) {
                    winston.error(err);
                }
                signalling.signalUserChange({type: 'user'});
                callback(null, `${user.username} successfully added`);
            });
        });
    });
}

function alterUser(user, callback){
    let validation_resp = validation.alterUserValidation(user);
    if(validation_resp){
        callback(validation_resp);
        return;
    }

    delete user.hdb_user;
    delete user.operation;

    let update_object = {
        operation:'update',
        schema :  'system',
        table:'hdb_user',
        hash_attribute: 'username',
        records: [user]
    };

    insert.update(update_object, function(err, success){
        if(err) {
            callback(err);
            return;
        }
        setUsersToGlobal((err) => {
            if (err) {
                winston.error(err);
            }
            signalling.signalUserChange({type: 'user'});
            callback(null, success);
        });
    });
}

function dropUser(user, callback){
    let validation_resp = validation.dropUserValidation(user);
    if(validation_resp){
        callback(validation_resp);
        return;
    }
    let delete_object = {
        table:"hdb_user",
        schema:"system",
        hash_values: [user.username]
    };

    delete_.delete(delete_object, function(err, success){
        if(err){
            callback(err);
            return;
        }
        setUsersToGlobal((err) => {
            if (err) {
                winston.error(err);
            }
            signalling.signalUserChange({type: 'user'});
            callback(null, `${user.username} successfully deleted`);
        });
    });
}


function user_info(body, callback) {
    if(!body || !body.hdb_user) {
        return callback('There was no user info in the body', null);
    }

    let user = body.hdb_user;
    let search_obj = {};
    search_obj.schema = 'system';
    search_obj.table = 'hdb_role';
    search_obj.hash_attribute = 'id';
    search_obj.hash_values = [user.role.id];
    search_obj.get_attributes = ['*'];
    search.searchByHash(search_obj, function (err, role_data) {
        if (err) {
            return callback(err);
        }

        user.role = role_data[0];
        delete user.password;
        return callback(null, user);
    });
}

/**
 * This function should be called by chooseOperation as it scrubs sensitive information before returning
 * the results of list users.
 * @param body - request body
 * @param callback
 */
function listUsersExternal(body, callback) {
    list_users(body, function (err, user_data) {
        if(err) {
            return callback(err);
        }
        try {
            for (let u in user_data) {
                delete user_data[u].password;
            }
        } catch (e) {
            return callback('there was an error massaging the user data', null);
        }
        return callback(null, user_data);
    });
}

function list_users(body, callback){

    let role_search_obj = {};
    role_search_obj.schema = 'system';
    role_search_obj.table = 'hdb_role';
    role_search_obj.hash_attribute = 'id';
    role_search_obj.search_value = '*';
    role_search_obj.search_attribute = 'role';

    role_search_obj.get_attributes = ['*'];
    search.searchByValue(role_search_obj, function (err, roles) {

        if (err) {
            return callback(err);
        }
        if(roles){
            let roleMapObj = {}
            for(let r in roles){
                roleMapObj[roles[r].id] = roles[r];
            }

            let user_search_obj = {};
            user_search_obj.schema = 'system';
            user_search_obj.table = 'hdb_user';
            user_search_obj.hash_attribute = 'username';
            user_search_obj.search_value = '*';
            user_search_obj.search_attribute = 'username';
            user_search_obj.get_attributes = ['*'];
            search.searchByValue(user_search_obj, function (err, users) {
                if (err) {
                    return callback(err);
                }

                for(let u in users){
                    users[u].role = roleMapObj[users[u].role];
                }
                return callback(null, users);
            });
        }else{
            return callback(null, null);
        }
    });
}

function setUsersToGlobal(callback){
    list_users(null, (err, users)=>{
        if(err){
            return winston.error(err);
        }
        global.hdb_users = users;
        callback();
    });
}