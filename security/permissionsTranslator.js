'use strict';

const _ = require('lodash');
const terms = require('../utility/hdbTerms.ts');
const { handleHDBError, hdbErrors } = require('../utility/errors/hdbError.js');
const { HDB_ERROR_MSGS, HTTP_STATUS_CODES } = hdbErrors;
const logger = require('../utility/logging/harper_logger.js');

module.exports = {
	getRolePermissions,
};

const rolePermsMap = Object.create(null);
const permsTemplateObj = (permsKey) => ({ key: permsKey, perms: {} });

const schemaPermsTemplate = (describePerm = false) => ({
	describe: describePerm,
	tables: {},
});

const permissionsTemplate = (readPerm = false, insertPerm = false, updatePerm = false, deletePerm = false) => ({
	[terms.PERMS_CRUD_ENUM.READ]: readPerm,
	[terms.PERMS_CRUD_ENUM.INSERT]: insertPerm,
	[terms.PERMS_CRUD_ENUM.UPDATE]: updatePerm,
	[terms.PERMS_CRUD_ENUM.DELETE]: deletePerm,
});

const tablePermsTemplate = (
	describePerm = false,
	readPerm = false,
	insertPerm = false,
	updatePerm = false,
	deletePerm = false
) => ({
	attribute_permissions: [],
	describe: describePerm,
	...permissionsTemplate(readPerm, insertPerm, updatePerm, deletePerm),
});

const attrPermsTemplate = (attrName, perms = permissionsTemplate()) => ({
	attribute_name: attrName,
	describe: getAttributeDescribePerm(perms),
	[READ]: perms[READ],
	[INSERT]: perms[INSERT],
	[UPDATE]: perms[UPDATE],
});

const timestampAttrPermsTemplate = (attrName, readPerm = false) => ({
	attribute_name: attrName,
	describe: readPerm,
	[READ]: readPerm,
});

const { READ, INSERT, UPDATE } = terms.PERMS_CRUD_ENUM;
const crudPermKeys = Object.values(terms.PERMS_CRUD_ENUM);
//we do not need/track DELETE permissions on the attribute level
const attrCrudPermKeys = [READ, INSERT, UPDATE];

/**
 * Takes role object and evaluates and updates stored permissions based on the more restrictive logic now in place
 * NOTE: Values are stored in a memoization framework so they can be quickly accessed if the arguments/parameters for the
 * function call have not changed
 *
 * @param role
 * @returns {{updated permissions object value}}
 */
function getRolePermissions(role) {
	let roleName;
	try {
		if (role.permission.super_user) {
			//Super users have full CRUD access to non-system schema items so no translation is required
			return role.permission;
		}

		//permissions only need to be translated for non-system schema items - system specific ops are handled outside of this process
		const nonSysSchema = { ...global.hdb_schema };
		delete nonSysSchema[terms.SYSTEM_SCHEMA_NAME];
		roleName = role.role;
		//creates the unique memoization key for the role's permission based on the role updatedtime and non-system
		// schema - if either have changed since the last time the function was called for the role, we re-run the
		// translation to get an updated permissions set
		const permsKey = JSON.stringify([role['__updatedtime__'], nonSysSchema]);

		//If key exists already, we can return the cached value
		if (rolePermsMap[roleName] && rolePermsMap[roleName].key === permsKey) {
			return rolePermsMap[roleName].perms;
		}

		//If the key does not exist, we need new perms
		const newRolePerms = translateRolePermissions(role, nonSysSchema);

		//If the role has not been memoized yet, we create a value in the cache for it and set the key OR just set the new key
		if (!rolePermsMap[roleName]) {
			rolePermsMap[roleName] = permsTemplateObj(permsKey);
		} else {
			rolePermsMap[roleName].key = permsKey;
		}

		//Set the new perms return value into the cache
		rolePermsMap[roleName].perms = newRolePerms;

		return newRolePerms;
	} catch (e) {
		if (
			!role[terms.TIME_STAMP_NAMES_ENUM.UPDATED_TIME] ||
			role[terms.TIME_STAMP_NAMES_ENUM.UPDATED_TIME] < terms.PERMS_UPDATE_RELEASE_TIMESTAMP
		) {
			const logMsg = `Role permissions for role '${role_name}' must be updated to align with new structure from the 2.2.0 release.`;
			logger.error(logMsg);
			logger.debug(e);
			throw handleHDBError(new Error(), HDB_ERROR_MSGS.OUTDATED_PERMS_TRANSLATION_ERROR, HTTP_STATUS_CODES.BAD_REQUEST);
		} else {
			const logMsg = `There was an error while translating role permissions for role: ${roleName}.\n ${e.stack}`;
			logger.error(logMsg);
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
 * @returns {{translatedRolePermsObj}}
 */
function translateRolePermissions(role, schema) {
	const finalPermissions = Object.create(null);
	finalPermissions.super_user = false;

	const perms = role.permission;
	finalPermissions[terms.SYSTEM_SCHEMA_NAME] = perms[terms.SYSTEM_SCHEMA_NAME];
	finalPermissions.structure_user = perms.structure_user;
	const structureUser =
		Array.isArray(role.permission.structure_user) || role.permission.structure_user === true
			? role.permission.structure_user
			: [];

	Object.keys(schema).forEach((s) => {
		if (structureUser === true || structureUser.indexOf(s) > -1) {
			finalPermissions[s] = createStructureUserPermissions(schema[s]);
			return;
		}
		finalPermissions[s] = schemaPermsTemplate();
		if (perms[s]) {
			if (perms[s].describe) finalPermissions[s].describe = true; // preserve describe
			//translate schema.tables to permissions
			Object.keys(schema[s]).forEach((t) => {
				if (perms[s].tables[t]) {
					//need to evaluate individual table perms AND attr perms
					const table_perms = perms[s].tables[t];
					const tableSchema = schema[s][t];

					const updatedTablePerms = getTableAttrPerms(table_perms, tableSchema);
					//we need to set a read value on each schema for easy evaluation during describe ops - if any
					// CRUD op is set to true for a table in a schema, we set the schema READ perm to true
					if (!finalPermissions[s].describe) {
						crudPermKeys.forEach((key) => {
							if (updatedTablePerms[key]) {
								finalPermissions[s].describe = true;
							}
						});
					}
					finalPermissions[s].tables[t] = updatedTablePerms;
				} else {
					//if table is not included in role permissions, table perms set to false
					finalPermissions[s].tables[t] = tablePermsTemplate();
				}
			});
		} else {
			//if schema is not included in role permissions, all table perms set to false
			Object.keys(schema[s]).forEach((t) => {
				finalPermissions[s].tables[t] = tablePermsTemplate();
			});
		}
	});

	return finalPermissions;
}

/**
 * build out full access to describe & CRUD for all tables under a schema (used for structureUser)
 * @param {Object} schema - The schema metadata
 * @returns {{tables: {}, describe: boolean}}
 */
function createStructureUserPermissions(schema) {
	let finalPermissions = schemaPermsTemplate(true);
	Object.keys(schema).forEach((t) => {
		finalPermissions.tables[t] = tablePermsTemplate(true, true, true, true, true);
	});

	return finalPermissions;
}

/**
 * Returns table-specific perms based on the existing permissions and schema for that table
 *
 * @param table_perms
 * @param tableSchema
 * @returns {{tableSpecificPerms}}
 */
function getTableAttrPerms(table_perms, tableSchema) {
	const { attribute_permissions } = table_perms;
	const hasAttrPermissions = attribute_permissions?.length > 0;

	if (hasAttrPermissions) {
		//if table has attribute_permissions set, we need to loop through the table's schema and set attr-level perms
		// based on the attr perms provided OR, if no perms provided for an attr, set attr perms to false
		const finalTablePerms = { ...table_perms };
		finalTablePerms.attribute_permissions = [];
		const attrRMap = attribute_permissions.reduce((acc, item) => {
			const { attribute_name } = item;
			let attrPerms = item;
			//if an system timestamp attr is included, we only set perms for READ and silently ignore/remove others
			if (terms.TIME_STAMP_NAMES.includes(attribute_name)) {
				attrPerms = timestampAttrPermsTemplate(attribute_name, item[READ]);
			}
			acc[attribute_name] = attrPerms;
			return acc;
		}, {});

		const tableHash = tableSchema.primaryKey || tableSchema.hash_attribute;
		const hashAttrPerm = !!attrRMap[tableHash];
		//We need to check if all attribute permissions passed for a table are false because, if so, we do not need to
		// force read permission for the table's hash value.  If they are not and the hash value is not included in the
		// attr perms, we need to make sure the user has read permission for the hash attr
		const finalHashAttrPerms = attrPermsTemplate(tableHash);

		tableSchema.attributes.forEach(({ attribute }) => {
			if (attrRMap[attribute]) {
				//if there is a permission set passed for current attribute, set it to the final perms object
				let attrPermObj = attrRMap[attribute];
				attrPermObj.describe = getAttributeDescribePerm(attrPermObj);
				finalTablePerms.attribute_permissions.push(attrPermObj);
				//if hash attr perms are not provided, check current CRUD perms values and make sure hashAttr is provided
				// perms for any CRUD values that are set to true for other attributes
				if (!hashAttrPerm) {
					checkForHashPerms(attrPermObj, finalHashAttrPerms);
				}
			} else if (attribute !== tableHash) {
				//if the attr isn't included in attr perms and isn't the hash, we set all perms to false
				let attrPerms;
				if (terms.TIME_STAMP_NAMES.includes(attribute)) {
					attrPerms = timestampAttrPermsTemplate(attribute);
				} else {
					attrPerms = attrPermsTemplate(attribute);
				}
				finalTablePerms.attribute_permissions.push(attrPerms);
			}
		});

		//final step is to ensure we include the correct hash attribute permissions in the final permissions object - if
		// hash attr perms are included in the initial perms set, that will be handled above and we can skip this step
		if (!hashAttrPerm) {
			finalTablePerms.attribute_permissions.push(finalHashAttrPerms);
		}

		finalTablePerms.describe = getSchemaTableDescribePerm(finalTablePerms);
		return finalTablePerms;
	} else {
		table_perms.describe = getSchemaTableDescribePerm(table_perms);
		return table_perms;
	}
}

/**
 * This method takes a perm object and returns a boolean value for whether or not the schema item should be included in
 * a describe operation for the role being evaluated
 *
 * @param permObj - the perm object to evaluate CRUD permissions for
 * @returns {boolean} - returns TRUE if there is at least one CRUD perm set to TRUE
 */
function getSchemaTableDescribePerm(permObj) {
	return crudPermKeys.filter((perm) => permObj[perm]).length > 0;
}

function getAttributeDescribePerm(permObj) {
	return attrCrudPermKeys.filter((perm) => permObj[perm]).length > 0;
}

/**
 * Checks the attribute permissions object and updates the final hash attribute permissions, if necessary
 *
 * @param attrPermObj - perms for attribute being evaluated
 * @param hashPerms - final perms object to update based on attribute being evaluated
 * @returns {hashPerms} - final permissions object that will be assigned to the hash attribute
 */
function checkForHashPerms(attrPermObj, hashPerms) {
	attrCrudPermKeys.forEach((perm) => {
		if (attrPermObj[perm] && !hashPerms[perm]) {
			hashPerms[perm] = true;
			hashPerms.describe = true;
		}
	});
}
