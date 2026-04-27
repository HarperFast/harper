'use strict';

import { OPERATIONS_ENUM } from '../utility/hdbTerms.js';

/**
 * class that represents the readAuditLog operation
 */
export default class GetBackupObject {
	operation: string;
	schema: string;
	table: string;
	/**
	 * @param {string} schema
	 * @param {string} table
	 * @param {string} _searchType
	 * @param {[string|number]} _searchValues
	 */
	constructor(schema: string, table: string, _searchType: string | undefined = undefined, _searchValues: (string | number)[] | undefined = undefined) {
		this.operation = OPERATIONS_ENUM.GET_BACKUP;
		this.schema = schema;
		this.table = table;
	}
}
