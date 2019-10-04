"use strict";

const logger = require('../utility/logging/harper_logger');
const user = require('../security/user');
const util = require('util');
const cb_user_list_users = util.callbackify(user.listUsers);
const license = require('../utility/registration/hdb_license');
const roles = require('../security/role');

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

async function setUsersToGlobalRf() {
    try {
        let filtered_users = undefined;
        let cluster_roles = undefined;
        let su_roles = undefined;
        let users = await user.listUsers();
        let curr_license = await license.getLicense();
        if(!curr_license.enterprise) {
            let role_map = Object.create(null);
            // loop through the users and sort them by role.  We will pick the role with the most users to enable
            users.forEach((user) => {
                if(!role_map[user.role])
            });

            let system_roles = await roles.listRoles();
            for(let i=0; i<system_roles.length; ++i) {
                let curr_role = system_roles[i];
                let perms = curr_role.permissions;
                if(curr_role.permission.cluster_user === true || curr_role.permission.super_user === true) {
                    cluster_roles.push(curr_role);
                }
            }

        }
        global.hdb_users = users;
    } catch(err) {
        return logger.error(err);
    }
}
