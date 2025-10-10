const validate = require('validate.js'),
	validator = require('./validationWrapper.js'),
	terms = require('../utility/hdbTerms.ts'),
	{ handleHDBError, hdbErrors } = require('../utility/errors/hdbError.js');

const { HDB_ERROR_MSGS, HTTP_STATUS_CODES } = hdbErrors;

const constraintsTemplate = () => ({
	role: {
		presence: true,
		format: '[\\w\\-\\_]+',
	},
	id: {
		presence: true,
		format: '[\\w\\-\\_]+',
	},
	permission: {
		presence: true,
	},
});

const STRUCTURE_USER_ENUM = {
	STRUCTURE_USER: 'structure_user',
};

const ROLE_TYPES = Object.values(terms.ROLE_TYPES_ENUM);
const ATTR_PERMS_KEY = 'attribute_permissions';
const ATTR_NAME_KEY = 'attribute_name';
const { PERMS_CRUD_ENUM } = terms;
const TABLE_PERM_KEYS = [ATTR_PERMS_KEY, ...Object.values(PERMS_CRUD_ENUM)];
const ATTR_CRU_KEYS = [PERMS_CRUD_ENUM.READ, PERMS_CRUD_ENUM.INSERT, PERMS_CRUD_ENUM.UPDATE];
const ATTR_PERMS_KEYS = [ATTR_NAME_KEY, ...ATTR_CRU_KEYS];

function addRoleValidation(object) {
	const constraints = constraintsTemplate();
	constraints.role.presence = true;
	constraints.id.presence = false;
	constraints.permission.presence = true;
	return customValidate(object, constraints);
}

function alterRoleValidation(object) {
	const constraints = constraintsTemplate();
	constraints.role.presence = false;
	constraints.id.presence = true;
	constraints.permission.presence = true;
	return customValidate(object, constraints);
}

function dropRoleValidation(object) {
	const constraints = constraintsTemplate();
	constraints.role.presence = false;
	constraints.id.presence = true;
	constraints.permission.presence = false;
	return validator.validateObject(object, constraints);
}

const ALLOWED_JSON_KEYS = ['operation', 'role', 'id', 'permission', 'hdb_user', 'access'];

function customValidate(object, constraints) {
	let validationErrors = {
		main_permissions: [],
		schema_permissions: {},
	};

	const jsonMsgKeys = Object.keys(object);

	//Check to confirm that keys in JSON body are valid
	const invalidKeys = [];
	for (let i = 0, arrLength = jsonMsgKeys.length; i < arrLength; i++) {
		if (!ALLOWED_JSON_KEYS.includes(jsonMsgKeys[i])) {
			invalidKeys.push(jsonMsgKeys[i]);
		}
	}
	if (invalidKeys.length > 0) {
		addPermError(HDB_ERROR_MSGS.INVALID_ROLE_JSON_KEYS(invalidKeys), validationErrors);
	}

	let validateResult = validator.validateObject(object, constraints);
	if (validateResult) {
		validateResult.message.split(',').forEach((validationErr) => {
			addPermError(validationErr, validationErrors);
		});
	}

	//need this check to avoid unexpected errors if someone doesn't have permissions key included in request
	if (object.permission) {
		//check if role is SU or CU and has perms included
		const suPermsError = validateNoSUPerms(object);
		if (suPermsError) {
			addPermError(suPermsError, validationErrors);
		}
		//check if cu or su values, if included, are booleans
		ROLE_TYPES.forEach((role) => {
			if (object.permission[role] && !validate.isBoolean(object.permission[role])) {
				addPermError(HDB_ERROR_MSGS.SU_CU_ROLE_BOOLEAN_ERROR(role), validationErrors);
			}
		});
	}

	for (let item in object.permission) {
		if (ROLE_TYPES.indexOf(item) < 0) {
			//validate the user type 'structure_user'.  acceptable data type is boolean or array of strings (this would be array of accepted schemas to interact with)
			if (item === STRUCTURE_USER_ENUM.STRUCTURE_USER) {
				let structureUserPerm = object.permission[item];

				//boolean is valid, move on
				if (typeof structureUserPerm === 'boolean') {
					continue;
				}

				//array is valid check to make sure each entry is actually a schema.
				if (Array.isArray(structureUserPerm)) {
					for (let k = 0, length = structureUserPerm.length; k < length; k++) {
						let schemaPerm = structureUserPerm[k];
						if (!global.hdb_schema[schemaPerm]) {
							addPermError(HDB_ERROR_MSGS.SCHEMA_NOT_FOUND(schemaPerm), validationErrors);
						}
					}
					continue;
				}

				//if we end up here then this is an invalid data type
				addPermError(HDB_ERROR_MSGS.STRUCTURE_USER_ROLE_TYPE_ERROR(item), validationErrors);
				continue;
			}

			let schema = object.permission[item];
			//validate that schema exists
			if (!item || !global.hdb_schema[item]) {
				addPermError(HDB_ERROR_MSGS.SCHEMA_NOT_FOUND(item), validationErrors);
				continue;
			}
			if (schema.tables) {
				for (let t in schema.tables) {
					let table = schema.tables[t];
					//validate that table exists in schema
					if (!t || !global.hdb_schema[item][t]) {
						addPermError(HDB_ERROR_MSGS.TABLE_NOT_FOUND(item, t), validationErrors);
						continue;
					}

					//validate all table perm keys are valid
					Object.keys(table).forEach((tableKey) => {
						if (!TABLE_PERM_KEYS.includes(tableKey)) {
							addPermError(HDB_ERROR_MSGS.INVALID_PERM_KEY(tableKey), validationErrors, item, t);
						}
					});

					//validate table CRUD perms
					Object.values(PERMS_CRUD_ENUM).forEach((permKey) => {
						if (!validate.isDefined(table[permKey])) {
							addPermError(HDB_ERROR_MSGS.TABLE_PERM_MISSING(permKey), validationErrors, item, t);
						} else if (!validate.isBoolean(table[permKey])) {
							addPermError(HDB_ERROR_MSGS.TABLE_PERM_NOT_BOOLEAN(permKey), validationErrors, item, t);
						}
					});

					//validate table ATTRIBUTE_PERMISSIONS perm
					if (table.attribute_permissions === undefined) {
						addPermError(HDB_ERROR_MSGS.ATTR_PERMS_ARRAY_MISSING, validationErrors, item, t);
						continue;
					} else if (!(Array.isArray(table.attribute_permissions) || table.attribute_permissions === null)) {
						addPermError(HDB_ERROR_MSGS.ATTR_PERMS_NOT_ARRAY, validationErrors, item, t);
						continue;
					}

					//need this check here to ensure no unexpected errors if key is missing in table perms obj
					if (table.attribute_permissions) {
						let tableAttributeNames = global.hdb_schema[item][t].attributes.map(({ attribute }) => attribute);
						const attrPermsCheck = {
							read: false,
							insert: false,
							update: false,
						};

						for (let r in table.attribute_permissions) {
							let permission = table.attribute_permissions[r];

							Object.keys(permission).forEach((key) => {
								//Leaving this second check for "DELETE" in for now since we've decided to silently
								// allow it to remain in the attr permission object even though we do not use it
								if (!ATTR_PERMS_KEYS.includes(key) && key !== PERMS_CRUD_ENUM.DELETE) {
									addPermError(HDB_ERROR_MSGS.INVALID_ATTR_PERM_KEY(key), validationErrors, item, t);
								}
							});

							//validate that attribute_name is included
							if (!validate.isDefined(permission.attribute_name)) {
								addPermError(HDB_ERROR_MSGS.ATTR_PERM_MISSING_NAME, validationErrors, item, t);
								continue;
							}

							const attrName = permission.attribute_name;
							//validate that attr exists in schema for table
							if (!tableAttributeNames.includes(attrName)) {
								addPermError(HDB_ERROR_MSGS.INVALID_ATTRIBUTE_IN_PERMS(attrName), validationErrors, item, t);
								continue;
							}

							//validate table attribute CRU perms
							ATTR_CRU_KEYS.forEach((permKey) => {
								if (!validate.isDefined(permission[permKey])) {
									addPermError(HDB_ERROR_MSGS.ATTR_PERM_MISSING(permKey, attrName), validationErrors, item, t);
								} else if (!validate.isBoolean(permission[permKey])) {
									addPermError(HDB_ERROR_MSGS.ATTR_PERM_NOT_BOOLEAN(permKey, attrName), validationErrors, item, t);
								}
							});

							//confirm that false table perms are not set to true for an attribute
							if (!attrPermsCheck.read && permission.read === true) {
								attrPermsCheck.read = true;
							}
							if (!attrPermsCheck.insert && permission.insert === true) {
								attrPermsCheck.insert = true;
							}
							if (!attrPermsCheck.update && permission.update === true) {
								attrPermsCheck.update = true;
							}
						}
						//validate that there is no mismatching perms between table and attrs
						if (
							(table.read === false && attrPermsCheck.read === true) ||
							(table.insert === false && attrPermsCheck.insert === true) ||
							(table.update === false && attrPermsCheck.update === true)
						) {
							const schemaName = `${item}.${t}`;
							addPermError(HDB_ERROR_MSGS.MISMATCHED_TABLE_ATTR_PERMS(schemaName), validationErrors, item, t);
						}
					}
				}
			}
		}
	}

	return generateRolePermResponse(validationErrors);
}

module.exports = {
	addRoleValidation,
	alterRoleValidation,
	dropRoleValidation,
};

/**
 * Validates that permissions object for CU or SU roles do not also include permissions
 * @param obj
 * @returns {string|null}
 */
function validateNoSUPerms(obj) {
	const { operation, permission } = obj;
	if (operation === terms.OPERATIONS_ENUM.ADD_ROLE || operation === terms.OPERATIONS_ENUM.ALTER_ROLE) {
		//Check if role type is super user
		const isSuRole = permission.super_user === true;
		const hasPerms = Object.keys(permission).length > 1;
		if (hasPerms && isSuRole) {
			return HDB_ERROR_MSGS.SU_CU_ROLE_NO_PERMS_ALLOWED(terms.ROLE_TYPES_ENUM.SUPER_USER);
		}
	}
	return null;
}

/**
 * Builds final permissions object error response to return if validation fails
 *
 * @param validationErrors
 * @returns {null|HdbError}
 */
function generateRolePermResponse(validationErrors) {
	const { main_permissions, schema_permissions } = validationErrors;
	if (main_permissions.length > 0 || Object.keys(schema_permissions).length > 0) {
		let validationMessage = {
			error: HDB_ERROR_MSGS.ROLE_PERMS_ERROR,
			...validationErrors,
		};

		return handleHDBError(new Error(), validationMessage, HTTP_STATUS_CODES.BAD_REQUEST);
	} else {
		return null;
	}
}

/**
 * Adds perm validation error to the correct category for the final validation error response
 * @param err
 * @param invalidPermsObj
 * @param schema
 * @param table
 */
function addPermError(err, invalidPermsObj, schema, table) {
	if (!schema) {
		invalidPermsObj.main_permissions.push(err);
	} else {
		const schemaKey = table ? schema + '_' + table : schema;
		if (!invalidPermsObj.schema_permissions[schemaKey]) {
			invalidPermsObj.schema_permissions[schemaKey] = [err];
		} else {
			invalidPermsObj.schema_permissions[schemaKey].push(err);
		}
	}
}
