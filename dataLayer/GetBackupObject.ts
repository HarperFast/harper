'use strict';

import { OPERATIONS_ENUM } from '../utility/hdbTerms.ts';

/**
 * class that represents the readAuditLog operation
 */
class GetBackupObject {
	[key: string]: any;
	/**
	 * @param {string} schema
	 * @param {string} table
	 * @param {string} _searchType
	 * @param {[string|number]} _searchValues
	 */
	constructor(schema, table, _searchType = undefined, _searchValues = undefined) {
		this.operation = OPERATIONS_ENUM.GET_BACKUP;
		this.schema = schema;
		this.table = table;
	}
}

export default GetBackupObject;
