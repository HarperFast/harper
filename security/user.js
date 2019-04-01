'use strict';

const USERNAME_REQUIRED = 'username is required';
const ALTERUSER_NOTHING_TO_UPDATE = 'nothing to update, must supply active, role or password to update';
const EMPTY_PASSWORD = 'password cannot be an empty string';
const EMPTY_ROLE = 'If role is specified, it cannot be empty.';
const ACTIVE_BOOLEAN = 'active must be true or false';

module.exports = {
    addUser: addUserCB,
    alterUser:alterUserCB,
    dropUser: dropUserCB,
    userInfo: userinfoCB,
    listUsers: listUsersCB,
    listUsersExternal : listUsersExternalCB,
    setUsersToGlobal: setUsersToGlobalCB,
    USERNAME_REQUIRED: USERNAME_REQUIRED,
    ALTERUSER_NOTHING_TO_UPDATE: ALTERUSER_NOTHING_TO_UPDATE,
    EMPTY_PASSWORD: EMPTY_PASSWORD,
    EMPTY_ROLE: EMPTY_ROLE,
    ACTIVE_BOOLEAN: ACTIVE_BOOLEAN
};

//requires must be declared after module.exports to avoid cyclical dependency
const insert = require('../data_layer/insert');
const delete_ = require('../data_layer/delete');
const password = require('../utility/password');
const validation = require('../validation/user_validation');
const search = require('../data_layer/search');
const signalling = require('../utility/signalling');
const hdb_utility = require('../utility/common_utils');
const validate = require('validate.js');
const logger = require('../utility/logging/harper_logger');
const {promisify} = require('util');

const USER_ATTRIBUTE_WHITELIST = {
    username: true,
    active: true,
    role: true,
    password: true
};

const p_search_search_by_value = promisify(search.searchByValue);
const p_search_search_by_hash = promisify(search.searchByHash);
const p_delete_delete = promisify(delete_.delete);

function addUserCB(user, callback){
    let add_result = {};
    addUser(user).then((result) => {
        add_result = result;
        return callback(null, add_result);
    }).catch((err) => {
        logger.error(`There was an error getting adding a user ${err}`);
        return callback(err, null);
    });
}

async function addUser(user){
    let clean_user = validate.cleanAttributes(user, USER_ATTRIBUTE_WHITELIST);

    let validation_resp = validation.addUserValidation(clean_user);
    if(validation_resp){
        throw new Error(validation_resp);
    }

    let search_obj = {
        schema: 'system',
        table : 'hdb_role',
        hash_values: [clean_user.role],
        hash_attribute : 'id',
        get_attributes: ['id']
    };

    let search_role = await p_search_search_by_hash(search_obj).catch((err) => {
        logger.error('There was an error searching for a role in add user');
        logger.error(err);
        throw err;
    });
    if(!search_role || search_role.length < 1){
        throw new Error("Role not found.");
    }

    clean_user.password = password.hash(clean_user.password);

    let insert_object = {
        operation: 'insert',
        schema: 'system',
        table: 'hdb_user',
        hash_attribute: 'username',
        records: [clean_user]
    };

    let success = await insert.insert(insert_object).catch((err) => {
        logger.error('There was an error searching for a user.');
        logger.error(err);
        throw err;
    });
    logger.debug(success);

    await setUsersToGlobal().catch((err) => {
        logger.error('Got an error setting users to global');
        logger.error(err);
       throw err;
    });

    signalling.signalUserChange({type: 'user'});
    return `${clean_user.username} successfully added`;
}

function alterUserCB(json_message, callback) {
    let alter_result = {};
    alterUser(json_message).then((result) => {
        alter_result = result;
        return callback(null, alter_result);
    }).catch((err) => {
        logger.error(`There was an error altering user ${err}`);
        return callback(err, null);
    });
}

async function alterUser(json_message) {
    let clean_user = validate.cleanAttributes(json_message, USER_ATTRIBUTE_WHITELIST);

    if(hdb_utility.isEmptyOrZeroLength(clean_user.username)){
        throw new Error(USERNAME_REQUIRED);
    }

    if(hdb_utility.isEmptyOrZeroLength(clean_user.password) && hdb_utility.isEmptyOrZeroLength(clean_user.role)
        && hdb_utility.isEmptyOrZeroLength(clean_user.active)){
        throw new Error(ALTERUSER_NOTHING_TO_UPDATE);
    }

    if(!hdb_utility.isEmpty(clean_user.password) && hdb_utility.isEmptyOrZeroLength(clean_user.password.trim())) {
        throw new Error(EMPTY_PASSWORD);
    }

    if(!hdb_utility.isEmpty(clean_user.active) && !hdb_utility.isBoolean(clean_user.active)) {
        throw new Error(ACTIVE_BOOLEAN);
    }

    if(!hdb_utility.isEmpty(clean_user.password) && !hdb_utility.isEmptyOrZeroLength(clean_user.password.trim())) {
        clean_user.password = password.hash(clean_user.password);
    }

    // the not operator will consider an empty string as undefined, so we need to check for an empty string explicitly
    if(clean_user.role === "") {
        throw new Error(EMPTY_ROLE);
    }
    // Invalid roles will be found in the role search
    if(clean_user.role) {
        // Make sure assigned role exists.
        let role_search_obj = {
            schema: 'system',
            table: 'hdb_role',
            hash_attribute: 'id',
            hash_values: [json_message.role],
            get_attributes: ['*']
        };
        let role_data = await p_search_search_by_hash(role_search_obj).catch((err) => {
            logger.error('Got an error searching for a role.');
            logger.error(err);
            throw err;
        });
        if (!role_data || role_data.length === 0) {
            let msg = `Update failed.  Requested role id ${clean_user.role} not found.`;
            logger.error(msg);
            throw new Error(msg);
        }
    }

    let update_object = {
        operation:'update',
        schema :  'system',
        table:'hdb_user',
        hash_attribute: 'username',
        records: [clean_user]
    };

    let success = await insert.update(update_object).catch((err) => {
        logger.error(`Error during update.`);
        logger.error(err);
        throw err;
    });

    await setUsersToGlobal().catch((err) => {
        logger.error('Got an error setting users to global');
        logger.error(err);
        throw err;
    });

    signalling.signalUserChange({type: 'user'});
    return success;
}

function dropUserCB(user, callback){
    let drop_result = {};
    dropUser(user).then((result) => {
        drop_result = result;
        return callback(null, drop_result);
    }).catch((err) => {
        logger.error(`There was an error dropping a user ${err}`);
        return callback(err, null);
    });
}

async function dropUser(user) {
    try {
        let validation_resp = validation.dropUserValidation(user);
        if (validation_resp) {
            throw new Error(validation_resp);
        }
        let delete_object = {
            table: "hdb_user",
            schema: "system",
            hash_values: [user.username]
        };

        let success = await p_delete_delete(delete_object).catch((err) => {
            logger.error('Got an error deleting a user.');
            logger.error(err);
            throw err;
        });
        logger.debug(success);
        await setUsersToGlobal().catch((err) => {
            logger.error('Got an error setting users to global.');
            logger.error(err);
            throw err;
        });
        signalling.signalUserChange({type: 'user'});
        return `${user.username} successfully deleted`;
    } catch(err) {
        throw err;
    }
}


function userinfoCB(body, callback) {
    let user_info = {};
    userInfo(body).then((result) => {
        user_info = result;
        return callback(null, user_info);
    }).catch((err) => {
        logger.error(`There was an error getting user info ${err}`);
        return callback(err, null);
    });
}

async function userInfo(body) {
    let user = {};
    try {
        if (!body || !body.hdb_user) {
            return 'There was no user info in the body';
        }

        user = body.hdb_user;
        let search_obj = {};
        search_obj.schema = 'system';
        search_obj.table = 'hdb_role';
        search_obj.hash_attribute = 'id';
        search_obj.hash_values = [user.role.id];
        search_obj.get_attributes = ['*'];
        let role_data = await p_search_search_by_hash(search_obj).catch((err) => {
            logger.error('Got an error searching for a role.');
            logger.error(err);
            throw err;
        });
        user.role = role_data[0];
        delete user.password;
    } catch(err) {
        logger.error(err);
        throw err;
    }
    return user;
}

/**
 * This function should be called by chooseOperation as it scrubs sensitive information before returning
 * the results of list users.
 * @param body - request body
 * @param callback
 */
function listUsersExternalCB(body, callback) {
    let list_result = {};
    listUsersExternal().then((result) => {
        list_result = result;
        return callback(null, list_result);
    }).catch((err) => {
        logger.error(`There was an error with listUsersExternal ${err}`);
        return callback(err, null);
    });
}

async function listUsersExternal() {
    let user_data = await listUsers().catch((err) => {
       logger.error('Got an error listing users.');
       logger.error(err);
       throw err;
    });
    try {
        for (let u in user_data) {
            delete user_data[u].password;
        }
    } catch (e) {
        throw new Error('there was an error massaging the user data');
    }
    return user_data;
}

function listUsersCB(body, callback){
    let list_result = {};
    listUsers().then((result) => {
        list_result = result;
        return callback(null, list_result);
    }).catch((err) => {
        logger.error(`There was an error listing the users for this machine ${err}`);
        return callback(err, null);
    });
}

async function listUsers() {

    let role_search_obj = {
        schema: 'system',
        table: 'hdb_role',
        hash_attribute: 'id',
        search_value: '*',
        search_attribute: 'role',
        get_attributes: ['*']
    };

    let roles = await p_search_search_by_value(role_search_obj).catch((err) => {
       logger.error(`Got an error searching for roles.`);
       logger.error(err);
       throw err;
    });

    if(roles) {
        let roleMapObj = {};
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
        let users = await p_search_search_by_value(user_search_obj).catch((err) => {
           logger.error('Got an error searching for users.');
           logger.error(err);
           throw err;
        });

        for(let u in users){
            users[u].role = roleMapObj[users[u].role];
        }
        return users;
    }
    return null;
}

function setUsersToGlobalCB(callback){
    let set_result = {};
    setUsersToGlobal().then((result) => {
        set_result = result;
        return callback(null, set_result);
    }).catch((err) => {
        logger.error(`There was an error setting users to global ${err}`);
        return callback(err, null);
    });
}

async function setUsersToGlobal() {
    global.hdb_users = await listUsers().catch((err) => {
       throw err;
    });
}