"use strict";

const BridgeMethods = require("../BridgeMethods.js");
const fs_create_records = require('./fsMethods/fsCreateRecords');


class FileSystemBridge extends BridgeMethods {

    //add bridge methods here

    createRecords(insert_obj, attributes, schema_table) {
        return fs_create_records.createRecords(insert_obj, attributes, schema_table);
    }

}

module.exports = FileSystemBridge;
