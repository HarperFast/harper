'use strict';

const USERNAME_REQUIRED = 'username is required';
const ALTERUSER_NOTHING_TO_UPDATE = 'nothing to update, must supply active, role or password to update';
const EMPTY_PASSWORD = 'password cannot be an empty string';
const EMPTY_ROLE = 'If role is specified, it cannot be empty.';
const ACTIVE_BOOLEAN = 'active must be true or false';

module.exports = {
	addUser,
	alterUser,
	dropUser,
	userInfo,
	listUsers,
	listUsersExternal,
	setUsersToGlobal,
	findAndValidateUser,
	getClusterUser,
	USERNAME_REQUIRED,
	ALTERUSER_NOTHING_TO_UPDATE,
	EMPTY_PASSWORD,
	EMPTY_ROLE,
	ACTIVE_BOOLEAN,
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
const { promisify } = require('util');
const crypto_hash = require('./cryptoHash');
const terms = require('../utility/hdbTerms');
const nats_terms = require('../server/nats/utility/natsTerms');
const config_utils = require('../config/configUtils');
const env = require('../utility/environment/environmentManager');
const license = require('../utility/registration/hdb_license');
const systemSchema = require('../json/systemSchema');
const { handleHDBError, hdb_errors } = require('../utility/errors/hdbError');
const { HTTP_STATUS_CODES, AUTHENTICATION_ERROR_MSGS, HDB_ERROR_MSGS } = hdb_errors;
const { UserEventMsg } = require('../server/ipc/utility/ipcUtils');
const _ = require('lodash');

const USER_ATTRIBUTE_ALLOWLIST = {
	username: true,
	active: true,
	role: true,
	password: true,
};
const password_hash_cache = new Map();
const p_search_search_by_value = promisify(search.searchByValue);
const p_search_search_by_hash = promisify(search.searchByHash);
const p_delete_delete = promisify(delete_.delete);

async function addUser(user) {
	let clean_user = validate.cleanAttributes(user, USER_ATTRIBUTE_ALLOWLIST);

	let validation_resp = validation.addUserValidation(clean_user);
	if (validation_resp) {
		throw handleHDBError(
			new Error(),
			validation_resp.message,
			HTTP_STATUS_CODES.BAD_REQUEST,
			undefined,
			undefined,
			true
		);
	}

	let search_obj = {
		schema: 'system',
		table: 'hdb_role',
		search_attribute: 'role',
		search_value: clean_user.role,
		get_attributes: ['id', 'permission', 'role'],
	};

	let search_role;
	try {
		search_role = await p_search_search_by_value(search_obj);
		search_role = search_role && Array.from(search_role);
	} catch (err) {
		logger.error('There was an error searching for a role in add user');
		logger.error(err);
		throw err;
	}

	if (!search_role || search_role.length < 1) {
		throw handleHDBError(
			new Error(),
			HDB_ERROR_MSGS.ROLE_NAME_NOT_FOUND(clean_user.role),
			HTTP_STATUS_CODES.NOT_FOUND,
			undefined,
			undefined,
			true
		);
	}
	if (search_role.length > 1) {
		throw handleHDBError(
			new Error(),
			HDB_ERROR_MSGS.DUP_ROLES_FOUND(clean_user.role),
			HTTP_STATUS_CODES.CONFLICT,
			undefined,
			undefined,
			true
		);
	}

	if (search_role[0].permission.cluster_user === true) {
		clean_user.hash = crypto_hash.encrypt(clean_user.password);
	}

	clean_user.password = password.hash(clean_user.password);

	clean_user.role = search_role[0].id;

	let insert_object = {
		operation: 'insert',
		schema: 'system',
		table: 'hdb_user',
		records: [clean_user],
	};

	let success;
	try {
		success = await insert.insert(insert_object);
	} catch (err) {
		logger.error('There was an error searching for a user.');
		logger.error(err);
		throw err;
	}

	logger.debug(success);

	try {
		await setUsersToGlobal();
	} catch (err) {
		logger.error('Got an error setting users to global');
		logger.error(err);
		throw err;
	}

	if (success.skipped_hashes.length === 1) {
		throw handleHDBError(
			new Error(),
			HDB_ERROR_MSGS.USER_ALREADY_EXISTS(clean_user.username),
			HTTP_STATUS_CODES.CONFLICT,
			undefined,
			undefined,
			true
		);
	}

	const new_user = Object.assign({}, clean_user);
	new_user.role = search_role[0];
	let add_user_msg = { user: null }; // This is temp code as a result of removing SC
	add_user_msg.user = new_user;
	// TODO: Check if this should be removed, postOperation
	hdb_utility.sendTransactionToSocketCluster(
		terms.INTERNAL_SC_CHANNELS.ADD_USER,
		add_user_msg,
		env.get(terms.HDB_SETTINGS_NAMES.CLUSTERING_NODE_NAME_KEY)
	);
	signalling.signalUserChange(new UserEventMsg(process.pid));
	return `${new_user.username} successfully added`;
}

async function alterUser(json_message) {
	let clean_user = validate.cleanAttributes(json_message, USER_ATTRIBUTE_ALLOWLIST);

	if (hdb_utility.isEmptyOrZeroLength(clean_user.username)) {
		throw new Error(USERNAME_REQUIRED);
	}

	if (
		hdb_utility.isEmptyOrZeroLength(clean_user.password) &&
		hdb_utility.isEmptyOrZeroLength(clean_user.role) &&
		hdb_utility.isEmptyOrZeroLength(clean_user.active)
	) {
		throw new Error(ALTERUSER_NOTHING_TO_UPDATE);
	}

	if (!hdb_utility.isEmpty(clean_user.password) && hdb_utility.isEmptyOrZeroLength(clean_user.password.trim())) {
		throw new Error(EMPTY_PASSWORD);
	}

	if (!hdb_utility.isEmpty(clean_user.active) && !hdb_utility.isBoolean(clean_user.active)) {
		throw new Error(ACTIVE_BOOLEAN);
	}

	let is_cluster_user = isClusterUser(clean_user.username);

	if (!hdb_utility.isEmpty(clean_user.password) && !hdb_utility.isEmptyOrZeroLength(clean_user.password.trim())) {
		//if this is a cluster_user we must regenerate the hash when password changes
		if (is_cluster_user) {
			clean_user.hash = crypto_hash.encrypt(clean_user.password);
		}
		clean_user.password = password.hash(clean_user.password);
	}

	// the not operator will consider an empty string as undefined, so we need to check for an empty string explicitly
	if (clean_user.role === '') {
		throw new Error(EMPTY_ROLE);
	}
	// Invalid roles will be found in the role search
	if (clean_user.role) {
		// Make sure assigned role exists.
		let role_search_obj = {
			schema: 'system',
			table: 'hdb_role',
			search_attribute: 'role',
			search_value: clean_user.role,
			get_attributes: ['*'],
		};

		let role_data;
		try {
			role_data = Array.from((await p_search_search_by_value(role_search_obj)) || []);
		} catch (err) {
			logger.error('Got an error searching for a role.');
			logger.error(err);
			throw err;
		}

		if (!role_data || role_data.length === 0) {
			const msg = HDB_ERROR_MSGS.ALTER_USER_ROLE_NOT_FOUND(clean_user.role);
			logger.error(msg);
			throw handleHDBError(new Error(), msg, HTTP_STATUS_CODES.NOT_FOUND, undefined, undefined, true);
		}

		if (role_data.length > 1) {
			const msg = HDB_ERROR_MSGS.ALTER_USER_DUP_ROLES(clean_user.role);
			logger.error(msg);
			throw handleHDBError(new Error(), msg, HTTP_STATUS_CODES.CONFLICT, undefined, undefined, true);
		}

		clean_user.role = role_data[0].id;
	}

	let update_object = {
		operation: 'update',
		schema: 'system',
		table: 'hdb_user',
		records: [clean_user],
	};

	let success;
	try {
		success = await insert.update(update_object);
	} catch (err) {
		logger.error(`Error during update.`);
		logger.error(err);
		throw err;
	}

	try {
		await setUsersToGlobal();
	} catch (err) {
		logger.error('Got an error setting users to global');
		logger.error(err);
		throw err;
	}

	let alter_user_msg = { user: null }; // This is temp code as a result of removing SC
	alter_user_msg.user = clean_user;
	hdb_utility.sendTransactionToSocketCluster(
		terms.INTERNAL_SC_CHANNELS.ALTER_USER,
		alter_user_msg,
		env.get(terms.HDB_SETTINGS_NAMES.CLUSTERING_NODE_NAME_KEY)
	);
	signalling.signalUserChange(new UserEventMsg(process.pid));
	return success;
}

function isClusterUser(username) {
	let is_cluster_user = false;
	const user_role = global.hdb_users.get(username);

	if (user_role && user_role.role.permission.cluster_user === true) {
		is_cluster_user = true;
	}

	return is_cluster_user;
}

async function dropUser(user) {
	try {
		let validation_resp = validation.dropUserValidation(user);
		if (validation_resp) {
			throw new Error(validation_resp);
		}
		let delete_object = {
			table: 'hdb_user',
			schema: 'system',
			hash_values: [user.username],
		};

		if (hdb_utility.isEmpty(global.hdb_users.get(user.username))) {
			throw handleHDBError(
				new Error(),
				HDB_ERROR_MSGS.USER_NOT_EXIST(user.username),
				HTTP_STATUS_CODES.NOT_FOUND,
				undefined,
				undefined,
				true
			);
		}

		let success;
		try {
			success = await p_delete_delete(delete_object);
		} catch (err) {
			logger.error('Got an error deleting a user.');
			logger.error(err);
			throw err;
		}

		logger.debug(success);

		try {
			await setUsersToGlobal();
		} catch (err) {
			logger.error('Got an error setting users to global.');
			logger.error(err);
			throw err;
		}

		let alter_user_msg = { user: null }; // This is temp code as a result of removing SC
		alter_user_msg.user = user;
		hdb_utility.sendTransactionToSocketCluster(
			terms.INTERNAL_SC_CHANNELS.DROP_USER,
			alter_user_msg,
			env.get(terms.HDB_SETTINGS_NAMES.CLUSTERING_NODE_NAME_KEY)
		);
		signalling.signalUserChange(new UserEventMsg(process.pid));
		return `${user.username} successfully deleted`;
	} catch (err) {
		throw err;
	}
}

async function userInfo(body) {
	let user = {};
	try {
		if (!body || !body.hdb_user) {
			return 'There was no user info in the body';
		}

		user = body.hdb_user;
		let search_obj = {
			schema: 'system',
			table: 'hdb_role',
			hash_values: [user.role.id],
			get_attributes: ['*'],
		};

		let role_data;
		try {
			role_data = await p_search_search_by_hash(search_obj);
		} catch (err) {
			logger.error('Got an error searching for a role.');
			logger.error(err);
			throw err;
		}

		user.role = role_data[0];
		delete user.password;
		delete user.refresh_token;
		delete user.hash;
	} catch (err) {
		logger.error(err);
		throw err;
	}
	return user;
}

/**
 * This function should be called by chooseOperation as it scrubs sensitive information before returning
 * the results of list users.
 */
async function listUsersExternal() {
	let user_data;
	try {
		user_data = await listUsers();
	} catch (err) {
		logger.error('Got an error listing users.');
		logger.error(err);
		throw err;
	}

	try {
		user_data.forEach((user) => {
			delete user.password;
			delete user.hash;
			delete user.refresh_token;
		});
	} catch (e) {
		throw new Error('there was an error massaging the user data');
	}

	return [...user_data.values()];
}

/**
 * Queries system table for user records, adds role-based perms, scrubs list based on licensed role allowance and returns
 * data in a Map with the username as the key for the entry
 * @returns {Promise<Map<string, object>>}
 */
async function listUsers() {
	try {
		let role_search_obj = {
			schema: 'system',
			table: 'hdb_role',
			search_value: '*',
			search_attribute: 'role',
			get_attributes: ['*'],
		};

		let roles;
		try {
			roles = await p_search_search_by_value(role_search_obj);
		} catch (err) {
			logger.error(`Got an error searching for roles.`);
			logger.error(err);
			throw err;
		}

		let roleMapObj = {};
		for (let role of roles) {
			roleMapObj[role.id] = _.cloneDeep(role);
		}
		if (Object.keys(roleMapObj).length === 0)
			return null;

		let user_search_obj = {
			schema: 'system',
			table: 'hdb_user',
			search_value: '*',
			search_attribute: 'username',
			get_attributes: ['*'],
		};

		let users;
		try {
			users = await p_search_search_by_value(user_search_obj);
		} catch (err) {
			logger.error('Got an error searching for users.');
			logger.error(err);
			throw err;
		}

		const user_map = new Map();
		for (let user of users) {
			user = _.cloneDeep(user);
			user.role = roleMapObj[user.role];
			appendSystemTablesToRole(user.role);
			user_map.set(user.username, user);
		}
		// No enterprise license limits roles to 2 (1 su, 1 cu).  If a license has expired, we need to allow the cluster role
		// and the role with the most users.
		if (!(await license.getLicense()).enterprise) {
			return nonEnterpriseFilter(Array.from(user_map.values()));
		}
		return user_map;
	} catch (err) {
		logger.error('got an error listing users');
		logger.error(err);
		throw hdb_utility.errorizeMessage(err);
	}
	return null;
}

/**
 * adds system table permissions to a role.  This is used to protect system tables by leveraging operationAuthoriation.
 * @param user_role - Role of the user found during auth.
 */
function appendSystemTablesToRole(user_role) {
	try {
		if (!user_role) {
			logger.error(`invalid user role found.`);
			return;
		}
		if (!user_role.permission['system']) {
			user_role.permission['system'] = {};
		}
		if (!user_role.permission.system['tables']) {
			user_role.permission.system['tables'] = {};
		}
		for (let table of Object.keys(systemSchema)) {
			let new_prop = {
				read: !!user_role.permission.super_user,
				insert: false,
				update: false,
				delete: false,
				attribute_permissions: [],
			};

			user_role.permission.system.tables[table] = new_prop;
		}
	} catch (err) {
		logger.error(`Got an error trying to set system permissions.`);
		logger.error(err);
	}
}

/**
 * Should return Map of filtered users
 * @param search_results
 * @returns {Map<string, object>}
 */
function nonEnterpriseFilter(search_results) {
	try {
		logger.info('No enterprise license found.  System is limited to 1 clustering role and 1 user role');
		if (!search_results) {
			return new Map();
		}
		let user_obj = Object.create(null);
		let found_users = new Map();
		// bucket users by role.  We will pick the role with the most users to enable
		search_results.forEach((user, username) => {
			if (user.role && (user.role.permission.cluster_user === undefined || user.role.permission.cluster_user === false)) {
				// only add super users
				if (user.role.permission.super_user === true) {
					if (!user_obj[user.role.id]) {
						user_obj[user.role.id] = new Map();
					}
					user_obj[user.role.id].set(user.username, user);
				}
			} else {
				found_users.set(user.username, user);
			}
		});

		let most_users_tuple = { role: undefined, count: 0 };
		Object.keys(user_obj).forEach((role_id) => {
			let curr_role = user_obj[role_id];
			if (curr_role.size >= most_users_tuple.count) {
				most_users_tuple.role = role_id;
				most_users_tuple.count = curr_role.size;
			}
		});
		if (most_users_tuple.role === undefined) {
			logger.error('No roles found with active users.  This is bad.');
			return new Map();
		}

		found_users = new Map([...found_users, ...user_obj[most_users_tuple.role]]);
		return found_users;
	} catch (err) {
		logger.error('error filtering users.');
		logger.error(err);
		return new Map();
	}
}

async function setUsersToGlobal() {
	try {
		let users = await listUsers();
		global.hdb_users = users;
	} catch (err) {
		logger.error(err);
		throw err;
	}
}

/**
 * iterates global.hdb_users to find and validate the username & optionalally the password as well as if they are active.
 * @param {string} username
 * @param {string} pw
 * @param {boolean} validate_password
 * @returns {Promise<{}|null>}
 */
async function findAndValidateUser(username, pw, validate_password = true) {
	if (!global.hdb_users) {
		await setUsersToGlobal();
	}

	let user_tmp = global.hdb_users.get(username);

	if (!user_tmp) {
		throw handleHDBError(
			new Error(),
			AUTHENTICATION_ERROR_MSGS.GENERIC_AUTH_FAIL,
			HTTP_STATUS_CODES.UNAUTHORIZED,
			undefined,
			undefined,
			true
		);
	}

	if (user_tmp && !user_tmp.active) {
		throw handleHDBError(
			new Error(),
			AUTHENTICATION_ERROR_MSGS.USER_INACTIVE,
			HTTP_STATUS_CODES.UNAUTHORIZED,
			undefined,
			undefined,
			true
		);
	}
	let user = {
		active: user_tmp.active,
		username: user_tmp.username,
	};
	if (user_tmp.refresh_token) user.refresh_token = user_tmp.refresh_token;
	if (user_tmp.role) user.role = user_tmp.role;

	if (validate_password === true) {
		// if matches the cached hash immediately return (the fast path)
		if (password_hash_cache.get(pw) === user_tmp.password) return user;
		// if validates, cache the password
		else if (password.validate(user_tmp.password, pw)) password_hash_cache.set(pw, user_tmp.password);
		else
			throw handleHDBError(
				new Error(),
				AUTHENTICATION_ERROR_MSGS.GENERIC_AUTH_FAIL,
				HTTP_STATUS_CODES.UNAUTHORIZED,
				undefined,
				undefined,
				true
			);
	}
	return user;
}

/**
 * Gets the cluster user provided in harperdb-config.yaml from the map of all user.
 * Nats requires plain test passwords, this is why we pass decrypt_hash.
 * The Nats routes require the decrypt_hash to be uri encoded.
 * @returns {Promise<Object>}
 */
async function getClusterUser() {
	const users = await listUsers();
	const cluster_username = config_utils.getConfigFromFile(terms.CONFIG_PARAMS.CLUSTERING_USER);
	const cluster_user = users.get(cluster_username);
	if (hdb_utility.isEmpty(cluster_user)) {
		return undefined;
	}

	cluster_user.decrypt_hash = crypto_hash.decrypt(cluster_user.hash);
	cluster_user.uri_encoded_d_hash = encodeURIComponent(cluster_user.decrypt_hash);
	cluster_user.uri_encoded_name = encodeURIComponent(cluster_user.username);
	cluster_user.sys_name = cluster_user.username + nats_terms.SERVER_SUFFIX.ADMIN;
	cluster_user.sys_name_encoded = cluster_user.uri_encoded_name + nats_terms.SERVER_SUFFIX.ADMIN;

	return cluster_user;
}
