'use strict';

const USERNAME_REQUIRED = 'username is required';
const ALTERUSER_NOTHING_TO_UPDATE = 'nothing to update, must supply active, role or password to update';
// eslint-disable-next-line sonarjs/no-hardcoded-passwords
const EMPTY_PASSWORD = 'password cannot be an empty string';
const EMPTY_ROLE = 'If role is specified, it cannot be empty.';
const ACTIVE_BOOLEAN = 'active must be true or false';

export {
	addUser,
	alterUser,
	dropUser,
	getSuperUser,
	userInfo,
	listUsers,
	listUsersExternal,
	setUsersWithRolesCache,
	findAndValidateUser,
	getUsersWithRolesCache,
	USERNAME_REQUIRED,
	ALTERUSER_NOTHING_TO_UPDATE,
	EMPTY_PASSWORD,
	EMPTY_ROLE,
	ACTIVE_BOOLEAN,
};

export interface User {
	active?: boolean;
	username: string;
	role?: UserRole;
	__updatedtime__?: number;
	__createdtime__?: number;
	[other: string]: unknown;
}

export interface UserRole {
	permission: UserRoleNamedPermissions & UserRoleDatabasePermissions;
	role: string;
	id: string;
	__updatedtime__: number;
	__createdtime__: number;
}

export interface UserRoleNamedPermissions extends Partial<CRUDPermissions> {
	super_user?: boolean;
	cluster_user?: boolean;
	structure_user?: boolean;
}

export interface UserRoleDatabasePermissions {
	[databaseName: string]: UserRoleSchemaRecord;
}

export interface UserRoleSchemaRecord extends Partial<CRUDPermissions> {
	tables: Record<string, UserRolePermissionTable | UserLegacyRolePermissionTable>;
}

export interface UserRolePermissionTable extends CRUDPermissions {
	attribute_permissions: UserRoleAttributePermissionTable[];
}

export interface UserRoleAttributePermissionTable extends Omit<CRUDPermissions, 'delete'> {
	attribute_name: string;
}

export interface UserLegacyRolePermissionTable extends CRUDPermissions {
	attribute_restrictions: UserLegacyRoleAttributePermissionTable[];
}

export interface UserLegacyRoleAttributePermissionTable extends CRUDPermissions {
	attribute_name: string;
}

export interface CRUDPermissions {
	read: boolean;
	insert: boolean;
	update: boolean;
	delete: boolean;
}

//requires must be declared after module.exports to avoid cyclical dependency
const insert = require('../dataLayer/insert.js');
const delete_ = require('../dataLayer/delete.js');
const validation = require('../validation/user_validation.js');
const search = require('../dataLayer/search.js');
const signalling = require('../utility/signalling.js');
const hdbUtility = require('../utility/common_utils.js');
const validate = require('validate.js');
const logger = require('../utility/logging/harper_logger.js');
const { promisify } = require('util');
const env = require('../utility/environment/environmentManager.js');
const systemSchema = require('../json/systemSchema.json');
const { hdbErrors, ClientError } = require('../utility/errors/hdbError.js');
const { HTTP_STATUS_CODES, AUTHENTICATION_ERROR_MSGS, HDB_ERROR_MSGS } = hdbErrors;
const { UserEventMsg } = require('../server/threads/itc.js');
const _ = require('lodash');
const harperLogger = require('../utility/logging/harper_logger.js');

// Need to use `.js` even for other TS files since TS compiler won't replace requires.
// Whenever we can fix the cyclical dependency issue in this file (and switch to imports) we can use the correct file extensions.
const password = require('../utility/password.js');
const { server } = require('../server/Server.js');
const terms = require('../utility/hdbTerms.js');

server.getUser = (username: string, password?: string | null): Promise<User> => {
	return findAndValidateUser(username, password, password != null);
};

server.authenticateUser = (username: string, password?: string | null): Promise<User> => {
	return findAndValidateUser(username, password);
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

async function addUser(user: User | any): Promise<string> {
	let cleanUser = validate.cleanAttributes(user, USER_ATTRIBUTE_ALLOWLIST);
	let validationResp = validation.addUserValidation(cleanUser);
	if (validationResp) throw new ClientError(validationResp.message);

	let searchRole = await search.searchByValue({
		schema: 'system',
		table: 'hdb_role',
		attribute: 'role',
		value: cleanUser.role,
		get_attributes: ['id', 'permission', 'role'],
	});

	if (!searchRole || searchRole.length < 1) {
		throw new ClientError(HDB_ERROR_MSGS.ROLE_NAME_NOT_FOUND(cleanUser.role), HTTP_STATUS_CODES.NOT_FOUND);
	}

	if (searchRole.length > 1) {
		throw new ClientError(HDB_ERROR_MSGS.DUP_ROLES_FOUND(cleanUser.role), HTTP_STATUS_CODES.CONFLICT);
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

async function alterUser(jsonMessage) {
	let cleanUser = validate.cleanAttributes(jsonMessage, USER_ATTRIBUTE_ALLOWLIST);

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
		cleanUser.password = await password.hash(cleanUser.password, configuredHashFunction);
		cleanUser.hash_function = configuredHashFunction;
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
			attribute: 'role',
			value: cleanUser.role,
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

async function dropUser(user: User | any): Promise<string> {
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

async function userInfo(body): Promise<string | User> {
	if (!body || !body.hdb_user) {
		return 'There was no user info in the body';
	}

	let user = _.cloneDeep(body.hdb_user);
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
async function listUsersExternal(): Promise<User[]> {
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
 */
async function listUsers(): Promise<Map<string, User>> {
	const roles = await search.searchByValue({
		schema: 'system',
		table: 'hdb_role',
		value: '*',
		attribute: 'role',
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
		value: '*',
		attribute: 'username',
		get_attributes: ['*'],
	});

	const userMap: Map<string, User> = new Map();
	for (let user of users) {
		// eslint-disable-next-line sonarjs/updated-loop-counter
		user = _.cloneDeep(user);
		user.role = roleMapObj[user.role];
		appendSystemTablesToRole(user.role);
		userMap.set(user.username, user);
	}

	return userMap;
}

/**
 * adds system table permissions to a role.  This is used to protect system tables by leveraging operationAuthorization.
 * @param userRole - Role of the user found during auth.
 */
function appendSystemTablesToRole(userRole: UserRole) {
	if (!userRole) {
		logger.error(`invalid user role found.`);
		return;
	}
	if (!userRole.permission.system) {
		userRole.permission.system = {
			tables: {},
		};
	}
	if (!userRole.permission.system.tables) {
		userRole.permission.system.tables = {};
	}
	for (let table of Object.keys(systemSchema)) {
		let newProp = {
			read: !!userRole.permission.super_user,
			insert: false,
			update: false,
			delete: false,
			attribute_permissions: [],
		};

		userRole.permission.system.tables[table] = newProp;
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
 */
async function findAndValidateUser(username: string, pw?: string | null, validatePassword = true): Promise<User> {
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

	const user: User = {
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
			let validated = password.validate(userTmp.password, pw, userTmp.hash_function || password.HASH_FUNCTION.MD5); // if no hashFunction default to legacy MD5
			// argon2id hash validation is async so await it if it is a promise
			if (validated?.then) validated = await validated;
			if (validated === true) passwordHashCache.set(pw, userTmp.password);
			else throw new ClientError(AUTHENTICATION_ERROR_MSGS.GENERIC_AUTH_FAIL, HTTP_STATUS_CODES.UNAUTHORIZED);
		}
	}
	return user;
}

async function getSuperUser(): Promise<User | undefined> {
	if (!usersWithRolesMap) {
		await setUsersWithRolesCache();
	}
	for (let [, user] of usersWithRolesMap) {
		if (user.role.role === 'super_user') return user;
	}
}

let invalidateCallbacks = [];
server.invalidateUser = function (user: User | any) {
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
