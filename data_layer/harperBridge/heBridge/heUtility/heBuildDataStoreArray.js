'use strict';

const hdb_utils = require('../../../../utility/common_utils');
const hdb_terms = require('../../../../utility/hdbTerms');

module.exports = heBuildDataStoreArray;

/**
 * Builds a datastore array using the HDB Helium naming convention
 * [<schema>/<table>/<attribute>]
 * @param attributes
 * @param schema
 * @param table
 * @returns {[]}
 */
function heBuildDataStoreArray(attributes, schema, table) {
    let datastores = [];

    for (let i = 0; i < attributes.length; i++) {
        validateAttribute(attributes[i]);
        datastores.push(`${schema}/${table}/${attributes[i]}`);
    }

    return datastores;
}

/**
 * Validates that attribute is under max size and is not null, undefined or empty.
 * @param attribute
 */
function validateAttribute(attribute) {
    if (Buffer.byteLength(String(attribute)) > hdb_terms.INSERT_MODULE_ENUM.MAX_CHARACTER_SIZE) {
        throw new Error(`transaction aborted due to attribute name ${attribute} being too long. Attribute names cannot be longer than ${hdb_terms.INSERT_MODULE_ENUM.MAX_CHARACTER_SIZE} bytes.`);
    }

    if (hdb_utils.isEmptyOrZeroLength(attribute) || hdb_utils.isEmpty(attribute.trim())) {
        throw new Error('transaction aborted due to record(s) with an attribute name that is null, undefined or empty string');
    }
}