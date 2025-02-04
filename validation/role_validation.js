const validate = require('validate.js'),
	validator = require('./validationWrapper'),
	terms = require('../utility/hdbTerms'),
	{ handleHDBError, hdb_errors } = require('../utility/errors/hdbError');

const { HDB_ERROR_MSGS, HTTP_STATUS_CODES } = hdb_errors;

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

const ALLOWED_JSON_KEYS = ['operation', 'role', 'id', 'permission', 'hdb_user', 'hdb_auth_header', 'access'];

function customValidate(object, constraints) {
	let validationErrors = {
		main_permissions: [],
		schema_permissions: {},
	};

	const json_msg_keys = Object.keys(object);

	//Check to confirm that keys in JSON body are valid
	const invalid_keys = [];
	for (let i = 0, arr_length = json_msg_keys.length; i < arr_length; i++) {
		if (!ALLOWED_JSON_KEYS.includes(json_msg_keys[i])) {
			invalid_keys.push(json_msg_keys[i]);
		}
	}
	if (invalid_keys.length > 0) {
		addPermError(HDB_ERROR_MSGS.INVALID_ROLE_JSON_KEYS(invalid_keys), validationErrors);
	}

	let validate_result = validator.validateObject(object, constraints);
	if (validate_result) {
		validate_result.message.split(',').forEach((validation_err) => {
			addPermError(validation_err, validationErrors);
		});
	}

	//need this check to avoid unexpected errors if someone doesn't have permissions key included in request
	if (object.permission) {
		//check if role is SU or CU and has perms included
		const su_perms_error = validateNoSUPerms(object);
		if (su_perms_error) {
			addPermError(su_perms_error, validationErrors);
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
				let structure_user_perm = object.permission[item];

				//boolean is valid, move on
				if (typeof structure_user_perm === 'boolean') {
					continue;
				}

				//array is valid check to make sure each entry is actually a schema.
				if (Array.isArray(structure_user_perm)) {
					for (let k = 0, length = structure_user_perm.length; k < length; k++) {
						let schema_perm = structure_user_perm[k];
						if (!global.hdb_schema[schema_perm]) {
							addPermError(HDB_ERROR_MSGS.SCHEMA_NOT_FOUND(schema_perm), validationErrors);
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
					Object.keys(table).forEach((table_key) => {
						if (!TABLE_PERM_KEYS.includes(table_key)) {
							addPermError(HDB_ERROR_MSGS.INVALID_PERM_KEY(table_key), validationErrors, item, t);
						}
					});

					//validate table CRUD perms
					Object.values(PERMS_CRUD_ENUM).forEach((perm_key) => {
						if (!validate.isDefined(table[perm_key])) {
							addPermError(HDB_ERROR_MSGS.TABLE_PERM_MISSING(perm_key), validationErrors, item, t);
						} else if (!validate.isBoolean(table[perm_key])) {
							addPermError(HDB_ERROR_MSGS.TABLE_PERM_NOT_BOOLEAN(perm_key), validationErrors, item, t);
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
						let table_attribute_names = global.hdb_schema[item][t].attributes.map(({ attribute }) => attribute);
						const attr_perms_check = {
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

							const attr_name = permission.attribute_name;
							//validate that attr exists in schema for table
							if (!table_attribute_names.includes(attr_name)) {
								addPermError(HDB_ERROR_MSGS.INVALID_ATTRIBUTE_IN_PERMS(attr_name), validationErrors, item, t);
								continue;
							}

							//validate table attribute CRU perms
							ATTR_CRU_KEYS.forEach((perm_key) => {
								if (!validate.isDefined(permission[perm_key])) {
									addPermError(HDB_ERROR_MSGS.ATTR_PERM_MISSING(perm_key, attr_name), validationErrors, item, t);
								} else if (!validate.isBoolean(permission[perm_key])) {
									addPermError(HDB_ERROR_MSGS.ATTR_PERM_NOT_BOOLEAN(perm_key, attr_name), validationErrors, item, t);
								}
							});

							//confirm that false table perms are not set to true for an attribute
							if (!attr_perms_check.read && permission.read === true) {
								attr_perms_check.read = true;
							}
							if (!attr_perms_check.insert && permission.insert === true) {
								attr_perms_check.insert = true;
							}
							if (!attr_perms_check.update && permission.update === true) {
								attr_perms_check.update = true;
							}
						}
						//validate that there is no mismatching perms between table and attrs
						if (
							(table.read === false && attr_perms_check.read === true) ||
							(table.insert === false && attr_perms_check.insert === true) ||
							(table.update === false && attr_perms_check.update === true)
						) {
							const schema_name = `${item}.${t}`;
							addPermError(HDB_ERROR_MSGS.MISMATCHED_TABLE_ATTR_PERMS(schema_name), validationErrors, item, t);
						}
					}
				}
			}
		}
	}

	return generateRolePermResponse(validationErrors);
}

module.exports = {
	addRoleValidation: addRoleValidation,
	alterRoleValidation: alterRoleValidation,
	dropRoleValidation: dropRoleValidation,
};

/**
 * Validates that permissions object for CU or SU roles do not also include permissions
 * @param obj
 * @returns {string|null}
 */
function validateNoSUPerms(obj) {
	const { operation, permission } = obj;
	if (operation === terms.OPERATIONS_ENUM.ADD_ROLE || operation === terms.OPERATIONS_ENUM.ALTER_ROLE) {
		//Check if role type is super user or cluster user
		const is_su_role = permission.super_user === true;
		const is_cu_role = permission.cluster_user === true;
		const has_perms = Object.keys(permission).length > 1;
		if (has_perms && (is_su_role || is_cu_role)) {
			if (is_cu_role && is_su_role) {
				return HDB_ERROR_MSGS.SU_CU_ROLE_COMBINED_ERROR;
			} else {
				const role_type = permission.super_user ? terms.ROLE_TYPES_ENUM.SUPER_USER : terms.ROLE_TYPES_ENUM.CLUSTER_USER;
				return HDB_ERROR_MSGS.SU_CU_ROLE_NO_PERMS_ALLOWED(role_type);
			}
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
		let validation_message = {
			error: HDB_ERROR_MSGS.ROLE_PERMS_ERROR,
			...validationErrors,
		};

		return handleHDBError(new Error(), validation_message, HTTP_STATUS_CODES.BAD_REQUEST);
	} else {
		return null;
	}
}

/**
 * Adds perm validation error to the correct category for the final validation error response
 * @param err
 * @param invalid_perms_obj
 * @param schema
 * @param table
 */
function addPermError(err, invalid_perms_obj, schema, table) {
	if (!schema) {
		invalid_perms_obj.main_permissions.push(err);
	} else {
		const schema_key = table ? schema + '_' + table : schema;
		if (!invalid_perms_obj.schema_permissions[schema_key]) {
			invalid_perms_obj.schema_permissions[schema_key] = [err];
		} else {
			invalid_perms_obj.schema_permissions[schema_key].push(err);
		}
	}
}
