"use strict";

const log = require('../../../utility/logging/harper_logger');
const BridgeMethods = require("../BridgeMethods.js");
const fsCreateRecords = require('./fsMethods/fsCreateRecords');

class FileSystemBridge extends BridgeMethods {

    //add bridge methods here

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
