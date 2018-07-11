"use strict"
const logger = require('../utility/logging/harper_logger');
const user = require('../security/user');

module.exports = {
    setUsersToGlobal: setUsersToGlobal
};

function setUsersToGlobal(callback) {
    user.listUsers(null, (err, users)=>{
        if(err){
            return logger.error(err);
        }
        global.hdb_users = users;
        callback();
    });
}
