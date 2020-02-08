"use strict";

const log = require('../../../utility/logging/harper_logger');
const BridgeMethods = require("../BridgeMethods");
const lmdbCreateAttribute = require('./lmdbMethods/lmdbCreateAttribute');
const lmdbCreateRecords = require('./lmdbMethods/lmdbCreateRecords');
const lmdbCreateSchema = require('./lmdbMethods/lmdbCreateSchema');
const lmdbDeleteRecords = require('./lmdbMethods/lmdbDeleteRecords');
const lmdbGetDataByHash = require('./lmdbMethods/lmdbGetDataByHash');
const lmdbSearchByHash = require('./lmdbMethods/lmdbSearchByHash');
const lmdbGetDataByValue = require('./lmdbMethods/lmdbGetDataByValue');
const lmdbSearchByValue = require('./lmdbMethods/lmdbSearchByValue');
const lmdbDropSchema = require('./lmdbMethods/lmdbDropSchema');
const lmdbCreateTable = require('./lmdbMethods/lmdbCreateTable');
const lmdbUpdateRecords = require('./lmdbMethods/lmdbUpdateRecords');
const lmdbDeleteRecordsBefore = require('./lmdbMethods/lmdbDeleteRecordsBefore');
const lmdbDropTable = require('./lmdbMethods/lmdbDropTable');
const lmdbDropAttribute = require('./lmdbMethods/lmdbDropAttribute');

class LMDBBridge extends BridgeMethods {

    async getDataByHash(search_object) {

    }

    async searchByHash(search_object) {

    }

    async getDataByValue(search_object, comparator) {

    }

    async searchByValue(search_object) {

    }

    async createSchema(schema_create_obj) {

    }

    async dropSchema(drop_schema_obj) {

    }

    async createTable(table, table_create_obj) {

    }

    async dropTable(drop_table_obj) {

    }

    async createAttribute(create_attribute_obj) {

    }

    async createRecords(insert_obj) {

    }

    async updateRecords(update_obj) {

    }

    async deleteRecords(delete_obj) {

    }

    async deleteRecordsBefore(delete_obj) {

    }

    async dropAttribute(drop_attr_obj) {

    }
}

module.exports = LMDBBridge;
