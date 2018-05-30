"use strict";

/**
 * This class represents the data that is passed into a Sql search.
 */
class SqlSearchObject {
    constructor(sql_command, user) {
        this.operation = "sql";
        this.sql = sql_command;
        this.hdb_user = user;
    }
}

module.exports = SqlSearchObject;