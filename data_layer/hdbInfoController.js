"use strict";

const insert = require('./insert');
const search = require('./search');
const util = require('util');
const hdb_terms = require('../utility/hdbTerms');
const BinObjects = require('../bin/BinObjects');
const DataLayerObjects = require('./DataLayerObjects');
const log = require('../utility/logging/harper_logger');

let p_search_search_by_value = util.promisify(search.searchByValue);

/**
 * Insert a row into hdb_info with the new version.
 * @param new_version_string
 * @returns {Promise<void>}
 * @throws
 */
async function updateHdbInfo(new_version_string) {
    // get the latest hdb_info id
    let search_obj = {
        schema: 'system',
        table : 'hdb_info',
        search_attribute : 'info_id',
        hash_attribute : 'id',
        get_attributes: ['info_id'],
        search_value: '*'
    };

    // Using a NoSql search and filter to get the largest info_id, as running SQL searches internally is difficult.
    let version_data = [];
    let info_table_insert_object = undefined;
    try {
        version_data = await p_search_search_by_value(search_obj);
    } catch(err) {
        // search may fail during a new install as the table doesn't exist yet (we haven't done an insert).
        log.info(err);
    }
    try {
        // always have a 0 in case the search returned nothing.  That way we will have an entry at 1 if there are no rows returned due to table
        // not existing (upgrade from old install).
        let vals=[0];
        for(let i=0;i<version_data.length;i++){
            vals.push(version_data[i].info_id);
        }
        // get the largest
        let latest_id = Math.max.apply(null, vals);
        latest_id++;
        info_table_insert_object = new BinObjects.HdbInfoInsertObject(latest_id, new_version_string, new_version_string);
    } catch(err) {
        throw err;
    }

    if(!info_table_insert_object.info_id) {
        // This should never be a thing, but just in case we will set it an unlikely to already exist id
        info_table_insert_object.info_id = 99;
    }

    //Insert the new version into the hdb_info table.
    let insert_object = new DataLayerObjects.InsertObject(hdb_terms.OPERATIONS_ENUM.INSERT,
        hdb_terms.SYSTEM_SCHEMA_NAME,
        hdb_terms.HDB_INFO_TABLE_NAME,
        global.hdb_schema[hdb_terms.SYSTEM_SCHEMA_NAME][hdb_terms.HDB_INFO_TABLE_NAME].hash_attribute,
        [info_table_insert_object]);

    let result = null;
    try {
        result = await insert.insert(insert_object);
    } catch(err) {
        throw err;
    }
}

module.exports = {
    updateHdbInfo: updateHdbInfo
};