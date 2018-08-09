'use strict';

/**
 * The directive manager serves as an interface between directive files and HDB at large.  Since we don't maintain file
 * structure in the installed version, we need to require all directive files in order to make them accessible.
 *
 * Any time a directive file is added to the project, it must be required in this manager.
 */
const hdb_utils = require('../../utility/common_utils');

// VERSIONS
const version_1_1_0 = require('./1-1-0');
const version_1_2_0 = require('./1-2-0');
const version_1_3_0 = require('./1-3-0');

let versions = new Map();

//TODO:  ALL NEW DIRECTIVES MUST BE ADDED TO VERSIONS
versions.set(version_1_1_0.version, version_1_1_0);
versions.set(version_1_2_0.version, version_1_2_0);
versions.set(version_1_3_0.version, version_1_3_0);

function getSortedVersions() {
    let sorted_keys = [...versions.keys()].sort(hdb_utils.compareVersions);
    return sorted_keys;
}

function filterInvalidVersions(curr_version) {
    if(hdb_utils.isEmptyOrZeroLength(curr_version)) {
        return [];
    }
    if(!versions.has(curr_version)) {
        return [];
    }
    let filtered_keys = [...versions.keys()].sort(hdb_utils.compareVersions).filter( function(this_version) {
        return this_version > curr_version;
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
    getSortedVersions: getSortedVersions,
    getModuleByVersion: getModuleByVersion,
    filterInvalidVersions: filterInvalidVersions
};