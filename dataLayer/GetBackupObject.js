'use strict';

const { OPERATIONS_ENUM } = require('../utility/hdbTerms.ts');

/**
 * class that represents the readAuditLog operation
 */
class GetBackupObject {
	/**
	 * @param {string} schema
	 * @param {string} table
	 * @param {string} searchType
	 * @param {[string|number]} searchValues
	 */
	constructor(schema, table, searchType = undefined, searchValues = undefined) {
		this.operation = OPERATIONS_ENUM.GET_BACKUP;
		this.schema = schema;
		this.table = table;
	}
}

module.exports = GetBackupObject;
