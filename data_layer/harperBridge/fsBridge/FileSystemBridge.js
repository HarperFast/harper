"use strict";

const log = require('../../../utility/logging/harper_logger');
const BridgeMethods = require("../BridgeMethods.js");
const fsCreateRecords = require('./fsMethods/fsCreateRecords');
const fsCreateSchema = require('./fsMethods/fsCreateSchema');

class FileSystemBridge extends BridgeMethods {

    async createSchema(schema_create_obj) {
        try {
            return await fsCreateSchema(schema_create_obj);
        } catch(err) {
            log.error(err);
            throw err;
        }
    }

    async createRecords(insert_obj, attributes, schema_table) {
        try {
            return await fsCreateRecords(insert_obj, attributes, schema_table);
        } catch(err) {
            log.error(err);
            throw err;
        }
    }

}

module.exports = FileSystemBridge;
