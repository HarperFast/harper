'use strict';

const { OPERATIONS_ENUM } = require('../utility/hdbTerms.ts');

/**
 * class that represents the readAuditLog operation
 */
class ReadAuditLogObject {
	/**
	 * @param {string} schema
	 * @param {string} table
	 * @param {string} searchType
	 * @param {[string|number]} searchValues
	 */
	constructor(schema, table, searchType = undefined, searchValues = undefined) {
		this.operation = OPERATIONS_ENUM.READ_AUDIT_LOG;
		this.schema = schema;
		this.table = table;
		this.search_type = searchType;
		this.search_values = searchValues;
	}
}

module.exports = ReadAuditLogObject;
