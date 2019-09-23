'use strict';

const hdb_utils = require('../../../../utility/common_utils');
const helium_utils = require('../../../../utility/helium/heliumUtils');
const log = require('../../../../utility/logging/harper_logger');
let hdb_helium = helium_utils.initializeHelium();

module.exports = heDeleteRecords;

let DELETE_OBJ_TEST = {
    operation: "delete",
    table: "doggo",
    schema: "deleteTest",
    hash_values: [
        8,
        9
    ],
    records: [
        {
            age: 5,
            breed: "Mutt",
            id: 8,
            name: "Harper"
        },
        {
            age: 5,
            breed: "Mutt",
            id: 9,
            name: "Penny"
        }
    ]
};

function heDeleteRecords(delete_obj) {
        let hash_attribute = global.hdb_schema[delete_obj.schema][delete_obj.table].hash_attribute;
        if (hdb_utils.isEmpty(hash_attribute)) {
            log.error(`could not retrieve hash attribute for schema:${delete_obj.schema} and table ${delete_obj.table}`);
            throw new Error(`hash attribute not found`);
        }

        try {

        } catch(err) {
            throw err;
        }
}

function buildHeliumDeleteParam(delete_obj) {

}