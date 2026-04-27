'use strict';

/**
 * This class represents the data that is passed into a Sql search.
 */
export default class SqlSearchObject {
	operation: string;
	sql: string;
	hdb_user: any;
	constructor(sqlCommand: string, user: any) {
		this.operation = 'sql';
		this.sql = sqlCommand;
		this.hdb_user = user;
	}
}
