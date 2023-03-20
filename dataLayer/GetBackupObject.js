'use strict';

const { OPERATIONS_ENUM } = require('../utility/hdbTerms');

/**
 * class that represents the read_audit_log operation
 */
class GetBackupObject {
	/**
	 * @param {string} schema
	 * @param {string} table
	 * @param {string} search_type
	 * @param {[string|number]} search_values
	 */
	constructor(schema, table, search_type = undefined, search_values = undefined) {
		this.operation = OPERATIONS_ENUM.GET_BACKUP;
		this.schema = schema;
		this.table = table;
	}
}

module.exports = GetBackupObject;
