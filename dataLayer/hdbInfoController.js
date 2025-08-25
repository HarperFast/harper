'use strict';

/**
 * Module meant as an intermediary between the hdbInfo table and the upgrade/install processes. Please update
 * MINIMUM_SUPPORTED_VERSION_NUM as needed.
 */

const util = require('util');
const chalk = require('chalk');
const os = require('os');

const insert = require('./insert.js');
const search = require('./search.js');
const hdbTerms = require('../utility/hdbTerms.ts');
const BinObjects = require('../bin/BinObjects.js');
const DataLayerObjects = require('./DataLayerObjects.js');
const { UpgradeObject } = require('../upgrade/UpgradeObjects.js');
const { forceDowngradePrompt } = require('../upgrade/upgradePrompt.js');
const { packageJson } = require('../utility/packageUtils.js');
const log = require('../utility/logging/harper_logger.js');
const hdbUtils = require('../utility/common_utils.js');
const globalSchema = require('../utility/globalSchema.js');
const tableLoader = require('../resources/databases.ts');
const directiveManager = require('../upgrade/directives/directivesController.js');
let pSetSchemaDataToGlobal = util.promisify(globalSchema.setSchemaDataToGlobal);

let pSearchSearchByValue = search.searchByValue;

const HDB_INFO_SEARCH_ATTRIBUTE = 'info_id';

// This is the value we use to set a default/stubbed 'data version' number for HDB instances installed before
// version 3.0.0 in order to allow our version comparison functions to evaluate correctly.  B/c most/all older versions
// will NOT have a hdbInfo record from their previous install, we need to stub this data so that the 3.0.0 upgrade
// directives - and any additional upgrade directives that may be added later (if they do not upgrade right away) - are
// identified and run when the upgrade eventually happens.
const DEFAULT_DATA_VERSION_NUM = '2.9.9';
// This value should change as supported versions change.
const MINIMUM_SUPPORTED_VERSION_NUM = '3.0.0';

/**
 * * Insert a row into hdbInfo with the initial version data at install.
 *
 * @param newVersionString - The version of this install
 * @returns {Promise<{message: string, new_attributes: *, txn_time: *}|undefined>}
 */
async function insertHdbInstallInfo(newVersionString) {
	const infoTableInsertObject = new BinObjects.HdbInfoInsertObject(1, newVersionString, newVersionString);

	//Insert the initial version record into the hdbInfo table.
	let insertObject = new DataLayerObjects.InsertObject(
		hdbTerms.OPERATIONS_ENUM.INSERT,
		hdbTerms.SYSTEM_SCHEMA_NAME,
		hdbTerms.SYSTEM_TABLE_NAMES.INFO_TABLE_NAME,
		hdbTerms.INFO_TABLE_HASH_ATTRIBUTE,
		[infoTableInsertObject]
	);
	globalSchema.setSchemaDataToGlobal();
	return insert.insert(insertObject);
}

/**
 * This method inserts the new 'hdb_info' record after the upgrade process has completed with the new version value for the
 * hdb software version and data version.
 *
 * @param newVersionString
 * @returns {Promise<void>}
 */
async function insertHdbUpgradeInfo(newVersionString) {
	let newInfoRecord;
	let versionData = await getAllHdbInfoRecords();

	// always have a 0 in case the search returned nothing.  That way we will have an entry at 1 if there are no rows returned due to table
	// not existing (upgrade from old install).
	let vals = new Map([[0, {}]]);
	for (const vers of versionData) {
		vals.set(vers.info_id, vers);
	}

	// get the largest
	const latestId = Math.max.apply(null, [...vals.keys()]);
	const newId = latestId + 1;
	newInfoRecord = new BinObjects.HdbInfoInsertObject(newId, newVersionString, newVersionString);

	//Insert the most recent record with the new data version in the hdbInfo system table.
	let insertObject = new DataLayerObjects.InsertObject(
		hdbTerms.OPERATIONS_ENUM.INSERT,
		hdbTerms.SYSTEM_SCHEMA_NAME,
		hdbTerms.SYSTEM_TABLE_NAMES.INFO_TABLE_NAME,
		hdbTerms.INFO_TABLE_HASH_ATTRIBUTE,
		[newInfoRecord]
	);

	await pSetSchemaDataToGlobal();
	return insert.insert(insertObject);
}

/**
 * Returns all records from the 'hdb_info' system table
 * @returns {Promise<[]>}
 */
async function getAllHdbInfoRecords() {
	// get the latest hdbInfo id
	let searchObj = new DataLayerObjects.NoSQLSeachObject(
		hdbTerms.SYSTEM_SCHEMA_NAME,
		hdbTerms.SYSTEM_TABLE_NAMES.INFO_TABLE_NAME,
		HDB_INFO_SEARCH_ATTRIBUTE,
		hdbTerms.INFO_TABLE_HASH_ATTRIBUTE,
		['*'],
		'*'
	);

	// Using a NoSql search and filter to get the largest infoId, as running SQL searches internally is difficult.
	let versionData = [];
	try {
		versionData = Array.from(await pSearchSearchByValue(searchObj));
	} catch (err) {
		// search may fail during a new install as the table doesn't exist yet or initial upgrade for 3.0.  This is ok,
		// we will assume an id of 0 below.
		console.error(err);
	}

	return versionData;
}

/**
 * This method grabs all rows from the hbdInfo table and returns the most recent record
 *
 * @returns {Promise<*>} - the most recent record OR undefined (if no records exist in the table)
 */
async function getLatestHdbInfoRecord() {
	let versionData = await getAllHdbInfoRecords();

	//This scenario means that new software has been downloaded but harperdb install has not been run so
	// we need to run the upgrade for 3.0
	if (versionData.length === 0) {
		return;
	}

	let currentInfoRecord;
	// always have a 0 in case the search returned nothing.  That way we will have an entry at 1 if there are no rows returned due to table
	// not existing (upgrade from old install).
	let versionMap = new Map();
	for (const vers of versionData) {
		versionMap.set(vers.info_id, vers);
	}

	// get the largest which will be the most recent
	const latestId = Math.max.apply(null, [...versionMap.keys()]);
	currentInfoRecord = versionMap.get(latestId);

	return currentInfoRecord;
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
		const upgradeVersion = packageJson.version;
		if (!upgradeVersion) {
			throw new Error('Could not find the version number in the package.json file');
		}
		const latestInfoRecord = await getLatestHdbInfoRecord();

		let dataVersion;

		if (hdbUtils.isEmpty(latestInfoRecord)) {
			// If there's no record, then there's no hdbInfo table. If there's no hdbInfo table, we know it comes before 3.0.0.
			// We assign the default version number to aptly make upgrade decisions
			dataVersion = DEFAULT_DATA_VERSION_NUM;
		} else {
			dataVersion = latestInfoRecord.data_version_num;
			if (hdbUtils.compareVersions(dataVersion.toString(), upgradeVersion.toString()) > 0) {
				if (!hdbUtils.isCompatibleDataVersion(dataVersion.toString(), upgradeVersion.toString())) {
					console.log(chalk.yellow(`This instance's data was last run on version ${dataVersion}`));
					console.error(
						chalk.red(
							`You have installed a version lower than the version that your data was created on or was upgraded to. This may cause issues and is currently not supported.${os.EOL}${hdbTerms.SUPPORT_HELP_MSG}`
						)
					);
					throw new Error('Trying to downgrade major HDB versions is not supported.');
				}
				if (!hdbUtils.isCompatibleDataVersion(dataVersion.toString(), upgradeVersion.toString(), true)) {
					console.log(chalk.yellow(`This instance's data was last run on version ${dataVersion}`));

					if (await forceDowngradePrompt(new UpgradeObject(dataVersion, upgradeVersion))) {
						await insertHdbUpgradeInfo(upgradeVersion.toString());
					} else {
						console.log('Cancelled downgrade, closing HarperDB');
						process.exit(0);
					}
				}
			}
		}

		globalSchema.setSchemaDataToGlobal();
		checkIfInstallIsSupported(dataVersion);

		if (upgradeVersion.toString() === dataVersion.toString()) {
			//versions are up to date so nothing to do here
			return;
		}

		const newUpgradeObj = new UpgradeObject(dataVersion, upgradeVersion);
		// We only want to prompt for a reinstall if there are updates that need to be made. If there are no new version
		// update directives between the two versions, we can skip by returning undefined
		const upgradeRequired = directiveManager.hasUpgradesRequired(newUpgradeObj);
		if (upgradeRequired) {
			return newUpgradeObj;
		}

		// If we get here they are running on an upgraded version that doesn't require any upgrade directives
		if (
			hdbUtils.compareVersions(newUpgradeObj.data_version.toString(), newUpgradeObj.upgrade_version.toString()) < 0
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
 * @param dataVNum - string of version number
 */
function checkIfInstallIsSupported(dataVNum) {
	const errMsg =
		'You are attempting to upgrade from an old instance of HarperDB that is no longer supported. ' +
		'In order to upgrade to this version, you must do a fresh install. If you need support, ' +
		`please contact ${hdbTerms.HDB_SUPPORT_ADDRESS}`;

	if (!('hdb_info' in tableLoader.databases.system)) {
		console.log(errMsg);
		throw new Error(errMsg);
	}
	if (!hdbUtils.isEmpty(dataVNum) && dataVNum < MINIMUM_SUPPORTED_VERSION_NUM) {
		console.log(errMsg);
		throw new Error(errMsg);
	}
}

module.exports = {
	insertHdbInstallInfo,
	insertHdbUpgradeInfo,
	getVersionUpdateInfo,
};
