"use strict";

const BridgeMethods = require("../BridgeMethods.js");
const log = require('../../../utility/logging/harper_logger');

const fsGetDataByHash = require("./fsMethods/fsGetDataByHash");
const fsCreateRecords = require('./fsMethods/fsCreateRecords');
const fsCreateSchema = require('./fsMethods/fsCreateSchema');
const fsCreateTable = require('./fsMethods/fsCreateTable');
const fsDeleteRecords = require('./fsMethods/fsDeleteRecords');

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
            const search_results = await fsGetDataByHash(search_object);
            return Object.values(search_results);
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

    async createTable(table, table_create_obj) {
        try {
            return await fsCreateTable(table, table_create_obj);
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

    async deleteRecords(delete_obj) {
        try {
            return await fsDeleteRecords(delete_obj);
        } catch(err) {
            log.error(err);
            throw err;
        }
    }
}

module.exports = FileSystemBridge;
