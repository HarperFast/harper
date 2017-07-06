const insert = require('../data_layer/insert'),
      delete_ = require('../data_layer/delete'),
      password = require('../utility/password'),
      validation = require('../validation/user_validation');

module.exports = {
    addUser: addUser,
    alterUser:alterUser,
    dropUser: dropUser

}




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
    let delete_object = {"table":"hdb_user", "schema":"system", "hash_value": user.username}
    delete_.delete(delete_object, function(err, success){
       if(err){
           callback(err);
           return;
       }

       callback(null, `${user.username} successfully deleted`);

    });

}

