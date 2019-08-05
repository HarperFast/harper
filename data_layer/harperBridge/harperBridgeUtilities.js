"use strict";

const util = require('util');
const global_schema = require('../../utility/globalSchema');

const p_get_global_table_schema = util.promisify(global_schema.getTableSchema);

function getGlobalTableSchema(schema_name, table_name) {
    return p_get_global_table_schema(schema_name, table_name);
}

module.exports = {
    getGlobalTableSchema
};