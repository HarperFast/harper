'use strict';

/**
 * This class represents the data that is passed into a Sql search.
 */
class SqlSearchObject {
	[key: string]: any;
	constructor(sqlCommand, user) {
		this.operation = 'sql';
		this.sql = sqlCommand;
		this.hdb_user = user;
	}
}

export default SqlSearchObject;
