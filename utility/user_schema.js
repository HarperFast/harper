"use strict"
const winston = require('../utility/logging/winston_logger');
const user = require('../security/user');

module.exports = {
    setUsersToGlobal: setUsersToGlobal
};

function setUsersToGlobal(callback){
    user.listUsers(null, (err, users)=>{
        if(err){
            return winston.error(err);
        }
        global.hdb_users = users;
        callback();
    });
}
