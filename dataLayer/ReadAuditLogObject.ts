'use strict';

import { OPERATIONS_ENUM } from '../utility/hdbTerms.js';

/**
 * class that represents the readAuditLog operation
 */
export default class ReadAuditLogObject {
	operation: string;
	schema: string;
	table: string;
	search_type: string | undefined;
	search_values: (string | number)[] | undefined;
	/**
	 * @param {string} schema
	 * @param {string} table
	 * @param {string} searchType
	 * @param {[string|number]} searchValues
	 */
	constructor(schema: string, table: string, searchType: string | undefined = undefined, searchValues: (string | number)[] | undefined = undefined) {
		this.operation = OPERATIONS_ENUM.READ_AUDIT_LOG;
		this.schema = schema;
		this.table = table;
		this.search_type = searchType;
		this.search_values = searchValues;
	}
}
