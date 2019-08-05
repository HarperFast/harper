"use strict";

const create_schema = require('./fsMethods/fsCreateSchema');
const BridgeMethods = require("../BridgeMethods.js");

class FileSystemBridge extends BridgeMethods {

    //add bridge methods here

    async createSchema(schema_create_obj, permissions, hdb_root) {
        return await create_schema.createSchema(schema_create_obj, permissions, hdb_root);
    }

    async createRecords(insert_obj, attributes, schema_table) {
        // This is here due to circular dependencies in insert
        const fs_create_records = require('./fsMethods/fsCreateRecords');

        return await fs_create_records(insert_obj, attributes, schema_table);
    }

}

module.exports = FileSystemBridge;
