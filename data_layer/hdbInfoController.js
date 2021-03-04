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

let p_search_search_by_value = util.promisify(search.searchByValue);

const HDB_INFO_SEARCH_ATTRIBUTE = 'info_id';
const SUCCESS = 0;
const FAILURE = 1;

/**
 * Insert a row into hdb_info with the new version.
 * @param new_version_string - The version of this install/upgrade
 * @returns {Promise<void>}
 * @throws
 */
async function updateHdbInstallInfo(new_version_string) {
    let info_table_insert_object = undefined;
    let version_data = await searchInfo();

    try {
        // always have a 0 in case the search returned nothing.  That way we will have an entry at 1 if there are no rows returned due to table
        // not existing (upgrade from old install).
        let vals = new Map([[0, {}]]);
        for (let i=0; i < version_data.length; i++){
            vals.set(version_data[i].info_id, version_data[i]);

        }
        // get the largest
        let latest_id = Math.max.apply(null, vals.keys());
        const new_id = latest_id + 1;
        const current_data_version = vals.get(latest_id).data_version_num;
        const new_data_version = current_data_version ? current_data_version : new_version_string;
        info_table_insert_object = new BinObjects.HdbInfoInsertObject(new_id, new_data_version, new_version_string);
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
        // This could be called outside of harperdb where global is not instantiated, so we have to hard code it.
        hdb_terms.SYSTEM_TABLE_HASH_ATTRIBUTES.INFO_TABLE_ATTRIBUTE,
        [info_table_insert_object]);

    try {
        await insert.insert(insert_object);
    } catch(err) {
        throw err;
    }
}

async function updateHdbUpgradeInfo(new_version_string) {
    let current_info_record;
    let version_data = await searchInfo();

    try {
        // always have a 0 in case the search returned nothing.  That way we will have an entry at 1 if there are no rows returned due to table
        // not existing (upgrade from old install).
        let vals = new Map([[0, {}]]);
        for (let i=0; i < version_data.length; i++){
            vals.set(version_data[i].info_id, version_data[i]);

        }
        // get the largest
        const latest_id = Math.max.apply(null, vals.keys());
        current_info_record = vals.get(latest_id)
        //TODO - do we assume the data version is updated to the most recently inserted hdb version or
        // do we use the value passed and just create a new record?
        current_info_record.data_version_num = current_info_record.hdb_version_num;
    } catch(err) {
        throw err;
    }

    //Update the most recent record with the new data version in the hdb_info table.
    let update_object = new DataLayerObjects.InsertObject(hdb_terms.OPERATIONS_ENUM.UPDATE,
        hdb_terms.SYSTEM_SCHEMA_NAME,
        hdb_terms.SYSTEM_TABLE_NAMES.INFO_TABLE_NAME,
        // This could be called outside of harperdb where global is not instantiated, so we have to hard code it.
        hdb_terms.SYSTEM_TABLE_HASH_ATTRIBUTES.INFO_TABLE_ATTRIBUTE,
        [current_info_record]);

    try {
        await insert.update(update_object);
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
        console.error(err);
        log.info(err);
    }
    return version_data;
}

async function getLatestHdbInfoRecord() {
    let version_data = await searchInfo();
    let current_info_record;

    try {
        // always have a 0 in case the search returned nothing.  That way we will have an entry at 1 if there are no rows returned due to table
        // not existing (upgrade from old install).
        let version_map = new Map();
        for (let i=0; i < version_data.length; i++){
            version_map.set(version_data[i].info_id, version_data[i]);
        }
        // get the largest which will be the most recent
        const latest_id = Math.max.apply(null, version_map.keys());

        current_info_record =  version_map.get(latest_id)
    } catch(err) {
        console.log(err);
    }

    return current_info_record;
}

async function getVersionUpdateJson() {
    log.info('Checking if HDB software has been updated');
    const homedir = os.homedir();
    if(!homedir) {
        throw new Error('Could not determine this users home directory.  Please set your $HOME environment variable')
    }
    // If there is no hdb_boot_props file, then assume this is a new install.
    //TODO - not sure if this is needed in run - probably just look for older version to check if an upgrade is needed
    const boot_props_path = path.join(homedir, hdb_terms.HDB_HOME_DIR_NAME, hdb_terms.BOOT_PROPS_FILE_NAME);
    if (!fs.existsSync(boot_props_path)) {
        console.log(`${boot_props_path} not found.  This seems to be a new install.`);
        console.log(`Finished downloading HarperDB.  Complete the installation by running 'harperdb' if you installed globally.`);
        return;
    }

    const curr_version = version.version();
    const { data_version_num, hdb_version_num } = await getLatestHdbInfoRecord();

    if (curr_version === data_version_num) {
        // versions are up to date so nothing to do here
        return;
    }

    if (curr_version !== hdb_version_num) {
        //TODO - add more handling here - should this exit the process w/ a fail?
        throw new Error('There is an issue w/ versions!')
    }


    if (compareVersions(data_version_num, curr_version) < 0) {
        //TODO - add more handling here - should this exit the process w/ a fail?
        console.error(`You have installed a version lower than version that your data was created on.  This may cause issues.  ${terms.SUPPORT_HELP_MSG}`);
        throw new Error('Trying to downgrade HDB versions is not supported.')
    }

    return new UpgradeObject(data_version_num, curr_version);
}


module.exports = {
    updateHdbInstallInfo,
    updateHdbUpgradeInfo,
    getVersionUpdateJson
};
