"use strict";

const log = require('../../../utility/logging/harper_logger');
const BridgeMethods = require('../BridgeMethods.js');

// const heCreateAttribute = require('./heMethods/heCreateAttribute');
// const heCreateRecords = require('./heMethods/heCreateRecords');
// const heCreateSchema = require('./heMethods/heCreateSchema');
// const heDeleteRecords = require('./heMethods/heDeleteRecords');
const heGetDataByHash = require('./heMethods/heGetDataByHash');
const heSearchByHash = require('./heMethods/heSearchByHash');
const heGetDataByValue = require('./heMethods/heGetDataByValue');
const heSearchByValue = require('./heMethods/heSearchByValue');
// const heSearchByConditions = require('./heMethods/heSearchByConditions');
// const heDropSchema = require('./heMethods/heDropSchema');
// const heCreateTable = require('./heMethods/heCreateTable');
// const heUpdateRecords = require('./heMethods/heUpdateRecords');



class HeliumBridge extends BridgeMethods {

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

    async getDataByValue(search_object) {
        try {
            return await heGetDataByValue(search_object);
        } catch (err) {
            log.error(err);
            throw err;
        }
    }

    async searchByValue(search_object) {
        try {
            return await heSearchByValue(search_object);
        } catch(err) {
            log.error(err);
            throw err;
        }
    }

}

module.exports = new HeliumBridge();