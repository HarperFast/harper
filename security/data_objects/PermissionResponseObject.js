'use strict';

const PermissionTableResponseObject = require('./PermissionTableResponseObject.js');
const PermissionAttributeResponseObject = require('./PermissionAttributeResponseObject.js');
const { HDB_ERROR_MSGS } = require('../../utility/errors/commonErrors.js');

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
	 * This method sets the passed error message to the unauthorizedAccess array and returns the perms response object
	 * to be returned to the API - i.e. operation requires SU role so response is sent back immediately with that error message
	 * @param errMsg
	 * @returns { PermissionResponseObject }
	 */
	handleUnauthorizedItem(errMsg) {
		this.invalid_schema_items = [];
		this.unauthorized_access = [errMsg];
		return this;
	}

	/**
	 * This method sets the passed error message to the invalidSchemaItems array and returns the perms response object
	 * to be returned to the API - i.e. operation on schema that user does not have access to or doesn't exist so response
	 * is sent back immediately with that error message
	 * @param errMsg
	 * @returns { PermissionResponseObject }
	 */
	handleInvalidItem(errMsg) {
		this.invalid_schema_items = [errMsg];
		this.unauthorized_access = [];
		return this;
	}

	/**
	 * This method is used to add an invalid schema item message to the invalidSchemaItems array if there is not an
	 * unauthorizedAccess value already tracked for the table - this ensures that we are not providing schema meta-data
	 * to the user that they should not have
	 * @param item - error string to add to array
	 * @param schema - schema that the item is a part of
	 * @param table - table that the item is a part of
	 */
	addInvalidItem(item, schema, table) {
		if (schema && table) {
			const schemaTable = `${schema}_${table}`;
			if (this.unauthorized_access[schemaTable]) {
				return;
			}
		}
		this.invalid_schema_items.push(item);
	}

	/**
	 * This method is used to add an unauthorized table object to the unauthorizedAccess array
	 * @param schema - schema that table is under
	 * @param table - table name that user does not have correct perms on
	 * @param requiredPerms - permission/s that user does not have on the table to complete the operation
	 */
	addUnauthorizedTable(schema, table, requiredTablePerms) {
		const failedTable = new PermissionTableResponseObject(schema, table, requiredTablePerms);

		const schemaTable = `${schema}_${table}`;
		this.unauthorized_access[schemaTable] = failedTable;
	}

	/**
	 * This method is used to add unauthorized table attribute objects to a new or, if already tracked, an existing table
	 * object tracked in the unauthorizedAccess array
	 * @param attrKeys - attribute names that are restricted
	 * @param schema - schema of table where attr restrictions exist
	 * @param table - table where attr restrictions exist
	 * @param restrictedAttrs - the perms restrictions for each attr
	 */
	addUnauthorizedAttributes(attrKeys, schema, table, restrictedAttrs) {
		const unauthorizedTableAttributes = [];
		attrKeys.forEach((attr) => {
			const attributeObject = new PermissionAttributeResponseObject(attr, restrictedAttrs[attr]);
			unauthorizedTableAttributes.push(attributeObject);
		});

		const schemaTable = `${schema}_${table}`;

		if (this.unauthorized_access[schemaTable]) {
			this.unauthorized_access[schemaTable].required_attribute_permissions = unauthorizedTableAttributes;
		} else {
			const failedPermObject = new PermissionTableResponseObject(schema, table, [], unauthorizedTableAttributes);
			this.unauthorized_access[schemaTable] = failedPermObject;
		}
	}

	/**
	 * This method is used to evaluate whether or not there are permissions issues tracked and, if so, returns the response
	 * object and, if not, returns a null value meaning the validation step has passed
	 *
	 * @returns { null| PermissionResponseObject }
	 */
	getPermsResponse() {
		const unauthorizedAccessArr = Object.values(this.unauthorized_access);
		if (unauthorizedAccessArr.length > 0 || this.invalid_schema_items.length > 0) {
			this.unauthorized_access = unauthorizedAccessArr;
			return this;
		}
		return null;
	}
}

module.exports = PermissionResponseObject;
