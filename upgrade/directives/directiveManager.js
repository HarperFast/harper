'use strict';

/**
 * The directive manager serves as an interface between directive files and HDB at large.  Since we don't maintain file
 * structure in the installed version, we need to require all directive files in order to make them accessible.
 *
 * Any time a directive file is added to the project, it must be required in this manager.
 */
const hdb_utils = require('../../utility/common_utils');

// VERSIONS
const version_1_1 = require('./1-1');
const version_1_2 = require('./1-2');
const version_1_3 = require('./1-3');
const version_2_0 = require('./2-0');

let versions = new Map();

//TODO:  ALL NEW DIRECTIVES MUST BE ADDED TO VERSIONS
if(version_1_1) {
    version_1_1.forEach((version) => {
        versions.set(version.version, version);
    });
}
if(version_1_2) {
    version_1_2.forEach((version) => {
        versions.set(version.version, version);
    });
}
if(version_1_3) {
    version_1_3.forEach((version) => {
        versions.set(version.version, version);
    });
}
if(version_2_0) {
    version_2_0.forEach((version) => {
        versions.set(version.version, version);
    });
}

function getSortedVersions() {
    let sorted_keys = [...versions.keys()].sort(hdb_utils.compareVersions);
    return sorted_keys;
}

function filterInvalidVersions(curr_version, new_version) {
    // TODO - do we still need these checks?
    // if(hdb_utils.isEmptyOrZeroLength(curr_version)) {
    //     return [];
    // }
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
