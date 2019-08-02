"use strict";
const create_schema = require('./fsMethods/fsCreateSchema');

const BridgeMethods = require("../BridgeMethods.js");
//const fs_create_records = require('./fsMethods/fsCreateRecords');

class FileSystemBridge extends BridgeMethods {

    //add bridge methods here

    createSchema(schema_create_obj, permissions, hdb_root) {
        return create_schema.createSchema(schema_create_obj, permissions, hdb_root);

    }

    async createRecords(insert_obj, attributes, schema_table) {
        const fs_create_records = require('./fsMethods/fsCreateRecords'); // TODO: only works when this is here
        let result = await fs_create_records(insert_obj, attributes, schema_table);
        return result;
    }

}

module.exports = FileSystemBridge;
