'use strict';

const insert = require('../data_layer/insert');
const search = require('../data_layer/search');
const delete_ = require('../data_layer/delete');
const validation = require('../validation/role_validation');
const signalling = require('../utility/signalling');
const uuidV4 = require('uuid').v4;
const util = require('util');
const license = require('../utility/registration/hdb_license');
const terms = require('../utility/hdbTerms');
const hdb_utils = require('../utility/common_utils');
const p_search_search_by_value = util.promisify(search.searchByValue);
const p_search_search_by_hash = util.promisify(search.searchByHash);
const p_delete_delete = util.promisify(delete_.delete);
const SearchObject = require('../data_layer/SearchObject');
const SearchByHashObject = require('../data_layer/SearchByHashObject');
const { hdb_errors, handleHDBError } = require('../utility/errors/hdbError');
const { HDB_ERROR_MSGS, HTTP_STATUS_CODES } = hdb_errors;
const { UserEventMsg } = require('../server/ipc/utility/ipcUtils');

module.exports = {
	addRole: addRole,
	alterRole: alterRole,
	dropRole: dropRole,
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
	let validation_resp = validation.addRoleValidation(role);
	if (validation_resp) {
		throw validation_resp;
	}

	let license_details = await license.getLicense();
	if (!license_details.enterprise) {
		//look to see if there is already a cluster_user role
		let roles = await listRoles();
		let has_cluster_role = checkClusterUserRole(role, roles);
		if (has_cluster_role) {
			throw new Error(
				`Your current license only supports ${terms.BASIC_LICENSE_MAX_CLUSTER_USER_ROLES} cluster_user role. ${terms.SUPPORT_HELP_MSG}`
			);
		}

		if (roles.length >= 2) {
			throw new Error(
				`Your current license only supports ${
					terms.BASIC_LICENSE_MAX_NON_CU_ROLES + terms.BASIC_LICENSE_MAX_CLUSTER_USER_ROLES
				} roles.  ${terms.SUPPORT_HELP_MSG}`
			);
		}
	}

	role = scrubRoleDetails(role);

	let search_obj = {
		schema: 'system',
		table: 'hdb_role',
		search_attribute: 'role',
		search_value: role.role,
		hash_attribute: 'id',
		get_attributes: ['*'],
	};

	let search_role;
	try {
		// here, and for other interactions, need convert to real array
		search_role = Array.from((await p_search_search_by_value(search_obj) )|| []);
	} catch (err) {
		throw handleHDBError(err);
	}

	if (search_role && search_role.length > 0) {
		throw handleHDBError(
			new Error(),
			HDB_ERROR_MSGS.ROLE_ALREADY_EXISTS(role.role),
			HTTP_STATUS_CODES.CONFLICT,
			undefined,
			undefined,
			true
		);
	}

	if (!role.id) role.id = uuidV4();

	let insert_object = {
		operation: 'insert',
		schema: 'system',
		table: 'hdb_role',
		hash_attribute: 'id',
		records: [role],
	};

	await insert.insert(insert_object);

	signalling.signalUserChange(new UserEventMsg(process.pid));

	role = scrubRoleDetails(role);
	return role;
}

function checkClusterUserRole(add_role, roles) {
	let has_cluster_role = false;
	if (add_role.permission.cluster_user === true) {
		for (let x = 0; x < roles.length; x++) {
			let role = roles[x];
			let permission = role.permission;
			if (!hdb_utils.isEmpty(permission) && permission.cluster_user === true) {
				return true;
			}
		}
	}
	return has_cluster_role;
}

async function alterRole(role) {
	let validation_resp = validation.alterRoleValidation(role);
	if (validation_resp) {
		throw validation_resp;
	}

	role = scrubRoleDetails(role);

	let update_object = {
		operation: 'update',
		schema: 'system',
		table: 'hdb_role',
		hash_attribute: 'rolename',
		records: [role],
	};

	try {
		await insert.update(update_object);
	} catch (err) {
		throw handleHDBError(err);
	}

	signalling.signalUserChange(new UserEventMsg(process.pid));
	return role;
}

async function dropRole(role) {
	let validation_resp = validation.dropRoleValidation(role);
	if (validation_resp) {
		throw handleHDBError(new Error(), validation_resp, HTTP_STATUS_CODES.BAD_REQUEST, undefined, undefined, true);
	}

	let role_id_search = new SearchByHashObject(
		terms.SYSTEM_SCHEMA_NAME,
		terms.SYSTEM_TABLE_NAMES.ROLE_TABLE_NAME,
		[role.id],
		['role']
	);
	let role_name = Array.from(await p_search_search_by_hash(role_id_search));

	if (role_name.length === 0) {
		throw handleHDBError(
			new Error(),
			HDB_ERROR_MSGS.ROLE_NOT_FOUND,
			HTTP_STATUS_CODES.NOT_FOUND,
			undefined,
			undefined,
			true
		);
	}

	let search_user_by_roleid = new SearchObject(
		terms.SYSTEM_SCHEMA_NAME,
		terms.SYSTEM_TABLE_NAMES.USER_TABLE_NAME,
		'role',
		role.id,
		undefined,
		['username', 'active']
	);
	let found_users = Array.from(await p_search_search_by_value(search_user_by_roleid));
	let active_users = false;
	if (hdb_utils.isEmptyOrZeroLength(found_users) === false) {
		for (let k = 0; k < found_users.length; k++) {
			if (found_users[k].active === true) {
				active_users = true;
				break;
			}
		}
	}

	if (active_users === true) {
		throw new Error(`Cannot drop role ${role_name[0].role} as it has active user(s) tied to this role`);
	}
	let delete_object = {
		table: 'hdb_role',
		schema: 'system',
		hash_values: [role.id],
	};

	await p_delete_delete(delete_object);

	signalling.signalUserChange(new UserEventMsg(process.pid));
	return `${role_name[0].role} successfully deleted`;
}

async function listRoles() {
	let search_obj = {
		table: 'hdb_role',
		schema: 'system',
		hash_attribute: 'id',
		search_attribute: 'id',
		search_value: '*',
		get_attributes: ['*'],
	};

	return p_search_search_by_value(search_obj);
}
