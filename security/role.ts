'use strict';

import * as insert from '../dataLayer/insert.ts';
import * as search from '../dataLayer/search.ts';
import * as delete_ from '../dataLayer/delete.ts';
import * as validation from '../validation/role_validation.ts';
import * as signalling from '../utility/signalling.ts';
import * as util from 'util';
import * as terms from '../utility/hdbTerms.ts';
import * as hdbUtils from '../utility/common_utils.ts';
import { databases } from '../resources/databases.ts';
const pSearchSearchByValue = search.searchByValue;
const pSearchSearchByHash = search.searchByHash;
const pDeleteDelete = util.promisify(delete_.delete_);
import SearchObject from '../dataLayer/SearchObject.ts';
import SearchByHashObject from '../dataLayer/SearchByHashObject.ts';
import { handleHDBError } from '../utility/errors/hdbError.ts';
import { HDB_ERROR_MSGS, HTTP_STATUS_CODES } from '../utility/errors/commonErrors.ts';

import { UserEventMsg } from '../server/threads/itc.js';

function scrubRoleDetails(role) {
	try {
		if (role.hdb_auth_header) {
			delete role.hdb_auth_header;
		}
		if (role.HDB_INTERNAL_PATH) {
			delete role.HDB_INTERNAL_PATH;
		}
		if (role.operation) {
			delete role.operation;
		}
		if (role.hdb_user) {
			delete role.hdb_user;
		}
	} catch {
		//no-op, failure is ok
	}
	return role;
}

export async function addRole(role: any) {
	let validationResp = validation.addRoleValidation(role);
	if (validationResp) {
		throw validationResp;
	}

	role = scrubRoleDetails(role);

	let searchObj = {
		schema: 'system',
		table: 'hdb_role',
		attribute: 'role',
		value: role.role,
		hash_attribute: 'id',
		get_attributes: ['*'],
	};

	let searchRole;
	try {
		// here, and for other interactions, need convert to real array
		searchRole = Array.from((await pSearchSearchByValue(searchObj)) || []);
	} catch (err) {
		throw handleHDBError(err as any, undefined, undefined, undefined, undefined, undefined);
	}

	if (searchRole && searchRole.length > 0) {
		throw handleHDBError(
			new Error(),
			HDB_ERROR_MSGS.ROLE_ALREADY_EXISTS(role.role),
			HTTP_STATUS_CODES.CONFLICT,
			undefined,
			undefined,
			true
		);
	}

	if (!role.id) role.id = role.role;

	let insertObject = {
		operation: 'insert',
		schema: 'system',
		table: 'hdb_role',
		hash_attribute: 'id',
		records: [role],
	};

	await insert.insert(insertObject);

	signalling.signalUserChange(new UserEventMsg(process.pid));

	role = scrubRoleDetails(role);
	return role;
}

export async function alterRole(role: any) {
	let validationResp = validation.alterRoleValidation(role);
	if (validationResp) {
		throw validationResp;
	}

	role = scrubRoleDetails(role);

	let updateObject = {
		operation: 'update',
		schema: 'system',
		table: 'hdb_role',
		records: [role],
	};

	let updateResponse;
	try {
		updateResponse = await insert.update(updateObject);
	} catch (err) {
		throw handleHDBError(err as any, undefined, undefined, undefined, undefined, undefined);
	}

	if (updateResponse && updateResponse?.message === 'updated 0 of 1 records') {
		throw handleHDBError(new Error(), 'Invalid role id', HTTP_STATUS_CODES.BAD_REQUEST, undefined, undefined, true);
	}

	await signalling.signalUserChange(new UserEventMsg(process.pid));
	return role;
}

export async function dropRole(role: any) {
	let validationResp = validation.dropRoleValidation(role);
	if (validationResp) {
		throw handleHDBError(new Error(), validationResp, HTTP_STATUS_CODES.BAD_REQUEST, undefined, undefined, true);
	}

	let roleIdSearch = new (SearchByHashObject as any)(
		terms.SYSTEM_SCHEMA_NAME,
		terms.SYSTEM_TABLE_NAMES.ROLE_TABLE_NAME,
		[role.id],
		['role']
	);
	let roleName = Array.from(await pSearchSearchByHash(roleIdSearch));

	if (roleName.length === 0) {
		throw handleHDBError(
			new Error(),
			HDB_ERROR_MSGS.ROLE_NOT_FOUND,
			HTTP_STATUS_CODES.NOT_FOUND,
			undefined,
			undefined,
			true
		);
	}

	let searchUserByRoleid = new (SearchObject as any)(
		terms.SYSTEM_SCHEMA_NAME,
		terms.SYSTEM_TABLE_NAMES.USER_TABLE_NAME,
		'role',
		role.id,
		undefined,
		['username', 'active']
	);
	let foundUsers = Array.from(await pSearchSearchByValue(searchUserByRoleid));
	let activeUsers = false;
	if (hdbUtils.isEmptyOrZeroLength(foundUsers) === false) {
		for (let k = 0; k < foundUsers.length; k++) {
			if (foundUsers[k].active === true) {
				activeUsers = true;
				break;
			}
		}
	}

	if (activeUsers === true) {
		throw handleHDBError(
			new Error(),
			`Cannot drop role ${roleName[0].role} as it has active user(s) tied to this role`,
			HTTP_STATUS_CODES.CONFLICT,
			undefined,
			undefined,
			true
		);
	}

	let deleteObject = {
		table: 'hdb_role',
		schema: 'system',
		hash_values: [role.id],
	};

	await pDeleteDelete(deleteObject);

	signalling.signalUserChange(new UserEventMsg(process.pid));
	return `${roleName[0].role} successfully deleted`;
}

export async function getRoleByName(roleName: string) {
	for await (const role of databases.system.hdb_role.search([{ attribute: 'role', value: roleName } as any])) {
		return role;
	}
	return null;
}

export async function listRoles() {
	let searchObj = {
		table: 'hdb_role',
		schema: 'system',
		hash_attribute: 'id',
		attribute: 'id',
		value: '*',
		get_attributes: ['*'],
	};

	return pSearchSearchByValue(searchObj);
}
