/* eslint-disable require-await */
"use strict";

const log = require('../../../utility/logging/harper_logger');
const BridgeMethods = require("../BridgeMethods.js");
const heCreateRecords = require('./heMethods/heCreateRecords');
const heCreateAttribute = require('./heMethods/heCreateAttribute');
const heCreateSchema = require('./heMethods/heCreateSchema');
const heDeleteRecords = require('./heMethods/heDeleteRecords');
const heGetDataByHash = require('./heMethods/heGetDataByHash');
const heSearchByHash = require('./heMethods/heSearchByHash');
const heGetDataByValue = require('./heMethods/heGetDataByValue');
const heSearchByValue = require('./heMethods/heSearchByValue');
const heSearchByConditions = require('./heMethods/heSearchByConditions');
const heDropTable = require('./heMethods/heDropTable');
const heDropAttribute = require('./heMethods/heDropAttribute');
// const heSearchByConditions = require('./heMethods/heSearchByConditions');
const heDropSchema = require('./heMethods/heDropSchema');
const heCreateTable = require('./heMethods/heCreateTable');
const heUpdateRecords = require('./heMethods/heUpdateRecords');

class HeliumBridge extends BridgeMethods {
    async createSchema(create_schema_obj) {
        try {
            return heCreateSchema(create_schema_obj);
        } catch(err) {
            log.error(err);
            throw err;
        }
    }

    async dropSchema(drop_schema_obj) {
        try {
            return await heDropSchema(drop_schema_obj);
        } catch(err) {
            log.error(err);
            throw err;
        }
    }

    async createTable(table, table_create_obj) {
        try {
            return heCreateTable(table, table_create_obj);
        } catch(err) {
            log.error(err);
            throw err;
        }
    }

    async dropTable(drop_table_obj) {
        try {
            return heDropTable(drop_table_obj);
        } catch(err) {
            log.error(err);
            throw err;
        }
    }

    async createRecords(insert_obj) {
        try {
            return heCreateRecords(insert_obj);
        } catch(err) {
            log.error(err);
            throw err;
        }
    }

    async updateRecords(update_obj) {
        try {
            return heUpdateRecords(update_obj);
        } catch(err) {
            log.error(err);
            throw err;
        }
    }

    async createAttribute(create_attribute_obj) {
        try {
            return heCreateAttribute(create_attribute_obj);
        } catch(err) {
            log.error(err);
            throw err;
        }
    }

    async getDataByHash(search_object) {
        try {
            return heGetDataByHash(search_object);
        } catch (err) {
            log.error(err);
            throw err;
        }
    }

    async searchByHash(search_object) {
        try {
            return heSearchByHash(search_object);
        } catch(err) {
            log.error(err);
            throw err;
        }
    }

    async getDataByValue(search_object) {
        try {
            return heGetDataByValue(search_object);
        } catch (err) {
            log.error(err);
            throw err;
        }
    }

    async searchByValue(search_object) {
        try {
            return heSearchByValue(search_object);
        } catch(err) {
            log.error(err);
            throw err;
        }
    }

    async searchByConditions(search_object) {
        try {
            return await heSearchByConditions(search_object);
        } catch(err) {
            log.error(err);
            throw err;
        }
    }

    async deleteRecords(delete_obj) {
        try {
            return heDeleteRecords(delete_obj);
        } catch(err) {
            log.error(err);
            throw err;
        }
    }

    async dropAttribute(drop_attr_obj) {
        try {
            return heDropAttribute(drop_attr_obj);
        } catch(err) {
            log.error(err);
            throw err;
        }
    }
}

module.exports = HeliumBridge;