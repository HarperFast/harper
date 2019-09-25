'use strict';

const heGenerateDataStoreName = require('../heUtility/heGenerateDataStoreName');
const heDeleteRecords = require('./heDeleteRecords');
const heSearchByValue = require('./heSearchByValue');
const helium_utils = require('../../../../utility/helium/heliumUtils');
const hdb_terms = require('../../../../utility/hdbTerms');

let hdb_helium;
try {
    hdb_helium = helium_utils.initializeHelium();
} catch(err) {
    throw err;
}

module.exports = heDropAttribute;

const DROP_ATTR_OBJ_TEST = {
    operation: "drop_attribute",
    schema: "dev",
    table: "dog",
    attribute: "another_attribute"
};

const INSERT_OBJ_TEST = {
    operation: "insert",
    schema: "system",
    table: "hdb_attribute",
    hash_attribute: "id",
    records: [
        {
            "schema": "I am a test",
            "table": "Not really a table",
            "id": 45
        }
    ]
};

function heDropAttribute(drop_attribute_obj) {
    let datastore = [heGenerateDataStoreName(drop_attribute_obj.schema, drop_attribute_obj.table)];

    try {
        let he_response = hdb_helium.deleteDataStores(datastore);
        if (he_response[0][1] !== hdb_terms.HELIUM_RESPONSE_CODES.HE_ERR_OK) {
            throw new Error(he_response[0][1]);
        }

        return dropAttributeFromSystem(drop_attribute_obj);
    } catch(err) {
        throw err;
    }

}

function dropAttributeFromSystem(drop_attribute_obj) {
    let search_obj = {
        schema: 'system',
        table: 'hdb_attribute',
        hash_attribute: 'id',
        search_attribute: 'attribute',
        search_value: drop_attribute_obj.attribute,
        get_attributes: ['id']
    };

    try {
        let attributes = heSearchByValue(search_obj);
        if (!attributes || attributes.length < 1) {
            throw new Error(`Attribute ${drop_attribute_obj.attribute} was not found.`);
        }

        let delete_table_obj = {
            table: "hdb_attribute",
            schema: "system",
            hash_attribute: "id",
            hash_values: [attributes[0].id]
        };

        return heDeleteRecords(delete_table_obj);
    } catch(err) {
        throw err;
    }
}