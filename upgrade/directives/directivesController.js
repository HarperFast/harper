'use strict';

/**
 * The directive controller serves as an interface between directive files and HDB at large.  Since we don't maintain file
 * structure in the installed version, we need to require all directive files in order to make them accessible.
 *
 * Any time a directive file is added to the project, it must be required in this manager.
 */
const hdb_utils = require('../../utility/common_utils');
const hdb_terms = require('../../utility/hdbTerms');
const hdb_log = require('../../utility/logging/harper_logger');
const { DATA_VERSION, UPGRADE_VERSION } = hdb_terms.UPGRADE_JSON_FIELD_NAMES_ENUM;

// VERSIONS
const version_3_0_0 = require('./3-0-0');

let versions = new Map();

//ALL DIRECTIVES MUST BE ADDED TO VERSIONS
if (version_3_0_0) {
    version_3_0_0.forEach((version) => {
        versions.set(version.version, version);
    });
}

function getSortedVersions() {
    let sorted_keys = [...versions.keys()].sort(hdb_utils.compareVersions);
    return sorted_keys;
}

function getVersionsForUpgrade(upgrade_obj) {
    let curr_version = upgrade_obj[DATA_VERSION];
    let new_version = upgrade_obj[UPGRADE_VERSION];

    if (hdb_utils.isEmptyOrZeroLength(curr_version) || hdb_utils.isEmptyOrZeroLength(new_version)) {
        //we should never get to this scenario but if so, we will return empty array so that server can try to start
        // with current install and data
        hdb_log.info(`Version data is not tracked correctly.  Current version data: ${upgrade_obj}`);
        hdb_log.error('There was an error when trying to evaluate the version information for your instance.  Trying to ' +
            'start the server anyways but it may fail. If you continue to have this problem, please contact support@harperdb.io.');
        return [];
    }

    let filtered_keys = [...versions.keys()].sort(hdb_utils.compareVersions).filter( function(this_version) {
        return this_version > curr_version && this_version <= new_version;
    });
    return filtered_keys;
}

function hasRequiredUpgrades(upgrade_obj) {
    const valid_versions = getVersionsForUpgrade(upgrade_obj);
    return valid_versions.length > 0;
}

function getModuleByVersion(version) {
    if(hdb_utils.isEmptyOrZeroLength(version)) {
        return null;
    }
    if(versions.has(version)) {
        return versions.get(version);
    }
    return null;
}

module.exports = {
    getSortedVersions,
    getModuleByVersion,
    getVersionsForUpgrade,
    hasRequiredUpgrades
};
