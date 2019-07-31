"use strict";
const create_schema = require('./fsMethods/fsCreateSchema');

class FileSystemBridge {

    //add bridge methods here

    createSchema(schema_create_obj, permissions, hdb_root) {
        return create_schema.createSchema(schema_create_obj, permissions, hdb_root);

    }

}

module.exports = FileSystemBridge;