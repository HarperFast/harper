"use strict";

const BridgeMethods = require("../BridgeMethods.js");
const log = require('../../../utility/logging/harper_logger');
const BridgeMethods = require("../BridgeMethods.js");
const fsCreateAttribute = require('./fsMethods/fsCreateAttribute');
const fsCreateRecords = require('./fsMethods/fsCreateRecords');
const fsCreateSchema = require('./fsMethods/fsCreateSchema');
const fsDeleteRecords = require('./fsMethods/fsDeleteRecords');
const fsGetDataByHash = require('./fsMethods/fsGetDataByHash');
const fsSearchByHash = require('./fsMethods/fsSearchByHash');
const fsGetDataByValue = require('./fsMethods/fsGetDataByValue');
const fsSearchByValue = require('./fsMethods/fsSearchByValue');
const fsSearchByConditions = require('./fsMethods/fsSearchByConditions');
const fsDropSchema = require('./fsMethods/fsDropSchema');
const fsCreateTable = require('./fsMethods/fsCreateTable');
const fsUpdateRecords = require('./fsMethods/fsUpdateRecords');
const fsDeleteRecordsBefore = require('./fsMethods/fsDeleteRecordsBefore');

class FileSystemBridge extends BridgeMethods {

    async getDataByHash(search_object) {
        try {
            return await fsGetDataByHash(search_object);
        } catch (err) {
            log.error(err);
            throw err;
        }
    }

    async searchByHash(search_object) {
        try {
            return await fsSearchByHash(search_object);
        } catch(err) {
            log.error(err);
            throw err;
        }
    }

    async getDataByValue(search_object) {
        try {
            return await fsGetDataByValue(search_object);
        } catch(err) {
            log.error(err);
            throw err;
        }
    }

    async searchByValue(search_object) {
        try {
            return await fsSearchByValue(search_object);
        } catch(err) {
            log.error(err);
            throw err;
        }
    }

    async searchByConditions(search_object) {
        try {
            return await fsSearchByConditions(search_object);
        } catch(err) {
            log.error(err);
            throw err;
        }
    }

    async createSchema(schema_create_obj) {
        try {
            return await fsCreateSchema(schema_create_obj);
        } catch(err) {
            log.error(err);
            throw err;
        }
    }

    async dropSchema(drop_schema_obj) {
        try {
            return await fsDropSchema(drop_schema_obj);
        } catch(err) {
            log.error(err);
            throw err;
        }
    }

    async createTable(table, table_create_obj) {
        try {
            return await fsCreateTable(table, table_create_obj);
        } catch(err) {
            log.error(err);
            throw err;
        }
    }

    async createAttribute(create_attribute_obj) {
        try {
            return await fsCreateAttribute(create_attribute_obj);
        } catch(err) {
            log.error(err);
            throw err;
        }
    }

    async createRecords(insert_obj) {
        try {
            return await fsCreateRecords(insert_obj);
        } catch(err) {
            log.error(err);
            throw err;
        }
    }

    async updateRecords(update_obj) {
        try {
            return await fsUpdateRecords(update_obj);
        } catch(err) {
            log.error(err);
            throw err;
        }
    }

    async deleteRecords(delete_obj) {
        try {
            return await fsDeleteRecords(delete_obj);
        } catch(err) {
            log.error(err);
            throw err;
        }
    }

    async deleteRecordsBefore(delete_obj) {
        try {
            return await fsDeleteRecordsBefore(delete_obj);
        } catch(err) {
            log.error(err);
            throw err;
        }
    }
}

module.exports = FileSystemBridge;
