"use strict";

const log = require('../../../utility/logging/harper_logger');
const BridgeMethods = require("../BridgeMethods.js");
const heCreateRecords = require('./heMethods/heCreateRecords');
const heCreateDatastore = require('./heMethods/heCreateDatastores');

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
}

module.exports = HeliumBridge;