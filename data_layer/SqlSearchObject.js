"use strict";

class SqlSearchObject {
    constructor(sql_command, user) {
        this.operation = "sql";
        this.sql = sql_command;
        this.hdb_user = user;
    }
}

module.exports = SqlSearchObject;