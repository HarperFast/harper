const insert = require('../data_layer/insert'),
      delete_ = require('../data_layer/delete'),
      password = require('../utility/password'),
      validation = require('../validation/user_validation'),
      search = require('../data_layer/search');

module.exports = {
    addUser: addUser,
    alterUser:alterUser,
    dropUser: dropUser,
    userInfo: user_info,
    listUsers: list_users

};




function addUser(user, callback){
    let validation_resp = validation.addUserValidation(user);
    if(validation_resp){
        callback(validation_resp);
        return;
    }

    user.password = password.hash(user.password);
    delete user.operation;

    let insert_object = {
        operation:'insert',
        schema :  'system',
        table:'hdb_user',
        hash_attribute: 'username',
        records: [user]
    };

    insert.insert(insert_object, function(err, success){
        if(err){
            callback(err);
            return;
        }

        callback(null, `${user.username} successfully added`);

    });

}

function alterUser(user, callback){
    let validation_resp = validation.alterUserValidation(user);
    if(validation_resp){
        callback(validation_resp);
        return;
    }


    let update_object = {
        operation:'update',
        schema :  'system',
        table:'hdb_user',
        hash_attribute: 'username',
        records: [user]
    };

    insert.update(update_object, function(err, success){
        if(err){
            callback(err);
            return;
        }

        callback(null, `${user.username} successfully altered`);

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

       callback(null, `${user.username} successfully deleted`);

    });

}


function user_info(body, callback){
    let user = body.hdb_user;
    let search_obj = {};
    search_obj.schema = 'system';
    search_obj.table = 'hdb_role';
    search_obj.hash_attribute = 'id';
    search_obj.hash_values = [user.role];
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

function list_users(body, callback){
    let search_obj = {};
    search_obj.schema = 'system';
    search_obj.table = 'hdb_user';
    search_obj.hash_attribute = 'username';
    search_obj.hash_values = ['admin'];
    search_obj.get_attributes = ['*'];
    search.searchByHash(search_obj, function (err, users) {
        if (err) {
            return callback(err);
        }

        return callback(null, users);



    });

}
