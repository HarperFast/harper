'use strict';

const insert = require('../dataLayer/insert.js');
const search = require('../dataLayer/search.js');
const delete_ = require('../dataLayer/delete.js');
const validation = require('../validation/role_validation.js');
const signalling = require('../utility/signalling.js');
const uuidV4 = require('uuid').v4;
const util = require('util');
const terms = require('../utility/hdbTerms.ts');
const hdbUtils = require('../utility/common_utils.js');
const pSearchSearchByValue = search.searchByValue;
const pSearchSearchByHash = search.searchByHash;
const pDeleteDelete = util.promisify(delete_.delete);
const SearchObject = require('../dataLayer/SearchObject.js');
const SearchByHashObject = require('../dataLayer/SearchByHashObject.js');
const { hdbErrors, handleHDBError } = require('../utility/errors/hdbError.js');
const { HDB_ERROR_MSGS, HTTP_STATUS_CODES } = hdbErrors;
const { UserEventMsg } = require('../server/threads/itc.js');

module.exports = {
	addRole,
	alterRole,
	dropRole,
	listRoles,
};

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
	} catch (err) {
		//no-op, failure is ok
	}
	return role;
}

async function addRole(role) {
	let validationResp = validation.addRoleValidation(role);
	if (validationResp) {
		throw validationResp;
	}

	role = scrubRoleDetails(role);

	let searchObj = {
		schema: 'system',
		table: 'hdb_role',
		search_attribute: 'role',
		search_value: role.role,
		hash_attribute: 'id',
		get_attributes: ['*'],
	};

	let searchRole;
	try {
		// here, and for other interactions, need convert to real array
		searchRole = Array.from((await pSearchSearchByValue(searchObj)) || []);
	} catch (err) {
		throw handleHDBError(err);
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

async function alterRole(role) {
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
		throw handleHDBError(err);
	}

	if (updateResponse && updateResponse?.message === 'updated 0 of 1 records') {
		throw handleHDBError(new Error(), 'Invalid role id', HTTP_STATUS_CODES.BAD_REQUEST, undefined, undefined, true);
	}

	await signalling.signalUserChange(new UserEventMsg(process.pid));
	return role;
}

async function dropRole(role) {
	let validationResp = validation.dropRoleValidation(role);
	if (validationResp) {
		throw handleHDBError(new Error(), validationResp, HTTP_STATUS_CODES.BAD_REQUEST, undefined, undefined, true);
	}

	let roleIdSearch = new SearchByHashObject(
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

	let searchUserByRoleid = new SearchObject(
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

async function listRoles() {
	let searchObj = {
		table: 'hdb_role',
		schema: 'system',
		hash_attribute: 'id',
		search_attribute: 'id',
		search_value: '*',
		get_attributes: ['*'],
	};

	return pSearchSearchByValue(searchObj);
}
