'use strict';

/**
 * The directive manager serves as an interface between directive files and HDB at large.  Since we don't maintain file
 * structure in the installed version, we need to require all directive files in order to make them accessible.
 *
 * Any time a directive file is added to the project, it must be required in this manager.
 */
const hdb_utils = require('../../utility/common_utils');
const hdb_terms = require('../../utility/hdbTerms');
const { DATA_VERSION, UPGRADE_VERSION } = hdb_terms.UPGRADE_JSON_FIELD_NAMES_ENUM;

// VERSIONS
const version_3_0_0 = require('./3-0-0');

let versions = new Map();

//TODO:  ALL NEW DIRECTIVES MUST BE ADDED TO VERSIONS
if (version_3_0_0) {
    version_3_0_0.forEach((version) => {
        versions.set(version.version, version);
    });
}

function getSortedVersions() {
    let sorted_keys = [...versions.keys()].sort(hdb_utils.compareVersions);
    return sorted_keys;
}

function filterInvalidVersions(upgrade_obj) {
    let curr_version = upgrade_obj[DATA_VERSION];
    let new_version = upgrade_obj[UPGRADE_VERSION];

    if (hdb_utils.isEmptyOrZeroLength(curr_version)) {
        return [];
    }
    if(!versions.has(curr_version)) {
        return [];
    }
    if(!versions.has(new_version)) {
        new_version = "99";
    }
    let filtered_keys = [...versions.keys()].sort(hdb_utils.compareVersions).filter( function(this_version) {
        return this_version > curr_version && this_version <= new_version;
    });
    return filtered_keys;
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
    filterInvalidVersions
};
