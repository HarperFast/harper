'use strict';

const USERNAME_REQUIRED = 'username is required';
const ALTERUSER_NOTHING_TO_UPDATE = 'nothing to update, must supply active, role or password to update';
const EMPTY_PASSWORD = 'password cannot be an empty string';
const EMPTY_ROLE = 'If role is specified, it cannot be empty.';
const ACTIVE_BOOLEAN = 'active must be true or false';

module.exports.addUser = addUser;
module.exports.alterUser = alterUser;
module.exports.dropUser = dropUser;
module.exports.getSuperUser = getSuperUser;
module.exports.userInfo = userInfo;
module.exports.listUsers = listUsers;
module.exports.listUsersExternal = listUsersExternal;
module.exports.setUsersWithRolesCache = setUsersWithRolesCache;
module.exports.findAndValidateUser = findAndValidateUser;
module.exports.getClusterUser = getClusterUser;
module.exports.getUsersWithRolesCache = getUsersWithRolesCache;
module.exports.USERNAME_REQUIRED = USERNAME_REQUIRED;
module.exports.ALTERUSER_NOTHING_TO_UPDATE = ALTERUSER_NOTHING_TO_UPDATE;
module.exports.EMPTY_PASSWORD = EMPTY_PASSWORD;
module.exports.EMPTY_ROLE = EMPTY_ROLE;
module.exports.ACTIVE_BOOLEAN = ACTIVE_BOOLEAN;

//requires must be declared after module.exports to avoid cyclical dependency
const insert = require('../dataLayer/insert');
const delete_ = require('../dataLayer/delete');
const password = require('../utility/password');
const validation = require('../validation/user_validation');
const search = require('../dataLayer/search');
const signalling = require('../utility/signalling');
const hdbUtility = require('../utility/common_utils');
const validate = require('validate.js');
const logger = require('../utility/logging/harper_logger');
const { promisify } = require('util');
const cryptoHash = require('./cryptoHash');
const terms = require('../utility/hdbTerms');
const natsTerms = require('../server/nats/utility/natsTerms');
const configUtils = require('../config/configUtils');
const env = require('../utility/environment/environmentManager');
const systemSchema = require('../json/systemSchema');
const { hdb_errors, ClientError } = require('../utility/errors/hdbError');
const { HTTP_STATUS_CODES, AUTHENTICATION_ERROR_MSGS, HDB_ERROR_MSGS } = hdb_errors;
const { UserEventMsg } = require('../server/threads/itc');
const _ = require('lodash');
const { server } = require('../server/Server');
const harperLogger = require('../utility/logging/harper_logger');
server.getUser = (username, password) => {
	return findAndValidateUser(username, password, password != null);
};

const USER_ATTRIBUTE_ALLOWLIST = {
	username: true,
	active: true,
	role: true,
	password: true,
};
const passwordHashCache = new Map();
const promiseDelete = promisify(delete_.delete);
const configuredHashFunction =
	env.get(terms.CONFIG_PARAMS.AUTHENTICATION_HASHFUNCTION) ?? password.HASH_FUNCTION.SHA256;
let usersWithRolesMap;

async function addUser(user) {
	let cleanUser = validate.cleanAttributes(user, USER_ATTRIBUTE_ALLOWLIST);
	let validationResp = validation.addUserValidation(cleanUser);
	if (validationResp) throw new ClientError(validationResp.message);

	let searchRole = await search.searchByValue({
		schema: 'system',
		table: 'hdb_role',
		search_attribute: 'role',
		search_value: cleanUser.role,
		get_attributes: ['id', 'permission', 'role'],
	});

	if (!searchRole || searchRole.length < 1) {
		throw new ClientError(HDB_ERROR_MSGS.ROLE_NAME_NOT_FOUND(cleanUser.role), HTTP_STATUS_CODES.NOT_FOUND);
	}

	if (searchRole.length > 1) {
		throw new ClientError(HDB_ERROR_MSGS.DUP_ROLES_FOUND(cleanUser.role), HTTP_STATUS_CODES.CONFLICT);
	}

	if (searchRole[0].permission.cluster_user === true) {
		cleanUser.hash = cryptoHash.encrypt(cleanUser.password);
	}

	cleanUser.password = await password.hash(cleanUser.password, configuredHashFunction);
	cleanUser.hash_function = configuredHashFunction;
	cleanUser.role = searchRole[0].id;

	const insertResponse = await insert.insert({
		operation: 'insert',
		schema: 'system',
		table: 'hdb_user',
		records: [cleanUser],
	});
	logger.debug(insertResponse);

	await setUsersWithRolesCache();

	if (insertResponse.skipped_hashes.length === 1) {
		throw new ClientError(HDB_ERROR_MSGS.USER_ALREADY_EXISTS(cleanUser.username), HTTP_STATUS_CODES.CONFLICT);
	}

	signalling.signalUserChange(new UserEventMsg(process.pid));
	return `${cleanUser.username} successfully added`;
}

async function alterUser(json_message) {
	let cleanUser = validate.cleanAttributes(json_message, USER_ATTRIBUTE_ALLOWLIST);

	if (hdbUtility.isEmptyOrZeroLength(cleanUser.username)) {
		throw new Error(USERNAME_REQUIRED);
	}

	if (
		hdbUtility.isEmptyOrZeroLength(cleanUser.password) &&
		hdbUtility.isEmptyOrZeroLength(cleanUser.role) &&
		hdbUtility.isEmptyOrZeroLength(cleanUser.active)
	) {
		throw new Error(ALTERUSER_NOTHING_TO_UPDATE);
	}

	if (!hdbUtility.isEmpty(cleanUser.password) && hdbUtility.isEmptyOrZeroLength(cleanUser.password.trim())) {
		throw new Error(EMPTY_PASSWORD);
	}

	if (!hdbUtility.isEmpty(cleanUser.active) && !hdbUtility.isBoolean(cleanUser.active)) {
		throw new Error(ACTIVE_BOOLEAN);
	}

	if (!hdbUtility.isEmpty(cleanUser.password) && !hdbUtility.isEmptyOrZeroLength(cleanUser.password.trim())) {
		//if this is a cluster_user we must regenerate the hash when password changes
		if (isClusterUser(cleanUser.username)) {
			cleanUser.hash = cryptoHash.encrypt(cleanUser.password);
		}
		cleanUser.password = await password.hash(cleanUser.password, configuredHashFunction);
	}

	// the not operator will consider an empty string as undefined, so we need to check for an empty string explicitly
	if (cleanUser.role === '') {
		throw new Error(EMPTY_ROLE);
	}
	// Invalid roles will be found in the role search
	if (cleanUser.role) {
		const roleData = await search.searchByValue({
			schema: 'system',
			table: 'hdb_role',
			search_attribute: 'role',
			search_value: cleanUser.role,
			get_attributes: ['*'],
		});

		if (!roleData || roleData.length === 0)
			throw new ClientError(HDB_ERROR_MSGS.ALTER_USER_ROLE_NOT_FOUND(cleanUser.role), HTTP_STATUS_CODES.NOT_FOUND);

		if (roleData.length > 1)
			throw new ClientError(HDB_ERROR_MSGS.DUP_ROLES_FOUND(cleanUser.role), HTTP_STATUS_CODES.CONFLICT);

		cleanUser.role = roleData[0].id;
	}

	const updateResponse = await insert.update({
		operation: 'update',
		schema: 'system',
		table: 'hdb_user',
		records: [cleanUser],
	});

	await setUsersWithRolesCache();
	signalling.signalUserChange(new UserEventMsg(process.pid));

	return updateResponse;
}

function isClusterUser(username) {
	let isClusterUser = false;
	const userRole = usersWithRolesMap.get(username);

	if (userRole && userRole.role.permission.cluster_user === true) {
		isClusterUser = true;
	}

	return isClusterUser;
}

async function dropUser(user) {
	const validationResp = validation.dropUserValidation(user);
	if (validationResp) throw new ClientError(validationResp.message);

	if (usersWithRolesMap.get(user.username) === undefined)
		throw new ClientError(HDB_ERROR_MSGS.USER_NOT_EXIST(user.username), HTTP_STATUS_CODES.NOT_FOUND);

	const deleteResponse = await promiseDelete({
		table: 'hdb_user',
		schema: 'system',
		hash_values: [user.username],
	});

	logger.debug(deleteResponse);
	await setUsersWithRolesCache();
	signalling.signalUserChange(new UserEventMsg(process.pid));
	return `${user.username} successfully deleted`;
}

async function userInfo(body) {
	let user = {};
	if (!body || !body.hdb_user) {
		return 'There was no user info in the body';
	}

	user = _.cloneDeep(body.hdb_user);
	let roleData = await search.searchByHash({
		schema: 'system',
		table: 'hdb_role',
		hash_values: [user.role.id],
		get_attributes: ['*'],
	});

	user.role = roleData[0];
	delete user.password;
	delete user.refresh_token;
	delete user.hash;
	delete user.hash_function;

	return user;
}

/**
 * This function should be called by chooseOperation as it scrubs sensitive information before returning
 * the results of list users.
 */
async function listUsersExternal() {
	const userData = await listUsers();
	userData.forEach((user) => {
		delete user.password;
		delete user.hash;
		delete user.refresh_token;
		delete user.hash_function;
	});

	return [...userData.values()];
}

/**
 * Queries system table for user records, adds role-based perms, scrubs list based on licensed role allowance and returns
 * data in a Map with the username as the key for the entry
 * @returns {Promise<Map<string, object>>}
 */
async function listUsers() {
	const roles = await search.searchByValue({
		schema: 'system',
		table: 'hdb_role',
		search_value: '*',
		search_attribute: 'role',
		get_attributes: ['*'],
	});

	const roleMapObj = {};
	for (let role of roles) {
		roleMapObj[role.id] = _.cloneDeep(role);
	}
	if (Object.keys(roleMapObj).length === 0) return null;

	const users = await search.searchByValue({
		schema: 'system',
		table: 'hdb_user',
		search_value: '*',
		search_attribute: 'username',
		get_attributes: ['*'],
	});

	const userMap = new Map();
	for (let user of users) {
		user = _.cloneDeep(user);
		user.role = roleMapObj[user.role];
		appendSystemTablesToRole(user.role);
		userMap.set(user.username, user);
	}

	return userMap;
}

/**
 * adds system table permissions to a role.  This is used to protect system tables by leveraging operationAuthoriation.
 * @param user_role - Role of the user found during auth.
 */
function appendSystemTablesToRole(user_role) {
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
}

async function setUsersWithRolesCache(cache = undefined) {
	if (cache) usersWithRolesMap = cache;
	else usersWithRolesMap = await listUsers();
}

async function getUsersWithRolesCache() {
	if (!usersWithRolesMap) await setUsersWithRolesCache();
	return usersWithRolesMap;
}

/**
 * iterates global.hdb_users to find and validate the username & optionally the password as well as if they are active.
 * @param {string} username
 * @param {string} pw
 * @param {boolean} validatePassword
 * @returns {Promise<{}|null>}
 */
async function findAndValidateUser(username, pw, validatePassword = true) {
	if (!usersWithRolesMap) {
		await setUsersWithRolesCache();
	}

	const userTmp = usersWithRolesMap.get(username);
	if (!userTmp) {
		if (!validatePassword) return { username };
		throw new ClientError(AUTHENTICATION_ERROR_MSGS.GENERIC_AUTH_FAIL, HTTP_STATUS_CODES.UNAUTHORIZED);
	}

	if (userTmp && !userTmp.active)
		throw new ClientError(AUTHENTICATION_ERROR_MSGS.USER_INACTIVE, HTTP_STATUS_CODES.UNAUTHORIZED);

	const user = {
		active: userTmp.active,
		username: userTmp.username,
	};
	if (userTmp.refresh_token) user.refresh_token = userTmp.refresh_token;
	if (userTmp.role) user.role = userTmp.role;

	if (validatePassword === true) {
		// if matches the cached hash immediately return (the fast path)
		if (passwordHashCache.get(pw) === userTmp.password) return user;
		// if validates, cache the password
		else {
			let validated = password.validate(userTmp.password, pw, userTmp.hash_function || password.HASH_FUNCTION.MD5); // if no hash_function default to legacy MD5
			// argon2id hash validation is async so await it if it is a promise
			if (validated?.then) validated = await validated;
			if (validated === true) passwordHashCache.set(pw, userTmp.password);
			else throw new ClientError(AUTHENTICATION_ERROR_MSGS.GENERIC_AUTH_FAIL, HTTP_STATUS_CODES.UNAUTHORIZED);
		}
	}
	return user;
}

async function getSuperUser() {
	if (!usersWithRolesMap) {
		await setUsersWithRolesCache();
	}
	for (let [, user] of usersWithRolesMap) {
		if (user.role.role === 'super_user') return user;
	}
}

/**
 * Gets the cluster user provided in harperdb-config.yaml from the map of all user.
 * Nats requires plain test passwords, this is why we pass decrypt_hash.
 * The Nats routes require the decrypt_hash to be uri encoded.
 * @returns {Promise<Object>}
 */
async function getClusterUser() {
	const users = await listUsers();
	const clusterUsername = configUtils.getConfigFromFile(terms.CONFIG_PARAMS.CLUSTERING_USER);
	const clusterUser = users.get(clusterUsername);
	if (clusterUser == null || clusterUser?.role?.role !== terms.ROLE_TYPES_ENUM.CLUSTER_USER) return;

	clusterUser.decrypt_hash = cryptoHash.decrypt(clusterUser.hash);
	clusterUser.uri_encoded_d_hash = encodeURIComponent(clusterUser.decrypt_hash);
	clusterUser.uri_encoded_name = encodeURIComponent(clusterUser.username);
	clusterUser.sys_name = clusterUser.username + natsTerms.SERVER_SUFFIX.ADMIN;
	clusterUser.sys_name_encoded = clusterUser.uri_encoded_name + natsTerms.SERVER_SUFFIX.ADMIN;

	return clusterUser;
}

let invalidateCallbacks = [];
server.invalidateUser = function (user) {
	for (let callback of invalidateCallbacks) {
		try {
			callback(user);
		} catch (error) {
			harperLogger.error('Error invalidating user', error);
		}
	}
};

server.onInvalidatedUser = function (callback) {
	invalidateCallbacks.push(callback);
};
