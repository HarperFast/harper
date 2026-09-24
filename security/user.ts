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
	findAndValidateUser,
	getUserWithRole,
	isCurrentUser,
	userRecordVersions,
	trackUserRecords,
	onUserChange,
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
import * as hdbUtility from '../utility/common_utils.ts';
import * as validate from 'validate.js';
import * as logger from '../utility/logging/harper_logger.ts';
import { promisify } from 'util';
import * as env from '../utility/environment/environmentManager.ts';
import systemSchema from '../json/systemSchema.json';
import { hdbErrors, ClientError } from '../utility/errors/hdbError.ts';
const { HTTP_STATUS_CODES, AUTHENTICATION_ERROR_MSGS, HDB_ERROR_MSGS } = hdbErrors;
import * as _ from 'lodash';
import * as harperLogger from '../utility/logging/harper_logger.ts';

// Need to use `.js` even for other TS files since TS compiler won't replace requires.
// Whenever we can fix the cyclical dependency issue in this file (and switch to imports) we can use the correct file extensions.
import * as password from '../utility/password.ts';
import { server } from '../server/Server.ts';
import * as terms from '../utility/hdbTerms.ts';
import { expandOperationsPerms } from '../utility/operationPermissions.ts';
import { activeSuperUserRemains } from './superUserGuard.ts';
import { credentialRejectionError } from './credentialRejection.ts';
import { databases, getDatabases, onUpdatedTable } from '../resources/databases.ts';
import { VERSION_REUSED } from '../resources/RecordEncoder.ts';
import { contextStorage } from '../resources/transaction.ts';

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
const { USER_TABLE_NAME, ROLE_TABLE_NAME } = terms.SYSTEM_TABLE_NAMES;

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

	if (insertResponse.skipped_hashes.length === 1) {
		throw new ClientError(HDB_ERROR_MSGS.USER_ALREADY_EXISTS(cleanUser.username), HTTP_STATUS_CODES.CONFLICT);
	}

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

	return updateResponse;
}

async function dropUser(user: User | any): Promise<string> {
	const validationResp = validation.dropUserValidation(user);
	if (validationResp) throw new ClientError(validationResp.message);

	if (!getUserWithRole(user.username))
		throw new ClientError(HDB_ERROR_MSGS.USER_NOT_EXIST(user.username), HTTP_STATUS_CODES.NOT_FOUND);

	await assertActiveSuperUserRemains((existing) => (existing.username === user.username ? undefined : existing));

	const deleteResponse = await promiseDelete({
		table: 'hdb_user',
		schema: 'system',
		hash_values: [user.username],
	});

	logger.debug(deleteResponse);
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
		roleMapObj[role.id] = withSystemTablePermissions(role);
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
		if (!user.role) logger.error(`invalid user role found.`);
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
	if (!userRole.permission) {
		// reachable only via a direct table write or a replicated write; the operations API requires permission
		logger.error(`role ${userRole.role ?? userRole.id} has no permission; skipping system table permissions.`);
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

/**
 * Pre-expands operations into a Set at cache-load time so verifyPerms can do an O(1) lookup
 * instead of allocating and expanding on every request.
 * @param userRole - Role of the user found during auth.
 */
function cacheExpandedOperationsPerms(userRole: UserRole) {
	if (!userRole?.permission?.operations) return;
	userRole.permission._expandedOperations = expandOperationsPerms(userRole.permission.operations);
}

function withSystemTablePermissions(roleRecord: UserRole): UserRole {
	const role = _.cloneDeep(roleRecord);
	appendSystemTablesToRole(role);
	cacheExpandedOperationsPerms(role);
	return role;
}

interface RecordEntry {
	value: any;
	version?: number;
	metadataFlags?: number;
}

interface UserEntries {
	user?: RecordEntry;
	role?: RecordEntry;
}

function systemStore(tableName: string) {
	const table = getDatabases().system?.[tableName];
	if (!table) throw new Error(`Table system.${tableName} not found`);
	return table.primaryStore;
}

function readEntry(store, id): RecordEntry | undefined {
	const entry = store.getEntry(id);
	return entry?.value == null ? undefined : entry;
}

/**
 * What a later read must match to be the same committed record: null for no record, else its version,
 * or its value when a resequenced write reused the version (RecordEncoder.ts VERSION_REUSED) so the
 * version no longer identifies one value. A record stored without metadata (harper#2012) has no
 * version until it is next written.
 */
type RecordStamp = number | object | null;

function stampOf(entry: RecordEntry | undefined): RecordStamp {
	if (entry === undefined) return null;
	if (entry.metadataFlags & VERSION_REUSED) return entry.value;
	return entry.version ?? 0;
}

function holdsStamp(entry: RecordEntry | undefined, stamp: RecordStamp): boolean {
	if (entry === undefined || stamp === null) return entry === undefined && stamp === null;
	if (typeof stamp === 'object') return _.isEqual(entry.value, stamp);
	return !(entry.metadataFlags & VERSION_REUSED) && (entry.version ?? 0) === stamp;
}

// The verification table (RocksDB) confirms a version without a read; a miss there only means "read it"
function isUnchanged(store, id, stamp: RecordStamp): boolean {
	if (typeof stamp === 'number' && stamp !== 0 && store.verifyVersion?.(id, stamp)) return true;
	return holdsStamp(readEntry(store, id), stamp);
}

// LMDB rejects a key over this many bytes; a longer username is unauthenticatable, not an internal fault
const MAX_USERNAME_KEY_BYTES = 1978;
// A user/role pair recheck retries only while a write keeps landing between the two reads; this bounds
// the retry against a sustained write storm on the same user, which would otherwise spin the event loop
const MAX_USER_ENTRY_ATTEMPTS = 50;

/** The user and its role as of one committed state. */
function readUserEntries(username: string): UserEntries {
	if ((typeof username !== 'string' && typeof username !== 'number') || username === '') return {};
	if (typeof username === 'string' && Buffer.byteLength(username, 'utf8') > MAX_USERNAME_KEY_BYTES) return {};
	const userStore = systemStore(USER_TABLE_NAME);
	const roleStore = systemStore(ROLE_TABLE_NAME);
	let user = readEntry(userStore, username);
	for (let attempt = 0; attempt < MAX_USER_ENTRY_ATTEMPTS; attempt++) {
		if (user?.value.role == null) return { user };
		const role = readEntry(roleStore, user.value.role);
		// RocksDB reads share no snapshot: a user unchanged since before its role was read held at that moment
		if (isUnchanged(userStore, username, stampOf(user))) return { user, role };
		user = readEntry(userStore, username);
	}
	return {};
}

// a memo, so clearing it only costs recomputation; bounds it under role churn
const MAX_DERIVED_ROLES = 1024;
const derivedRoles = new Map<unknown, { stamp: RecordStamp; role: UserRole }>();

function derivedRole(roleId: unknown, entry: RecordEntry | undefined): UserRole | undefined {
	if (!entry) {
		derivedRoles.delete(roleId);
		return undefined;
	}
	const derived = derivedRoles.get(roleId);
	if (derived && holdsStamp(entry, derived.stamp)) return derived.role;
	const role = withSystemTablePermissions(entry.value);
	if (derivedRoles.size >= MAX_DERIVED_ROLES) derivedRoles.clear();
	derivedRoles.set(roleId, { stamp: stampOf(entry), role });
	return role;
}

interface UserProvenance {
	username: string;
	userStamp: RecordStamp;
	roleId?: unknown;
	roleStamp: RecordStamp;
}

const userProvenance = new WeakMap<User, UserProvenance>();
const trackedProvenance = new WeakMap<User, UserProvenance>();

function provenanceOf(username: string, entries: UserEntries): UserProvenance {
	return {
		username,
		userStamp: stampOf(entries.user),
		roleId: entries.user?.value.role,
		roleStamp: stampOf(entries.role),
	};
}

function userView(username: string, entries: UserEntries): User {
	const record = entries.user?.value;
	const user: User = record ? { active: record.active, username: record.username } : { username };
	if (record?.refresh_token) user.refresh_token = record.refresh_token;
	const role = record && derivedRole(record.role, entries.role);
	// verifyPerms replaces role.permission on the request's user; the derived role is shared
	if (role) user.role = { ...role, permission: { ...role.permission } };
	userProvenance.set(user, provenanceOf(username, entries));
	return user;
}

function getUserWithRole(username: string): User | undefined {
	const entries = readUserEntries(username);
	return entries.user && userView(username, entries);
}

function userRecordVersions(username: string): UserProvenance {
	return provenanceOf(username, readUserEntries(username));
}

/**
 * Makes `isCurrentUser` check a user resolved outside this module against the record versions read
 * before it was resolved; a write in between then shows as a change.
 */
function trackUserRecords(user: User, versions: UserProvenance): void {
	if (user && typeof user === 'object' && !userProvenance.has(user)) trackedProvenance.set(user, versions);
}

/**
 * Whether the user and role records a user was built from are still the committed ones. A user with
 * no recorded versions (a scoped token, whose role it carries itself) is current.
 */
function isCurrentUser(user: User): boolean {
	const provenance = userProvenance.get(user) ?? trackedProvenance.get(user);
	if (!provenance) return true;
	if (!isUnchanged(systemStore(USER_TABLE_NAME), provenance.username, provenance.userStamp)) return false;
	return (
		provenance.roleId == null || isUnchanged(systemStore(ROLE_TABLE_NAME), provenance.roleId, provenance.roleStamp)
	);
}

/**
 * `simulate` maps each user to what the pending change would make it; undefined means removed.
 * Local view only — `system` is replicated, so a lagging node can approve what another rejects.
 */
async function assertActiveSuperUserRemains(simulate: (user: User) => User | undefined): Promise<void> {
	const users = await listUsers();
	if (!users) return;
	if (activeSuperUserRemains(users.values(), simulate)) return;
	throw new ClientError(HDB_ERROR_MSGS.LAST_SUPER_USER, HTTP_STATUS_CODES.CONFLICT);
}

/**
 * Finds the user and optionally validates the password; an inactive user is rejected.
 * @param {string} username
 * @param {string} pw
 * @param {boolean} validatePassword
 */
async function findAndValidateUser(username: string, pw?: string | null, validatePassword = true): Promise<User> {
	const entries = readUserEntries(username);
	const record = entries.user?.value;
	if (!record) {
		if (!validatePassword) return userView(username, entries);
		throw credentialRejectionError(AUTHENTICATION_ERROR_MSGS.GENERIC_AUTH_FAIL, HTTP_STATUS_CODES.UNAUTHORIZED);
	}

	if (!record.active)
		throw credentialRejectionError(AUTHENTICATION_ERROR_MSGS.USER_INACTIVE, HTTP_STATUS_CODES.UNAUTHORIZED);

	const user = userView(username, entries);

	if (validatePassword === true) {
		// if matches the cached hash immediately return (the fast path)
		if (passwordHashCache.get(pw) === record.password) return user;
		// if validates, cache the password
		else {
			let validated: boolean | Promise<boolean> = password.validate(
				record.password,
				pw,
				record.hash_function || password.HASH_FUNCTION.MD5
			); // if no hashFunction default to legacy MD5
			// argon2id hash validation is async so await it if it is a promise
			if (typeof validated === 'object' && (validated as Promise<boolean>)?.then) validated = await validated;
			if (validated === true) passwordHashCache.set(pw, record.password);
			else throw credentialRejectionError(AUTHENTICATION_ERROR_MSGS.GENERIC_AUTH_FAIL, HTTP_STATUS_CODES.UNAUTHORIZED);
		}
	}
	return user;
}

let superUsername: string | undefined;

async function getSuperUser(): Promise<User | undefined> {
	if (superUsername !== undefined) {
		const user = getUserWithRole(superUsername);
		if (user?.role?.role === 'super_user') return user;
	}
	superUsername = undefined;
	for (const [username, user] of (await listUsers()) ?? []) {
		if (user.role?.role === 'super_user') {
			superUsername = username;
			return getUserWithRole(username);
		}
	}
}

const userChangeListeners: Array<() => void | Promise<void>> = [];
const userChangeSubscriptions = new Map<string, { table: any; subscription: Promise<any> }>();
let userChangeNotificationScheduled = false;
let unauditedUserTableLogged = false;
const SUBSCRIBE_RETRY_MIN_MS = 1000;
const SUBSCRIBE_RETRY_MAX_MS = 60_000;
let subscribeRetryDelay = SUBSCRIBE_RETRY_MIN_MS;

/**
 * Calls `listener` on this thread after `system.hdb_user` or `system.hdb_role` changes, from any thread
 * or a replicated write, at most once per event-loop turn. For consumers already holding a user (live
 * subscriptions, MCP sessions); lookups need no notification because they read the records.
 */
function onUserChange(listener: () => void | Promise<void>): void {
	userChangeListeners.push(listener);
	if (userChangeListeners.length > 1) return;
	onUpdatedTable((table) => {
		if (table.databaseName === terms.SYSTEM_SCHEMA_NAME) subscribeToUserChanges(table);
	});
	for (const tableName of [USER_TABLE_NAME, ROLE_TABLE_NAME]) {
		const table = databases.system?.[tableName];
		if (table) subscribeToUserChanges(table);
	}
}

function subscribeToUserChanges(table): void {
	const { tableName } = table;
	if (tableName !== USER_TABLE_NAME && tableName !== ROLE_TABLE_NAME) return;
	const previous = userChangeSubscriptions.get(tableName);
	if (previous?.table === table) return;
	userChangeSubscriptions.delete(tableName);
	previous?.subscription.then(
		(subscription) => subscription?.end?.(),
		() => {}
	);
	// Subscribing to an unaudited table would enable and persist auditing on it
	if (!table.audit) {
		if (!unauditedUserTableLogged) {
			unauditedUserTableLogged = true;
			logger.info(
				`system.${tableName} is not audited, so live subscriptions and MCP sessions are not notified of user or role changes`
			);
		}
		return;
	}
	// outside any request context, which the subscription would otherwise adopt for its lifetime
	const subscription = contextStorage.exit(() =>
		table.subscribe({ listener: scheduleUserChangeNotification, omitCurrent: true })
	);
	userChangeSubscriptions.set(tableName, { table, subscription });
	subscription.then(
		() => (subscribeRetryDelay = SUBSCRIBE_RETRY_MIN_MS),
		(error) => {
			if (userChangeSubscriptions.get(tableName)?.subscription !== subscription) return;
			userChangeSubscriptions.delete(tableName);
			logger.error(`Failed to subscribe to system.${tableName} for user changes; retrying`, error);
			setTimeout(() => {
				if (databases.system?.[tableName] === table) subscribeToUserChanges(table);
			}, subscribeRetryDelay).unref();
			subscribeRetryDelay = Math.min(subscribeRetryDelay * 2, SUBSCRIBE_RETRY_MAX_MS);
		}
	);
}

function scheduleUserChangeNotification(): void {
	if (userChangeNotificationScheduled) return;
	userChangeNotificationScheduled = true;
	setImmediate(notifyUserChangeListeners);
}

function notifyUserChangeListeners(): void {
	userChangeNotificationScheduled = false;
	for (const listener of userChangeListeners) {
		try {
			const result: any = listener();
			if (typeof result?.catch === 'function')
				result.catch((error) => logger.error('User change listener failed', error));
		} catch (error) {
			logger.error('User change listener failed', error);
		}
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
