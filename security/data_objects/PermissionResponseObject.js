'use strict';

const PermissionTableResponseObject = require('./PermissionTableResponseObject');
const PermissionAttributeResponseObject = require('./PermissionAttributeResponseObject');
const { HDB_ERROR_MSGS } = require('../../utility/errors/commonErrors');

/**
 * This object organizes permission checks into a cohesive response object that will be returned to
 * the user in the case of a failed permissions check.
 */
class PermissionResponseObject {
	constructor() {
		this.error = HDB_ERROR_MSGS.OP_AUTH_PERMS_ERROR;
		this.unauthorized_access = {};
		this.invalid_schema_items = [];
	}

	/**
	 * This method sets the passed error message to the unauthorized_access array and returns the perms response object
	 * to be returned to the API - i.e. operation requires SU role so response is sent back immediately with that error message
	 * @param err_msg
	 * @returns { PermissionResponseObject }
	 */
	handleUnauthorizedItem(err_msg) {
		this.invalid_schema_items = [];
		this.unauthorized_access = [err_msg];
		return this;
	}

	/**
	 * This method sets the passed error message to the invalid_schema_items array and returns the perms response object
	 * to be returned to the API - i.e. operation on schema that user does not have access to or doesn't exist so response
	 * is sent back immediately with that error message
	 * @param err_msg
	 * @returns { PermissionResponseObject }
	 */
	handleInvalidItem(err_msg) {
		this.invalid_schema_items = [err_msg];
		this.unauthorized_access = [];
		return this;
	}

	/**
	 * This method is used to add an invalid schema item message to the invalid_schema_items array if there is not an
	 * unauthorized_access value already tracked for the table - this ensures that we are not providing schema meta-data
	 * to the user that they should not have
	 * @param item - error string to add to array
	 * @param schema - schema that the item is a part of
	 * @param table - table that the item is a part of
	 */
	addInvalidItem(item, schema, table) {
		if (schema && table) {
			const schema_table = `${schema}_${table}`;
			if (this.unauthorized_access[schema_table]) {
				return;
			}
		}
		this.invalid_schema_items.push(item);
	}

	/**
	 * This method is used to add an unauthorized table object to the unauthorized_access array
	 * @param schema - schema that table is under
	 * @param table - table name that user does not have correct perms on
	 * @param required_perms - permission/s that user does not have on the table to complete the operation
	 */
	addUnauthorizedTable(schema, table, required_table_perms) {
		const failed_table = new PermissionTableResponseObject(schema, table, required_table_perms);

		const schema_table = `${schema}_${table}`;
		this.unauthorized_access[schema_table] = failed_table;
	}

	/**
	 * This method is used to add unauthorized table attribute objects to a new or, if already tracked, an existing table
	 * object tracked in the unauthorized_access array
	 * @param attr_keys - attribute names that are restricted
	 * @param schema - schema of table where attr restrictions exist
	 * @param table - table where attr restrictions exist
	 * @param restricted_attrs - the perms restrictions for each attr
	 */
	addUnauthorizedAttributes(attr_keys, schema, table, restricted_attrs) {
		const unauthorized_table_attributes = [];
		attr_keys.forEach((attr) => {
			const attribute_object = new PermissionAttributeResponseObject(attr, restricted_attrs[attr]);
			unauthorized_table_attributes.push(attribute_object);
		});

		const schema_table = `${schema}_${table}`;

		if (this.unauthorized_access[schema_table]) {
			this.unauthorized_access[schema_table].required_attribute_permissions = unauthorized_table_attributes;
		} else {
			const failed_perm_object = new PermissionTableResponseObject(schema, table, [], unauthorized_table_attributes);
			this.unauthorized_access[schema_table] = failed_perm_object;
		}
	}

	/**
	 * This method is used to evaluate whether or not there are permissions issues tracked and, if so, returns the response
	 * object and, if not, returns a null value meaning the validation step has passed
	 *
	 * @returns { null| PermissionResponseObject }
	 */
	getPermsResponse() {
		const unauthorized_access_arr = Object.values(this.unauthorized_access);
		if (unauthorized_access_arr.length > 0 || this.invalid_schema_items.length > 0) {
			this.unauthorized_access = unauthorized_access_arr;
			return this;
		}
		return null;
	}
}

module.exports = PermissionResponseObject;
