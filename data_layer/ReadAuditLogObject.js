'use strict';

const { OPERATIONS_ENUM } = require('../utility/hdbTerms');

/**
 * class that represents the read_audit_log operation
 */
class ReadAuditLogObject {
	/**
	 * @param {string} schema
	 * @param {string} table
	 * @param {string} search_type
	 * @param {[string|number]} search_values
	 */
	constructor(schema, table, search_type = undefined, search_values = undefined) {
		this.operation = OPERATIONS_ENUM.READ_AUDIT_LOG;
		this.schema = schema;
		this.table = table;
		this.search_type = search_type;
		this.search_values = search_values;
	}
}

module.exports = ReadAuditLogObject;
