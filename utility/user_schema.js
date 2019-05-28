"use strict";

const logger = require('../utility/logging/harper_logger');
const user = require('../security/user');
const util = require('util');
const cb_user_list_users = util.callbackify(user.listUsers);

module.exports = {
    setUsersToGlobal: setUsersToGlobal
};

function setUsersToGlobal(callback) {
    cb_user_list_users(null, (err, users) => {
        if(err){
            return logger.error(err);
        }
        global.hdb_users = users;
        callback();
    });
}
