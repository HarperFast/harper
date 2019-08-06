"use strict";

const fs_create_schema = require('./fsMethods/fsCreateSchema');
const log = require('../../../utility/logging/harper_logger');
const BridgeMethods = require("../BridgeMethods.js");
const fsCreateRecords = require('./fsMethods/fsCreateRecords');

class FileSystemBridge extends BridgeMethods {

    //add bridge methods here

    async createSchema(schema_create_obj) {
        try {
            return await fs_create_schema(schema_create_obj);
        } catch(err) {
            log.error(err);
            throw err;
        }
    }

    async createRecords(insert_obj, attributes, schema_table) {
        try {
            return await fs_create_records(insert_obj, attributes, schema_table);
            return await fsCreateRecords(insert_obj, attributes, schema_table);;
        } catch(err) {
            log.error(err);
            throw err;
        }
    }

}

module.exports = FileSystemBridge;
