'use strict';

/**
 * The directive controller serves as an interface between directive files and HDB.  Since we don't maintain file
 * structure in the installed version, we need to require all directive files in order to make them accessible.
 *
 * Any time a directive file is added to the project, it must be required in this manager.
 */
const hdb_utils = require('../../utility/common_utils');
const hdb_terms = require('../../utility/hdbTerms');
const hdb_log = require('../../utility/logging/harper_logger');
const { DATA_VERSION, UPGRADE_VERSION } = hdb_terms.UPGRADE_JSON_FIELD_NAMES_ENUM;

// IMPORT VERSION UPGRADE DIRECTIVES HERE
const version_3_1_0 = require('./3-1-0');
const version_4_0_0 = require('./4-0-0');

let versions = new Map();

//ALL VERSION UPGRADE DIRECTIVES MUST BE IMPORTED TO THIS MODULE AND ADDED TO VERSIONS MAP
if (version_3_1_0) {
	version_3_1_0.forEach((version) => {
		versions.set(version.version, version);
	});
}

if (version_4_0_0) {
	version_4_0_0.forEach((version) => {
		versions.set(version.version, version);
	});
}

if (version_4_0_0) {
	version_4_0_0.forEach((version) => {
		versions.set(version.version, version);
	});
}

/**
 * Returns all HDB versions w/ upgrade directives
 * Note: this does NOT return a list of all versions of HDB
 *
 * @returns {this}
 */
function getSortedVersions() {
	return [...versions.keys()].sort(hdb_utils.compareVersions);
}

/**
 * Returns an array of version numbers that include/require an upgrade directive be run - this is basically the ordered list
 * of upgrades that will need to be run for the HDB instance to be able to run on the currently installed software version
 *
 * @param upgrade_obj
 * @returns {any[]|*[]}
 */
function getVersionsForUpgrade(upgrade_obj) {
	let curr_version = upgrade_obj[DATA_VERSION];
	let new_version = upgrade_obj[UPGRADE_VERSION];

	if (hdb_utils.isEmptyOrZeroLength(curr_version) || hdb_utils.isEmptyOrZeroLength(new_version)) {
		//we should never get to this scenario but if so, we will return empty array so that server can try to start
		// with current install and data
		hdb_log.info(
			`There is an issue with the version data in your instance of HDB.  Current version data: ${upgrade_obj}`
		);
		hdb_log.error(
			'There was an error when trying to evaluate the version information for your instance.  Trying to ' +
				'start the server anyways but it may fail. If you continue to have this problem, please contact support@harperdb.io.'
		);
		return [];
	}

	return [...versions.keys()].sort(hdb_utils.compareVersions).filter(function (this_version) {
		return (
			hdb_utils.compareVersions(this_version, curr_version) > 0 &&
			hdb_utils.compareVersions(this_version, new_version) <= 0
		);
	});
}

/**
 * Helper function for determining if there are version upgrades required based on the current status of the data and hdb software
 * versions.  If there are not, it will return false.
 *
 * @param upgrade_obj
 * @returns {boolean} - returns true if an upgrade/s is/are required
 */
function hasUpgradesRequired(upgrade_obj) {
	const valid_versions = getVersionsForUpgrade(upgrade_obj);
	return valid_versions.length > 0;
}

/**
 * Returns the upgrade directive object for a specific version, if present.
 *
 * @param version
 * @returns {null|any}
 */
function getDirectiveByVersion(version) {
	if (hdb_utils.isEmptyOrZeroLength(version)) {
		return null;
	}
	if (versions.has(version)) {
		return versions.get(version);
	}
	return null;
}

module.exports = {
	getSortedVersions,
	getDirectiveByVersion,
	getVersionsForUpgrade,
	hasUpgradesRequired,
};
