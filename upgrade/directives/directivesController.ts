'use strict';;
import * as hdbUtils from '../../utility/common_utils.js';
import * as hdbTerms from '../../utility/hdbTerms.js';
import * as hdbLog from '../../utility/logging/harper_logger.js';
const { DATA_VERSION, UPGRADE_VERSION } = hdbTerms.UPGRADE_JSON_FIELD_NAMES_ENUM;

let versions = new Map();

/**
 * Returns all HDB versions w/ upgrade directives
 * Note: this does NOT return a list of all versions of HDB
 *
 * @returns {this}
 */
function getSortedVersions() {
	return [...versions.keys()].sort(hdbUtils.compareVersions);
}

/**
 * Returns an array of version numbers that include/require an upgrade directive be run - this is basically the ordered list
 * of upgrades that will need to be run for the HDB instance to be able to run on the currently installed software version
 *
 * @param upgradeObj
 * @returns {any[]|*[]}
 */
function getVersionsForUpgrade(upgradeObj) {
	let currVersion = upgradeObj[DATA_VERSION];
	let newVersion = upgradeObj[UPGRADE_VERSION];

	if (hdbUtils.isEmptyOrZeroLength(currVersion) || hdbUtils.isEmptyOrZeroLength(newVersion)) {
		//we should never get to this scenario but if so, we will return empty array so that server can try to start
		// with current install and data
		hdbLog.info(
			`There is an issue with the version data in your instance of HDB.  Current version data: ${upgradeObj}`
		);
		hdbLog.error(
			'There was an error when trying to evaluate the version information for your instance.  Trying to ' +
				'start the server anyways but it may fail. If you continue to have this problem, please contact support@harperdb.io.'
		);
		return [];
	}

	return [...versions.keys()].sort(hdbUtils.compareVersions).filter(function (thisVersion) {
		return (
			hdbUtils.compareVersions(thisVersion, currVersion) > 0 && hdbUtils.compareVersions(thisVersion, newVersion) <= 0
		);
	});
}

/**
 * Helper function for determining if there are version upgrades required based on the current status of the data and hdb software
 * versions.  If there are not, it will return false.
 *
 * @param upgradeObj
 * @returns {boolean} - returns true if an upgrade/s is/are required
 */
function hasUpgradesRequired(upgradeObj) {
	const validVersions = getVersionsForUpgrade(upgradeObj);
	return validVersions.length > 0;
}

/**
 * Returns the upgrade directive object for a specific version, if present.
 *
 * @param version
 * @returns {null|any}
 */
function getDirectiveByVersion(version) {
	if (hdbUtils.isEmptyOrZeroLength(version)) {
		return null;
	}
	if (versions.has(version)) {
		return versions.get(version);
	}
	return null;
}

export {
	getSortedVersions,
	getDirectiveByVersion,
	getVersionsForUpgrade,
	hasUpgradesRequired,
};
