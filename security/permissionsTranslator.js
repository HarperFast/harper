'use strict';

const _ = require('lodash');
const terms = require('../utility/hdbTerms');
const { handleHDBError, hdb_errors } = require('../utility/errors/hdbError');
const { HDB_ERROR_MSGS, HTTP_STATUS_CODES } = hdb_errors;
const logger = require('../utility/logging/harper_logger');

module.exports = {
	getRolePermissions,
};

const role_perms_map = Object.create(null);
const perms_template_obj = (perms_key) => ({ key: perms_key, perms: {} });

const schema_perms_template = (describe_perm = false) => ({
	describe: describe_perm,
	tables: {},
});

const permissions_template = (read_perm = false, insert_perm = false, update_perm = false, delete_perm = false) => ({
	[terms.PERMS_CRUD_ENUM.READ]: read_perm,
	[terms.PERMS_CRUD_ENUM.INSERT]: insert_perm,
	[terms.PERMS_CRUD_ENUM.UPDATE]: update_perm,
	[terms.PERMS_CRUD_ENUM.DELETE]: delete_perm,
});

const table_perms_template = (
	describe_perm = false,
	read_perm = false,
	insert_perm = false,
	update_perm = false,
	delete_perm = false
) => ({
	attribute_permissions: [],
	describe: describe_perm,
	...permissions_template(read_perm, insert_perm, update_perm, delete_perm),
});

const attr_perms_template = (attr_name, perms = permissions_template()) => ({
	attribute_name: attr_name,
	describe: getAttributeDescribePerm(perms),
	[READ]: perms[READ],
	[INSERT]: perms[INSERT],
	[UPDATE]: perms[UPDATE],
});

const timestamp_attr_perms_template = (attr_name, read_perm = false) => ({
	attribute_name: attr_name,
	describe: read_perm,
	[READ]: read_perm,
});

const { READ, INSERT, UPDATE } = terms.PERMS_CRUD_ENUM;
const crud_perm_keys = Object.values(terms.PERMS_CRUD_ENUM);
//we do not need/track DELETE permissions on the attribute level
const attr_crud_perm_keys = [READ, INSERT, UPDATE];

/**
 * Takes role object and evaluates and updates stored permissions based on the more restrictive logic now in place
 * NOTE: Values are stored in a memoization framework so they can be quickly accessed if the arguments/parameters for the
 * function call have not changed
 *
 * @param role
 * @returns {{updated permissions object value}}
 */
function getRolePermissions(role) {
	let role_name;
	try {
		if (role.permission.super_user || role.permission.cluster_user) {
			//Super users and cluster users have full CRUD access to non-system schema items so no translation is required
			return role.permission;
		}

		//permissions only need to be translated for non-system schema items - system specific ops are handled outside of this process
		const non_sys_schema = Object.assign({}, global.hdb_schema);
		delete non_sys_schema[terms.SYSTEM_SCHEMA_NAME];
		role_name = role.role;
		//creates the unique memoization key for the role's permission based on the role updatedtime and non-system
		// schema - if either have changed since the last time the function was called for the role, we re-run the
		// translation to get an updated permissions set
		const perms_key = JSON.stringify([role['__updatedtime__'], non_sys_schema]);

		//If key exists already, we can return the cached value
		if (role_perms_map[role_name] && role_perms_map[role_name].key === perms_key) {
			return role_perms_map[role_name].perms;
		}

		//If the key does not exist, we need new perms
		const new_role_perms = translateRolePermissions(role, non_sys_schema);

		//If the role has not been memoized yet, we create a value in the cache for it and set the key OR just set the new key
		if (!role_perms_map[role_name]) {
			role_perms_map[role_name] = perms_template_obj(perms_key);
		} else {
			role_perms_map[role_name].key = perms_key;
		}

		//Set the new perms return value into the cache
		role_perms_map[role_name].perms = new_role_perms;

		return new_role_perms;
	} catch (e) {
		if (
			!role[terms.TIME_STAMP_NAMES_ENUM.UPDATED_TIME] ||
			role[terms.TIME_STAMP_NAMES_ENUM.UPDATED_TIME] < terms.PERMS_UPDATE_RELEASE_TIMESTAMP
		) {
			const log_msg = `Role permissions for role '${role_name}' must be updated to align with new structure from the 2.2.0 release.`;
			logger.error(log_msg);
			logger.debug(e);
			throw handleHDBError(new Error(), HDB_ERROR_MSGS.OUTDATED_PERMS_TRANSLATION_ERROR, HTTP_STATUS_CODES.BAD_REQUEST);
		} else {
			const log_msg = `There was an error while translating role permissions for role: ${role_name}.\n ${e.stack}`;
			logger.error(log_msg);
			throw handleHDBError(new Error());
		}
	}
}

/**
 * If a perms value is not memoized, this method takes the role and schema and translates final permissions to set for the role
 * and memoize
 *
 * @param role
 * @param schema
 * @returns {{translated_role_perms_obj}}
 */
function translateRolePermissions(role, schema) {
	const final_permissions = Object.create(null);
	final_permissions.super_user = false;

	const perms = role.permission;
	final_permissions[terms.SYSTEM_SCHEMA_NAME] = perms[terms.SYSTEM_SCHEMA_NAME];
	final_permissions.structure_user = perms.structure_user;
	const structure_user =
		Array.isArray(role.permission.structure_user) || role.permission.structure_user === true
			? role.permission.structure_user
			: [];

	Object.keys(schema).forEach((s) => {
		if (structure_user === true || structure_user.indexOf(s) > -1) {
			final_permissions[s] = createStructureUserPermissions(schema[s]);
			return;
		}
		final_permissions[s] = schema_perms_template();
		if (perms[s]) {
			if (perms[s].describe) final_permissions[s].describe = true; // preserve describe
			//translate schema.tables to permissions
			Object.keys(schema[s]).forEach((t) => {
				if (perms[s].tables[t]) {
					//need to evaluate individual table perms AND attr perms
					const table_perms = perms[s].tables[t];
					const table_schema = schema[s][t];

					const updated_table_perms = getTableAttrPerms(table_perms, table_schema);
					//we need to set a read value on each schema for easy evaluation during describe ops - if any
					// CRUD op is set to true for a table in a schema, we set the schema READ perm to true
					if (!final_permissions[s].describe) {
						crud_perm_keys.forEach((key) => {
							if (updated_table_perms[key]) {
								final_permissions[s].describe = true;
							}
						});
					}
					final_permissions[s].tables[t] = updated_table_perms;
				} else {
					//if table is not included in role permissions, table perms set to false
					final_permissions[s].tables[t] = table_perms_template();
				}
			});
		} else {
			//if schema is not included in role permissions, all table perms set to false
			Object.keys(schema[s]).forEach((t) => {
				final_permissions[s].tables[t] = table_perms_template();
			});
		}
	});

	return final_permissions;
}

/**
 * build out full access to describe & CRUD for all tables under a schema (used for structure_user)
 * @param {Object} schema - The schema metadata
 * @returns {{tables: {}, describe: boolean}}
 */
function createStructureUserPermissions(schema) {
	let final_permissions = schema_perms_template(true);
	Object.keys(schema).forEach((t) => {
		final_permissions.tables[t] = table_perms_template(true, true, true, true, true);
	});

	return final_permissions;
}

/**
 * Returns table-specific perms based on the existing permissions and schema for that table
 *
 * @param table_perms
 * @param table_schema
 * @returns {{table_specific_perms}}
 */
function getTableAttrPerms(table_perms, table_schema) {
	const { attribute_permissions } = table_perms;
	const has_attr_permissions = attribute_permissions?.length > 0;

	if (has_attr_permissions) {
		//if table has attribute_permissions set, we need to loop through the table's schema and set attr-level perms
		// based on the attr perms provided OR, if no perms provided for an attr, set attr perms to false
		const final_table_perms = Object.assign({}, table_perms);
		final_table_perms.attribute_permissions = [];
		const attr_r_map = attribute_permissions.reduce((acc, item) => {
			const { attribute_name } = item;
			let attr_perms = item;
			//if an system timestamp attr is included, we only set perms for READ and silently ignore/remove others
			if (terms.TIME_STAMP_NAMES.includes(attribute_name)) {
				attr_perms = timestamp_attr_perms_template(attribute_name, item[READ]);
			}
			acc[attribute_name] = attr_perms;
			return acc;
		}, {});

		const table_hash = table_schema.primaryKey || table_schema.hash_attribute;
		const hash_attr_perm = !!attr_r_map[table_hash];
		//We need to check if all attribute permissions passed for a table are false because, if so, we do not need to
		// force read permission for the table's hash value.  If they are not and the hash value is not included in the
		// attr perms, we need to make sure the user has read permission for the hash attr
		const final_hash_attr_perms = attr_perms_template(table_hash);

		table_schema.attributes.forEach(({ attribute }) => {
			if (attr_r_map[attribute]) {
				//if there is a permission set passed for current attribute, set it to the final perms object
				let attr_perm_obj = attr_r_map[attribute];
				attr_perm_obj.describe = getAttributeDescribePerm(attr_perm_obj);
				final_table_perms.attribute_permissions.push(attr_perm_obj);
				//if hash attr perms are not provided, check current CRUD perms values and make sure hash_attr is provided
				// perms for any CRUD values that are set to true for other attributes
				if (!hash_attr_perm) {
					checkForHashPerms(attr_perm_obj, final_hash_attr_perms);
				}
			} else if (attribute !== table_hash) {
				//if the attr isn't included in attr perms and isn't the hash, we set all perms to false
				let attr_perms;
				if (terms.TIME_STAMP_NAMES.includes(attribute)) {
					attr_perms = timestamp_attr_perms_template(attribute);
				} else {
					attr_perms = attr_perms_template(attribute);
				}
				final_table_perms.attribute_permissions.push(attr_perms);
			}
		});

		//final step is to ensure we include the correct hash attribute permissions in the final permissions object - if
		// hash attr perms are included in the initial perms set, that will be handled above and we can skip this step
		if (!hash_attr_perm) {
			final_table_perms.attribute_permissions.push(final_hash_attr_perms);
		}

		final_table_perms.describe = getSchemaTableDescribePerm(final_table_perms);
		return final_table_perms;
	} else {
		table_perms.describe = getSchemaTableDescribePerm(table_perms);
		return table_perms;
	}
}

/**
 * This method takes a perm object and returns a boolean value for whether or not the schema item should be included in
 * a describe operation for the role being evaluated
 *
 * @param perm_obj - the perm object to evaluate CRUD permissions for
 * @returns {boolean} - returns TRUE if there is at least one CRUD perm set to TRUE
 */
function getSchemaTableDescribePerm(perm_obj) {
	return crud_perm_keys.filter((perm) => perm_obj[perm]).length > 0;
}

function getAttributeDescribePerm(perm_obj) {
	return attr_crud_perm_keys.filter((perm) => perm_obj[perm]).length > 0;
}

/**
 * Checks the attribute permissions object and updates the final hash attribute permissions, if necessary
 *
 * @param attr_perm_obj - perms for attribute being evaluated
 * @param hash_perms - final perms object to update based on attribute being evaluated
 * @returns {hash_perms} - final permissions object that will be assigned to the hash attribute
 */
function checkForHashPerms(attr_perm_obj, hash_perms) {
	attr_crud_perm_keys.forEach((perm) => {
		if (attr_perm_obj[perm] && !hash_perms[perm]) {
			hash_perms[perm] = true;
			hash_perms.describe = true;
		}
	});
}
