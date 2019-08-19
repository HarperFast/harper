"use strict";

/**
 * Module meant as an intermediary between the hdb_info table and the upgrade/install processes.
 */

const insert = require('./insert');
const search = require('./search');
const util = require('util');
const hdb_terms = require('../utility/hdbTerms');
const BinObjects = require('../bin/BinObjects');
const DataLayerObjects = require('./DataLayerObjects');
const log = require('../utility/logging/harper_logger');
const hdb_comm = require('../utility/common_utils');

let p_search_search_by_value = util.promisify(search.searchByValue);

const HDB_INFO_SEARCH_ATTRIBUTE = 'info_id';

/**
 * Insert a row into hdb_info with the new version.
 * @param new_version_string - The version of this install/upgrade
 * @returns {Promise<void>}
 * @throws
 */
async function updateHdbInfo(new_version_string) {
    let info_table_insert_object = undefined;
    let version_data = await searchInfo();

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
        // This could be called outside of harperdb where global is not instantiated, so we have to hard code it.
        hdb_terms.HDB_INTO_TABLE_HASH_ATTRIBUTE,
        [info_table_insert_object]);

    let result = null;
    try {
        result = await insert.insert(insert_object);
    } catch(err) {
        throw err;
    }
}

async function searchInfo() {
    // get the latest hdb_info id
    let search_obj = new DataLayerObjects.NoSQLSeachObject(hdb_terms.SYSTEM_SCHEMA_NAME,
        hdb_terms.HDB_INFO_TABLE_NAME,
        HDB_INFO_SEARCH_ATTRIBUTE,
        hdb_terms.HDB_INTO_TABLE_HASH_ATTRIBUTE,
        ['*'],
        '*'
    );

    // Using a NoSql search and filter to get the largest info_id, as running SQL searches internally is difficult.
    let version_data = [];
    try {
        version_data = await p_search_search_by_value(search_obj);
    } catch(err) {
        // search may fail during a new install as the table doesn't exist yet (we haven't done an insert).  This is ok,
        // we will assume an id of 0 below.
        console.error(err);
        log.info(err);
    }
    return version_data;
}

async function getLatestDataVersion() {
    let versions = await searchInfo();
    let largest_version = undefined;
    let prev_row = undefined;

    for(let i=0;i<versions.length;i++) {
        if(!prev_row) {
            prev_row = versions[i].data_version_num;
            largest_version = versions[i].data_version_num;
            continue;
        }
        if(hdb_comm.compareVersions(versions[i].data_version_num, largest_version) > 0) {
            largest_version = versions[i].data_version_num;
        }
    }
    return largest_version;
}

module.exports = {
    updateHdbInfo,
    getLatestDataVersion,
};