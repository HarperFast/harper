"use strict";

const log = require('../../../utility/logging/harper_logger');
const BridgeMethods = require("../BridgeMethods.js");
const heCreateRecords = require('./heMethods/heCreateRecords');
const heCreateDatastore = require('./heMethods/heCreateDatastores');
// const heCreateSchema = require('./heMethods/heCreateSchema');
// const heDeleteRecords = require('./heMethods/heDeleteRecords');
const heGetDataByHash = require('./heMethods/heGetDataByHash');
const heSearchByHash = require('./heMethods/heSearchByHash');
// const heGetDataByValue = require('./heMethods/heGetDataByValue');
// const heSearchByValue = require('./heMethods/heSearchByValue');
// const heSearchByConditions = require('./heMethods/heSearchByConditions');
// const heDropSchema = require('./heMethods/heDropSchema');
// const heCreateTable = require('./heMethods/heCreateTable');
// const heUpdateRecords = require('./heMethods/heUpdateRecords');

class HeliumBridge extends BridgeMethods {
    async createRecords(insert_obj) {
        try {
            return heCreateRecords(insert_obj);
        } catch(err) {
            log.error(err);
            throw err;
        }
    }

    async createAttribute(create_attribute_obj) {
        try {
            return heCreateDatastore(create_attribute_obj);
        } catch(err) {
            log.error(err);
            throw err;
        }
    }

    async getDataByHash(search_object) {
        try {
            return await heGetDataByHash(search_object);
        } catch (err) {
            log.error(err);
            throw err;
        }
    }

    async searchByHash(search_object) {
        try {
            return await heSearchByHash(search_object);
        } catch(err) {
            log.error(err);
            throw err;
        }
    }
}

module.exports = HeliumBridge;