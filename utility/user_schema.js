"use strict";

const logger = require('../utility/logging/harper_logger');
const user = require('../security/user');
const util = require('util');
const cb_user_list_users = util.callbackify(user.listUsers);
const license = require('../utility/registration/hdb_license');

module.exports = {
    setUsersToGlobal
};

async function setUsersToGlobal() {
    try {
        let users = await user.listUsers();
        let curr_license = await license.getLicense();
        let cluster_users = [];

        // No enterprise license limits roles to 2 (1 su, 1 cu).  If a license has expired, we need to allow the cluster role
        // and the role with the most users.
        if(!curr_license.enterprise) {
            logger.info('No enterprise license found.  System is limited to 1 clustering role and 1 user role');
            let user_map = Object.create(null);
            // bucket users by role.  We will pick the role with the most users to enable
            users.forEach((user) => {
                if (user.role.permission.cluster_user === undefined) {
                    if (!user_map[user.role.id]) {
                        user_map[user.role.id] = {};
                        user_map[user.role.id].users = [];
                    }
                    user_map[user.role.id].users.push(user);
                } else {
                    cluster_users.push(user);
                }
            });

            let most_users_tuple = { role: undefined, count: 0};
            Object.keys(user_map).forEach((role_id) => {
                let curr_role = user_map[role_id];
                if(curr_role.users.length >= most_users_tuple.count) {
                    most_users_tuple.role = role_id;
                    most_users_tuple.count = curr_role.users.length;
                }
            });
            if(most_users_tuple.role === undefined) {
                logger.error('No roles found with active users.  This is bad.');
                return;
            }
            Object.assign(users, user_map[most_users_tuple.role]);
            // add the cluster users.
            users.concat(cluster_users);
        }
        global.hdb_users = users;
    } catch(err) {
        return logger.error(err);
    }
}
