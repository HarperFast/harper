"use strict";

/**
 * Module meant as an intermediary between the hdb_info table and the upgrade/install processes.
 */

const util = require('util');
const colors = require("colors/safe");
const os = require('os');

const insert = require('./insert');
const search = require('./search');
const hdb_terms = require('../utility/hdbTerms');
const BinObjects = require('../bin/BinObjects');
const DataLayerObjects = require('./DataLayerObjects');
const { UpgradeObject } = require('../upgrade/UpgradeObjects');
const version = require('../bin/version');
const log = require('../utility/logging/harper_logger');
const hdb_utils = require('../utility/common_utils');
const global_schema = require('../utility/globalSchema');
const env = require('../utility/environment/environmentManager');
const directiveManager = require('../upgrade/directives/directivesController');

let p_search_search_by_value = util.promisify(search.searchByValue);
let p_setSchemaDataToGlobal = util.promisify(global_schema.setSchemaDataToGlobal);

const HDB_INFO_SEARCH_ATTRIBUTE = 'info_id';

//IMPORTANT - this is the value we use to set a default/stubbed 'data version' number for HDB instances installed before
// version 3.0.0 inorder to allow our version comparison functions to evaluate correctly.  B/c most/all older versions
// will NOT have a hdb_info record from their previous install, we need to stub this data so that the 3.0.0 upgrade
// directives - and any additional upgrade directives that may be added later (if they do not upgrade right away) - are
// identified and run when the upgrade eventually happens.
const DEFAULT_DATA_VERSION_NUM = '2.9.9';

/**
 * Insert a row into hdb_info with the initial version data at install.
 *
 * @param new_version_string - The version of this install
 * @returns {Promise<void>}
 * @throws
 */
async function insertHdbInstallInfo(new_version_string) {
    const info_table_insert_object = new BinObjects.HdbInfoInsertObject(1, new_version_string, new_version_string);

    //Insert the initial version record into the hdb_info table.
    let insert_object = new DataLayerObjects.InsertObject(hdb_terms.OPERATIONS_ENUM.INSERT,
        hdb_terms.SYSTEM_SCHEMA_NAME,
        hdb_terms.SYSTEM_TABLE_NAMES.INFO_TABLE_NAME,
        hdb_terms.SYSTEM_TABLE_HASH_ATTRIBUTES.INFO_TABLE_ATTRIBUTE,
        [info_table_insert_object]);
    await p_setSchemaDataToGlobal();
    return insert.insert(insert_object);
}

//TODO - these transactions may not be logged b/c the checkTransactionLogEnvironmentsExist() is run after the update - is that a problem?
/**
 * This method inserts the new hdb info record after the upgrade process has completed with the new version value for the
 * hdb version and data version.
 *
 * @param new_version_string
 * @returns {Promise<void>}
 */
async function insertHdbUpgradeInfo(new_version_string) {
    let new_info_record;
    let version_data = await searchInfo();

    // always have a 0 in case the search returned nothing.  That way we will have an entry at 1 if there are no rows returned due to table
    // not existing (upgrade from old install).
    let vals = new Map([[0, {}]]);
    for (const vers of version_data) {
        vals.set(vers.info_id, vers);
    }

    // get the largest
    const latest_id = Math.max.apply(null, [...vals.keys()]);
    const new_id = latest_id + 1;
    new_info_record = new BinObjects.HdbInfoInsertObject(new_id, new_version_string, new_version_string);

    //Insert the most recent record with the new data version in the hdb_info table.
    let insert_object = new DataLayerObjects.InsertObject(hdb_terms.OPERATIONS_ENUM.INSERT,
        hdb_terms.SYSTEM_SCHEMA_NAME,
        hdb_terms.SYSTEM_TABLE_NAMES.INFO_TABLE_NAME,
        // This could be called outside of harperdb where global is not instantiated, so we have to hard code it.
        hdb_terms.SYSTEM_TABLE_HASH_ATTRIBUTES.INFO_TABLE_ATTRIBUTE,
        [new_info_record]);

    await p_setSchemaDataToGlobal();
    await insert.insert(insert_object);
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
    } catch(err) {
        // search may fail during a new install as the table doesn't exist yet (we haven't done an insert).  This is ok,
        // we will assume an id of 0 below.
        log.info(err);
    }

    return version_data;
}

/**
 * This method grabs all rows from the hbd_info table and returns the most recent record
 *
 * @returns {Promise<*>} - the most recent record OR undefined (if no records exist in the table)
 */
async function getLatestHdbInfoRecord() {
    let version_data = await searchInfo();

    //This scenario means that new software has been downloaded but harperdb install has not been run so
    // we need to run the upgrade for 3.0
    if (version_data.length === 0) {
        return;
    }

    let current_info_record;
    // always have a 0 in case the search returned nothing.  That way we will have an entry at 1 if there are no rows returned due to table
    // not existing (upgrade from old install).
    let version_map = new Map();
    for (const vers of version_data) {
        version_map.set(vers.info_id, vers);
    }

    // get the largest which will be the most recent
    const latest_id = Math.max.apply(null, [...version_map.keys()]);
    current_info_record =  version_map.get(latest_id);

    return current_info_record;
}

/**
 * This method is used in bin/run.js to evaluate if an upgrade is required for the HDB instance.  If one is needed,
 * the method returns an UpgradeObject w/ the version number of the hdb software/instance and the older version number that
 * the data is on.
 *
 * @returns {Promise<UpgradeObject> || undefined} - returns an UpgradeObject (if an upgrade is required) OR undefined (if not)
 */
async function getVersionUpdateInfo() {
    log.info('Checking if HDB software has been updated');
    try {
        const current_version = version.version();
        const latest_info_record = await getLatestHdbInfoRecord();

        let data_version_num;

        if (!hdb_utils.isEmpty(latest_info_record)) {
            data_version_num = latest_info_record.data_version_num;
            if (hdb_utils.compareVersions(data_version_num.toString(), current_version.toString()) > 0) {
                console.log(colors.yellow(`This instance's data was last run on version ${data_version_num}`));
                console.error(colors.red(`You have installed a version lower than the version that your data was created on or was upgraded to.  This may cause issues and is currently not supported.${os.EOL}${hdb_terms.SUPPORT_HELP_MSG}`));
                throw new Error('Trying to downgrade HDB versions is not supported.');
            }
        }

        //if the current version is below the default version number we are tracking, we do not need to consider any
        // updates for the instance and can just skip the upgrade step
        if (current_version < DEFAULT_DATA_VERSION_NUM) {
            return;
        }

        //if the current_version of the software is over the supported version number, we need to check that the current
        // instance is running on at least the 2.0 release (when we last ran upgrade directives) - if it has not, the
        // upgrade will fail because we are no longer supporting the 2.0 upgrade directive so we need to throw an error
        // to the user and stop this process until they downgrade to their old version OR do a new, fresh install.
        checkIfInstallIsSupported();

        //If no record is returned, it means we have an old instance that needs to be upgraded bc new installs will
        // always result in a record being inserted into the hdb_info table.  When this happens, we use the default data
        // version number value to make sure all upgrades starting at 3.0.0 run and, when that's completed, a new, complete
        // hdb_info record will be inserted
        if (hdb_utils.isEmpty(latest_info_record)) {
            return new UpgradeObject(DEFAULT_DATA_VERSION_NUM, current_version);
        }

        if (current_version.toString() === data_version_num.toString()) {
            //versions are up to date so nothing to do here
            return;
        }

        const newUpgradeObj = new UpgradeObject(data_version_num, current_version);
        //we only want to prompt for a reinstall if there are updates that need to be made.  If there are no new version
        // update directives between the two versions, we can skip by returning undefined
        const upgradeRequired = directiveManager.hasRequiredUpgrades(newUpgradeObj);
        if (upgradeRequired) {
            return newUpgradeObj;
        } else {
            return;
        }
    } catch(err) {
        log.fatal('Error while trying to evaluate the state of hdb data and the installed hdb version');
        log.fatal(err);
        throw err;
    }
}

function checkIfInstallIsSupported() {
    try {
        env.getProperty(hdb_terms.HDB_SETTINGS_NAMES.CLUSTERING_USER_KEY);
    } catch(err) {
        const err_msg = 'You are attempting to upgrade from a very old instance of HDB that is no longer supported. ' +
            'In order to upgrade to this version of HDB, you must do a fresh install. If you need support, ' +
            'please contact support@harperdb.io';
        console.log(err_msg);
        throw new Error(err_msg);
    }
}


module.exports = {
    insertHdbInstallInfo,
    insertHdbUpgradeInfo,
    getVersionUpdateInfo,
    searchInfo
};
