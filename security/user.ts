'use strict';

const USERNAME_REQUIRED = 'username is required';
const ALTERUSER_NOTHING_TO_UPDATE = 'nothing to update, must supply active, role or password to update';
const EMPTY_PASSWORD = 'password cannot be an empty string';
const EMPTY_ROLE = 'If role is specified, it cannot be empty.';
const ACTIVE_BOOLEAN = 'active must be true or false';

export {
	addUser,
	alterUser,
	assertActiveSuperUserRemains,
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
	structure_user?: boolean | string[];
	operations?: string[];
	/** Pre-expanded Set built from operations at cache-load time. Not persisted. */
	_expandedOperations?: Set<string>;
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
import * as insert from '../dataLayer/insert.ts';
import * as delete_ from '../dataLayer/delete.ts';
import * as validation from '../validation/user_validation.ts';
import * as search from '../dataLayer/search.ts';
import * as signalling from '../utility/signalling.ts';
import * as hdbUtility from '../utility/common_utils.ts';
import * as validate from 'validate.js';
import * as logger from '../utility/logging/harper_logger.ts';
import { promisify } from 'util';
import * as env from '../utility/environment/environmentManager.ts';
import systemSchema from '../json/systemSchema.json';
import { hdbErrors, ClientError } from '../utility/errors/hdbError.ts';
const { HTTP_STATUS_CODES, AUTHENTICATION_ERROR_MSGS, HDB_ERROR_MSGS } = hdbErrors;
const { UserEventMsg } = require('../server/threads/itc.js');
import * as _ from 'lodash';
import * as harperLogger from '../utility/logging/harper_logger.ts';

// Need to use `.js` even for other TS files since TS compiler won't replace requires.
// Whenever we can fix the cyclical dependency issue in this file (and switch to imports) we can use the correct file extensions.
import * as password from '../utility/password.ts';
import { server } from '../server/Server.ts';
import * as terms from '../utility/hdbTerms.ts';
import { expandOperationsPerms } from '../utility/operationPermissions.ts';
import { activeSuperUserRemains } from './superUserGuard.ts';
import { databases, databaseEventsEmitter } from '../resources/databases.ts';

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
const promiseDelete = promisify(delete_.delete_);
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

	await signalling.signalUserChange(new UserEventMsg(process.pid));
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
	let nextRole;
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

		nextRole = roleData[0];
		cleanUser.role = nextRole.id;
	}

	if (nextRole !== undefined || cleanUser.active !== undefined) {
		await assertActiveSuperUserRemains((user) =>
			user.username === cleanUser.username
				? { ...user, role: nextRole ?? user.role, active: cleanUser.active ?? user.active }
				: user
		);
	}

	const updateResponse = await insert.update({
		operation: 'update',
		schema: 'system',
		table: 'hdb_user',
		records: [cleanUser],
	});

	await setUsersWithRolesCache();
	await signalling.signalUserChange(new UserEventMsg(process.pid));

	return updateResponse;
}

async function dropUser(user: User | any): Promise<string> {
	const validationResp = validation.dropUserValidation(user);
	if (validationResp) throw new ClientError(validationResp.message);

	if (usersWithRolesMap.get(user.username) === undefined)
		throw new ClientError(HDB_ERROR_MSGS.USER_NOT_EXIST(user.username), HTTP_STATUS_CODES.NOT_FOUND);

	await assertActiveSuperUserRemains((existing) => (existing.username === user.username ? undefined : existing));

	const deleteResponse = await promiseDelete({
		table: 'hdb_user',
		schema: 'system',
		hash_values: [user.username],
	});

	logger.debug(deleteResponse);
	await setUsersWithRolesCache();
	await signalling.signalUserChange(new UserEventMsg(process.pid));
	return `${user.username} successfully deleted`;
}

async function userInfo(body): Promise<string | User> {
	if (!body || !body.hdb_user) {
		return 'There was no user info in the body';
	}

	let user = _.cloneDeep(body.hdb_user);
	let roleData =
		user.role &&
		(await search.searchByHash({
			schema: 'system',
			table: 'hdb_role',
			hash_values: [user.role.id],
			get_attributes: ['*'],
		}));

	user.role = roleData?.[0];
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
		user = _.cloneDeep(user);
		user.role = roleMapObj[user.role];
		appendSystemTablesToRole(user.role);
		cacheExpandedOperationsPerms(user.role);
		userMap.set(user.username, user);
	}

	return userMap;
}

// Frozen because one instance is shared by every role with the same read permission: an entry
// mutated by any consumer would change what every other user is allowed to do.
function systemTablePermissions(readPerm: boolean): UserRolePermissionTable {
	return Object.freeze({
		read: readPerm,
		insert: false,
		update: false,
		delete: false,
		attribute_permissions: Object.freeze([]) as UserRoleAttributePermissionTable[],
	}) as UserRolePermissionTable;
}

const systemTablesByReadPerm = new Map<boolean, Record<string, UserRolePermissionTable>>();

/**
 * `systemSchema.json` is install-time only; components create `hdb_scheduler_state`, `hdb_session`,
 * `hdb_status` and friends later, and a map built from the JSON alone reports those as nonexistent
 * to every caller, super_user included (harper#2120). The set comes from the live registry that
 * `describe_database` enumerates, so listed and addressable stay one set.
 *
 * Two constraints shape this. It must be a plain object, because operation forwarding
 * structured-clones the request — permissions included — to a worker thread, and a `Proxy` there
 * fails the whole operation with `DataCloneError`. And it must be updated **in place** rather than
 * replaced: `security/auth.ts` serves warmed authorization entries and `getSuperUser()` hands back
 * cached roles, neither of which re-reads a map, so a fresh object would leave those identities on
 * the stale one and reproduce the original 403.
 *
 * Entries are defined rather than assigned so a table named `__proto__` becomes an own property
 * instead of hitting the inherited setter.
 */
function syncSystemTables(tables: Record<string, UserRolePermissionTable>, readPerm: boolean) {
	const live = databases[terms.SYSTEM_SCHEMA_NAME];
	const names = new Set([...Object.keys(systemSchema), ...(live ? Object.keys(live) : [])]);
	for (const name of names) {
		if (!Object.hasOwn(tables, name)) {
			Object.defineProperty(tables, name, {
				value: systemTablePermissions(readPerm),
				writable: true,
				enumerable: true,
				configurable: true,
			});
		}
	}
	for (const name of Object.keys(tables)) {
		if (!names.has(name)) delete tables[name];
	}
}

function systemTablesPermissions(readPerm: boolean): Record<string, UserRolePermissionTable> {
	let tables = systemTablesByReadPerm.get(readPerm);
	if (!tables) {
		tables = {};
		systemTablesByReadPerm.set(readPerm, tables);
		syncSystemTables(tables, readPerm);
	}
	return tables;
}

// Scoped to the system database: these events also fire for user tables, and resyncing on those
// would be pure waste. `Table.dropTable()` deletes from the registry without emitting, so a table
// dropped that way lingers here until the next system-table event — permissively, but only for a
// table the data layer will then refuse as nonexistent anyway.
//
// Never allowed to throw: these listeners run inside `emit` during `getDatabases()` and `table()`,
// so an exception here aborts schema loading and takes the node down. A stale map is a 403.
function refreshSystemTables() {
	try {
		for (const [readPerm, tables] of systemTablesByReadPerm) syncSystemTables(tables, readPerm);
	} catch (error) {
		harperLogger.error('Failed to refresh system table permissions; they may be stale', error);
	}
}
databaseEventsEmitter.on('updateTable', (table) => {
	if (table?.databaseName === terms.SYSTEM_SCHEMA_NAME) refreshSystemTables();
});
databaseEventsEmitter.on('dropTable', (_tableName, databaseName) => {
	if (databaseName === terms.SYSTEM_SCHEMA_NAME) refreshSystemTables();
});

/**
 * adds system table permissions to a role.  This is used to protect system tables by leveraging operationAuthorization.
 * @param userRole - Role of the user found during auth.
 */
function appendSystemTablesToRole(userRole: UserRole) {
	if (!userRole) {
		logger.error(`invalid user role found.`);
		return;
	}
	// A role may declare its own `system` block, and before harper#2120 any entry outside
	// systemSchema.json survived — which let a role grant itself reads and writes on tables like
	// hdb_session. Those are dropped now, so name them: an operator whose grant stops working
	// otherwise sees only a 403 with nothing pointing at the cause.
	const declared = Object.keys(userRole.permission.system?.tables ?? {});
	if (declared.length > 0) {
		harperLogger.warn(
			`Ignoring role-declared permissions on system tables for role '${userRole.id}': ${declared.join(', ')}. ` +
				`System table permissions are managed by Harper and cannot be granted through a role.`
		);
	}
	userRole.permission.system = {
		...userRole.permission.system,
		tables: systemTablesPermissions(!!userRole.permission.super_user),
	};
}

/**
 * Pre-expands operations into a Set at cache-load time so verifyPerms can do an O(1) lookup
 * instead of allocating and expanding on every request.
 * @param userRole - Role of the user found during auth.
 */
function cacheExpandedOperationsPerms(userRole: UserRole) {
	if (!userRole?.permission?.operations) return;
	userRole.permission._expandedOperations = expandOperationsPerms(userRole.permission.operations);
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
 * `simulate` maps each user to what the pending change would make it; undefined means removed.
 * Local view only — `system` is replicated, so a lagging node can approve what another rejects.
 */
async function assertActiveSuperUserRemains(simulate: (user: User) => User | undefined): Promise<void> {
	const users = await getUsersWithRolesCache();
	if (!users) return;
	if (activeSuperUserRemains(users.values(), simulate)) return;
	throw new ClientError(HDB_ERROR_MSGS.LAST_SUPER_USER, HTTP_STATUS_CODES.CONFLICT);
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
	// Shallow-clone the role and its permission so that verifyPerms can replace
	// requestJson.hdb_user.role.permission with translated perms without mutating the cache.
	// The _expandedOperations Set and operations array are shared by reference (read-only).
	if (userTmp.role) user.role = { ...userTmp.role, permission: { ...userTmp.role.permission } };

	if (validatePassword === true) {
		// if matches the cached hash immediately return (the fast path)
		if (passwordHashCache.get(pw) === userTmp.password) return user;
		// if validates, cache the password
		else {
			let validated: boolean | Promise<boolean> = password.validate(
				userTmp.password,
				pw,
				userTmp.hash_function || password.HASH_FUNCTION.MD5
			); // if no hashFunction default to legacy MD5
			// argon2id hash validation is async so await it if it is a promise
			if (typeof validated === 'object' && (validated as Promise<boolean>)?.then) validated = await validated;
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
		if (user.role?.role === 'super_user') return user;
	}
}

let invalidateCallbacks = [];
(server as any).invalidateUser = function (user: User | any) {
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
