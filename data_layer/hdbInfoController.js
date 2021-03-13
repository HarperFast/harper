"use strict";

/**
 * Module meant as an intermediary between the hdb_info table and the upgrade/install processes.
 */

const fs = require('fs');
const os = require('os');
const util = require('util');

const insert = require('./insert');
const search = require('./search');
const hdb_terms = require('../utility/hdbTerms');
const BinObjects = require('../bin/BinObjects');
const DataLayerObjects = require('./DataLayerObjects');
const { UpgradeObject } = require('../upgrade/UpgradeObjects');
const version = require('../bin/version');
const log = require('../utility/logging/harper_logger');
const hdb_comm = require('../utility/common_utils');
const { compareVersions } = hdb_comm;
const global_schema = require('../utility/globalSchema');

let p_search_search_by_value = util.promisify(search.searchByValue);
let p_setSchemaDataToGlobal = util.promisify(global_schema.setSchemaDataToGlobal);

const HDB_INFO_SEARCH_ATTRIBUTE = 'info_id';
const SUCCESS = 0;
const FAILURE = 1;

/**
 * Insert a row into hdb_info with the new version.
 * @param new_version_string - The version of this install/upgrade
 * @returns {Promise<void>}
 * @throws
 */
async function updateHdbInstallInfo(new_version_string, old_instance) {
    let info_table_insert_object = undefined;
    let current_version_data = await searchInfo();

    try {
        // always have a 0 in case the search returned nothing.  That way we will have an entry at 1 if there are no rows returned due to table
        // not existing (upgrade from old install).
        let vals = new Map([[0, {}]]);
        for (let i=0; i < current_version_data.length; i++){
            vals.set(current_version_data[i].info_id, current_version_data[i]);

        }
        // get the largest
        let latest_id = Math.max.apply(null, vals.keys());
        const new_id = latest_id + 1;
        const current_info_record = vals.get(latest_id);
        //if there is no info record stored BUT we are installing over an old instance and keeping data, we need to set
        // the data_version value to null so we know to still run the 3.0 upgrade
        const current_data_version = current_info_record && current_info_record.data_version_num ? current_info_record.data_version_num : old_instance ? null : new_version_string;
        info_table_insert_object = new BinObjects.HdbInfoInsertObject(new_id, current_data_version, new_version_string);
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
        hdb_terms.SYSTEM_TABLE_NAMES.INFO_TABLE_NAME,
        hdb_terms.SYSTEM_TABLE_HASH_ATTRIBUTES.INFO_TABLE_ATTRIBUTE,
        [info_table_insert_object]);

    try {
        await p_setSchemaDataToGlobal();
        return insert.insert(insert_object);
    } catch(err) {
        throw err;
    }
}

//TODO - these transactions may not be logged b/c the checkTransactionLogEnvironmentsExist() is run after the update - is that a problem?
/**
 * ADD CODE COMMENTS
 * @param new_version_string
 * @returns {Promise<void>}
 */
async function updateHdbUpgradeInfo(new_version_string) {
    let new_info_record;
    let version_data = await searchInfo();

    try {
        // always have a 0 in case the search returned nothing.  That way we will have an entry at 1 if there are no rows returned due to table
        // not existing (upgrade from old install).
        let vals = new Map([[0, {}]]);
        for (let i=0; i < version_data.length; i++){
            vals.set(version_data[i].info_id, version_data[i]);

        }
        // get the largest
        const latest_id = Math.max.apply(null, [...vals.keys()]);
        // current_info_record = vals.get(latest_id);
        //TODO - do we assume the data version is updated to the most recently inserted hdb version or
        // do we use the value passed and just create a new record?
        // if (current_info_record.hdb_version_num) {
        //     current_info_record.data_version_num = current_info_record.hdb_version_num;
        // } else {
        const new_id = latest_id + 1;
        new_info_record = new BinObjects.HdbInfoInsertObject(new_id, new_version_string, new_version_string);
        // }
    } catch(err) {
        throw err;
    }

    //Insert the most recent record with the new data version in the hdb_info table.
    let insert_object = new DataLayerObjects.InsertObject(hdb_terms.OPERATIONS_ENUM.INSERT,
        hdb_terms.SYSTEM_SCHEMA_NAME,
        hdb_terms.SYSTEM_TABLE_NAMES.INFO_TABLE_NAME,
        // This could be called outside of harperdb where global is not instantiated, so we have to hard code it.
        hdb_terms.SYSTEM_TABLE_HASH_ATTRIBUTES.INFO_TABLE_ATTRIBUTE,
        [new_info_record]);

    try {
        await p_setSchemaDataToGlobal();
        await insert.insert(insert_object);
    } catch(err) {
        throw err;
    }
}

async function searchInfo() {
    // get the latest hdb_info id
    let search_obj = new DataLayerObjects.NoSQLSeachObject(hdb_terms.SYSTEM_SCHEMA_NAME,
        hdb_terms.SYSTEM_TABLE_NAMES.INFO_TABLE_NAME,
        HDB_INFO_SEARCH_ATTRIBUTE,
        hdb_terms.SYSTEM_TABLE_HASH_ATTRIBUTES.INFO_TABLE_ATTRIBUTE,
        ['*'],
        '*'
    );

    // Using a NoSql search and filter to get the largest info_id, as running SQL searches internally is difficult.
    let version_data = [];
    try {
        version_data = await p_search_search_by_value(search_obj);
        // version_data = await lmdbGetDataByValue(search_obj);
    } catch(err) {
        // search may fail during a new install as the table doesn't exist yet (we haven't done an insert).  This is ok,
        // we will assume an id of 0 below.
        log.info(err);
    }
    return version_data;
}

async function getLatestHdbInfoRecord() {
    let version_data = await searchInfo();

    //This scenario means that new software has been downloaded but harperdb install has not been run so
    // we need to run the upgrade for 3.0
    if (version_data.length === 0) {
        return;
    }

    let current_info_record;
    try {
        // always have a 0 in case the search returned nothing.  That way we will have an entry at 1 if there are no rows returned due to table
        // not existing (upgrade from old install).
        let version_map = new Map();
        for (let i=0; i < version_data.length; i++){
            version_map.set(version_data[i].info_id, version_data[i]);
        }
        // get the largest which will be the most recent
        const latest_id = Math.max.apply(null, [...version_map.keys()]);

        current_info_record =  version_map.get(latest_id);
    } catch(err) {
        console.log(err);
    }

    return current_info_record;
}

/**
 * ADD CODE COMMENT
 * @returns {Promise<UpgradeObject>}
 */
async function getVersionUpdateInfo() {
    log.info('Checking if HDB software has been updated');
    try {
        const current_version = version.version();
        const latest_info_record = await getLatestHdbInfoRecord();

        //if no record is returned, it means we have an old instance that needs to be upgraded bc new installs will
        // always result in a record being inserted into the hdb_info table
        if (latest_info_record === undefined) {
            return new UpgradeObject(null, current_version);
        }

        const { data_version_num, hdb_version_num } = latest_info_record;

        if (current_version.toString() === data_version_num.toString()) {
            //TODO - should we also check to make sure the hdb_version_num is the same and, if not, insert new one or
            // is that not even possible?
            //versions are up to date so nothing to do here
            return;
        }

        if (compareVersions(data_version_num.toString(), current_version.toString()) > 0) {
            //TODO - add more handling here - should this exit the process w/ a fail?
            console.error(`You have installed a version lower than version that your data was created on.  This may cause issues and is not supported.  ${hdb_terms.SUPPORT_HELP_MSG}`);
            throw new Error('Trying to downgrade HDB versions is not supported.');
        }

        return new UpgradeObject(data_version_num, current_version);
    } catch(err) {
        log.fatal('Error while trying to evaluate the state of hdb data and the installed hdb version');
        log.fatal(err);
        throw err;
    }
}


module.exports = {
    updateHdbInstallInfo,
    updateHdbUpgradeInfo,
    getVersionUpdateInfo
};
