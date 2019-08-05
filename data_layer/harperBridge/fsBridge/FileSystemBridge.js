"use strict";

const BridgeMethods = require("../BridgeMethods.js");


class FileSystemBridge extends BridgeMethods {

    //add bridge methods here

    async createRecords(insert_obj, attributes, schema_table) {
        //const fs_create_records = require('./fsMethods/fsCreateRecords');
        let result = await fs_create_records(insert_obj, attributes, schema_table);
        return result;
    }

}

const fs_create_records = require('./fsMethods/fsCreateRecords');
module.exports = FileSystemBridge;


