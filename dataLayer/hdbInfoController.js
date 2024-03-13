'use strict';

/**
 * Module meant as an intermediary between the hdb_info table and the upgrade/install processes. Please update
 * MINIMUM_SUPPORTED_VERSION_NUM as needed.
 */

const util = require('util');
const chalk = require('chalk');
const os = require('os');

const insert = require('./insert');
const search = require('./search');
const hdb_terms = require('../utility/hdbTerms');
const BinObjects = require('../bin/BinObjects');
const DataLayerObjects = require('./DataLayerObjects');
const { UpgradeObject } = require('../upgrade/UpgradeObjects');
const { forceDowngradePrompt } = require('../upgrade/upgradePrompt');
const version = require('../bin/version');
const log = require('../utility/logging/harper_logger');
const hdb_utils = require('../utility/common_utils');
const global_schema = require('../utility/globalSchema');
const tableLoader = require('../resources/databases');
const directiveManager = require('../upgrade/directives/directivesController');
let p_setSchemaDataToGlobal = util.promisify(global_schema.setSchemaDataToGlobal);

let p_search_search_by_value = search.searchByValue;

const HDB_INFO_SEARCH_ATTRIBUTE = 'info_id';

// This is the value we use to set a default/stubbed 'data version' number for HDB instances installed before
// version 3.0.0 in order to allow our version comparison functions to evaluate correctly.  B/c most/all older versions
// will NOT have a hdb_info record from their previous install, we need to stub this data so that the 3.0.0 upgrade
// directives - and any additional upgrade directives that may be added later (if they do not upgrade right away) - are
// identified and run when the upgrade eventually happens.
const DEFAULT_DATA_VERSION_NUM = '2.9.9';
// This value should change as supported versions change.
const MINIMUM_SUPPORTED_VERSION_NUM = '3.0.0';

/**
 * * Insert a row into hdb_info with the initial version data at install.
 *
 * @param new_version_string - The version of this install
 * @returns {Promise<{message: string, new_attributes: *, txn_time: *}|undefined>}
 */
async function insertHdbInstallInfo(new_version_string) {
	const info_table_insert_object = new BinObjects.HdbInfoInsertObject(1, new_version_string, new_version_string);

	//Insert the initial version record into the hdb_info table.
	let insert_object = new DataLayerObjects.InsertObject(
		hdb_terms.OPERATIONS_ENUM.INSERT,
		hdb_terms.SYSTEM_SCHEMA_NAME,
		hdb_terms.SYSTEM_TABLE_NAMES.INFO_TABLE_NAME,
		hdb_terms.SYSTEM_TABLE_HASH_ATTRIBUTES.INFO_TABLE_ATTRIBUTE,
		[info_table_insert_object]
	);
	global_schema.setSchemaDataToGlobal();
	return insert.insert(insert_object);
}

/**
 * This method inserts the new 'hdb_info' record after the upgrade process has completed with the new version value for the
 * hdb software version and data version.
 *
 * @param new_version_string
 * @returns {Promise<void>}
 */
async function insertHdbUpgradeInfo(new_version_string) {
	let new_info_record;
	let version_data = await getAllHdbInfoRecords();

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

	//Insert the most recent record with the new data version in the hdb_info system table.
	let insert_object = new DataLayerObjects.InsertObject(
		hdb_terms.OPERATIONS_ENUM.INSERT,
		hdb_terms.SYSTEM_SCHEMA_NAME,
		hdb_terms.SYSTEM_TABLE_NAMES.INFO_TABLE_NAME,
		hdb_terms.SYSTEM_TABLE_HASH_ATTRIBUTES.INFO_TABLE_ATTRIBUTE,
		[new_info_record]
	);

	await p_setSchemaDataToGlobal();
	return insert.insert(insert_object);
}

/**
 * Returns all records from the 'hdb_info' system table
 * @returns {Promise<[]>}
 */
async function getAllHdbInfoRecords() {
	// get the latest hdb_info id
	let search_obj = new DataLayerObjects.NoSQLSeachObject(
		hdb_terms.SYSTEM_SCHEMA_NAME,
		hdb_terms.SYSTEM_TABLE_NAMES.INFO_TABLE_NAME,
		HDB_INFO_SEARCH_ATTRIBUTE,
		hdb_terms.SYSTEM_TABLE_HASH_ATTRIBUTES.INFO_TABLE_ATTRIBUTE,
		['*'],
		'*'
	);

	// Using a NoSql search and filter to get the largest info_id, as running SQL searches internally is difficult.
	let version_data = [];
	try {
		version_data = Array.from(await p_search_search_by_value(search_obj));
	} catch (err) {
		// search may fail during a new install as the table doesn't exist yet or initial upgrade for 3.0.  This is ok,
		// we will assume an id of 0 below.
		console.error(err);
	}

	return version_data;
}

/**
 * This method grabs all rows from the hbd_info table and returns the most recent record
 *
 * @returns {Promise<*>} - the most recent record OR undefined (if no records exist in the table)
 */
async function getLatestHdbInfoRecord() {
	let version_data = await getAllHdbInfoRecords();

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
	current_info_record = version_map.get(latest_id);

	return current_info_record;
}

/**
 * This method is used in bin/run.js to evaluate if an upgrade is required for the HDB instance.  If one is needed,
 * the method returns an UpgradeObject w/ the version number of the hdb software/instance and the older version number that
 * the data is on.
 *
 * @returns {Promise<UpgradeObject> || undefined} - returns an UpgradeObject, if an upgrade is required, OR undefined, if not.
 */
async function getVersionUpdateInfo() {
	log.info('Checking if HDB software has been updated');
	try {
		const upgrade_version = version.version();
		const latest_info_record = await getLatestHdbInfoRecord();

		let data_version;

		if (hdb_utils.isEmpty(latest_info_record)) {
			// If there's no record, then there's no hdb_info table. If there's no hdb_info table, we know it comes before 3.0.0.
			// We assign the default version number to aptly make upgrade decisions
			data_version = DEFAULT_DATA_VERSION_NUM;
		} else {
			data_version = latest_info_record.data_version_num;
			if (hdb_utils.compareVersions(data_version.toString(), upgrade_version.toString()) > 0) {
				if (!hdb_utils.isCompatibleDataVersion(data_version.toString(), upgrade_version.toString())) {
					console.log(chalk.yellow(`This instance's data was last run on version ${data_version}`));
					console.error(
						chalk.red(
							`You have installed a version lower than the version that your data was created on or was upgraded to. This may cause issues and is currently not supported.${os.EOL}${hdb_terms.SUPPORT_HELP_MSG}`
						)
					);
					throw new Error('Trying to downgrade major HDB versions is not supported.');
				}
				if (!hdb_utils.isCompatibleDataVersion(data_version.toString(), upgrade_version.toString(), true)) {
					console.log(chalk.yellow(`This instance's data was last run on version ${data_version}`));

					if (await forceDowngradePrompt(new UpgradeObject(data_version, upgrade_version))) {
						await insertHdbUpgradeInfo(upgrade_version.toString());
					} else {
						console.log('Cancelled downgrade, closing HarperDB');
						process.exit(0);
					}
				}
			}
		}

		global_schema.setSchemaDataToGlobal();
		checkIfInstallIsSupported(data_version);

		if (upgrade_version.toString() === data_version.toString()) {
			//versions are up to date so nothing to do here
			return;
		}

		const newUpgradeObj = new UpgradeObject(data_version, upgrade_version);
		// We only want to prompt for a reinstall if there are updates that need to be made. If there are no new version
		// update directives between the two versions, we can skip by returning undefined
		const upgradeRequired = directiveManager.hasUpgradesRequired(newUpgradeObj);
		if (upgradeRequired) {
			return newUpgradeObj;
		}

		// If we get here they are running on an upgraded version that doesn't require any upgrade directives
		if (
			hdb_utils.compareVersions(newUpgradeObj.data_version.toString(), newUpgradeObj.upgrade_version.toString()) < 0
		) {
			await insertHdbUpgradeInfo(newUpgradeObj.upgrade_version);
			log.notify(`HarperDB running on upgraded version: ${newUpgradeObj.upgrade_version}`);
		}
	} catch (err) {
		log.fatal('Error while trying to evaluate the state of hdb data and the installed hdb version');
		log.fatal(err);
		throw err;
	}
}

/**
 * First we check for the existence of the info table--this rejects too old versions.
 * Next we ensure the version is currently supported against our defined variable, MINIMUM_SUPPORTED_VERSION_NUM
 * @param data_v_num - string of version number
 */
function checkIfInstallIsSupported(data_v_num) {
	const err_msg =
		'You are attempting to upgrade from an old instance of HarperDB that is no longer supported. ' +
		'In order to upgrade to this version, you must do a fresh install. If you need support, ' +
		`please contact ${hdb_terms.HDB_SUPPORT_ADDRESS}`;

	if (!('hdb_info' in tableLoader.databases.system)) {
		console.log(err_msg);
		throw new Error(err_msg);
	}
	if (!hdb_utils.isEmpty(data_v_num) && data_v_num < MINIMUM_SUPPORTED_VERSION_NUM) {
		console.log(err_msg);
		throw new Error(err_msg);
	}
}

module.exports = {
	insertHdbInstallInfo,
	insertHdbUpgradeInfo,
	getVersionUpdateInfo,
};
