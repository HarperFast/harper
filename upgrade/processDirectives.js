'use strict';

const env = require('../utility/environment/environmentManager');
const hdb_util = require('../utility/common_utils');
const log = require('../utility/logging/harper_logger');
const PropertiesReader = require('properties-reader');
const directive_manager = require('./directives/directiveManager');
const terms = require('../utility/hdbTerms');
const { DATA_VERSION, UPGRADE_VERSION } = terms.UPGRADE_JSON_FIELD_NAMES_ENUM;

module.exports = {
    processDirectives,
    getDirectiveChangeDescriptions
};

let hdb_boot_properties = undefined;
let hdb_properties = undefined;

try {
    // We still use the PropertiesReader here as we need to write out comments during directives.
    hdb_boot_properties = PropertiesReader(env.BOOT_PROPS_FILE_PATH);
    hdb_properties = PropertiesReader(hdb_boot_properties.get('settings_path'));
} catch(e) {
    log.info(`Couldn't read settings files.`);
}

// These are stored to make unit testing easier
let hdb_base = undefined;
let settings_file_path = undefined;

try {
    hdb_base = hdb_properties.get('HDB_ROOT');
    settings_file_path = hdb_boot_properties.get('settings_path');
} catch(e) {
    log.info('Could not set hdb_base and settings_file_path' + e);
}

/**
 * Create an array containing change descriptor objects.
 *
 * @param upgrade_obj {UpgradeObject}
 * @returns {[]} - Array of change descriptions to display to the user before confirming/starting the upgrade process
 */
function getDirectiveChangeDescriptions(upgrade_obj) {
    let change_descriptions = [];
    let loaded_directives = directive_manager.filterInvalidVersions(upgrade_obj);
    let upgrade_directives = getVersionsToInstall(upgrade_obj[DATA_VERSION], loaded_directives);

    for(let vers of upgrade_directives) {
        let new_description = {};
        if (vers.change_description) {
            new_description['change_description'] = vers.change_description;
        }
        if (Object.keys(new_description).length > 0) {
            change_descriptions.push(new_description);
        }
    }

    return change_descriptions;
}

/**
 * Iterates through the directives files to find uninstalled updates and runs the files.
 *
 * @param upgrade_obj {UpgradeObject}
 * @returns {*[]}
 */
function processDirectives(upgrade_obj) {
    let loaded_directives = directive_manager.filterInvalidVersions(upgrade_obj);

    const data_version = upgrade_obj[DATA_VERSION];
    const upgrade_version = upgrade_obj[UPGRADE_VERSION];

    if(hdb_util.isEmptyOrZeroLength(data_version)) {
        log.info(`Invalid value for '${DATA_VERSION}'`);
    }
    if(hdb_util.isEmptyOrZeroLength(upgrade_version)) {
        log.info(`Invalid value for '${UPGRADE_VERSION}'`);
    }
    let upgrade_directives = getVersionsToInstall(data_version, loaded_directives);
    let settings_func_response = [];
    let func_responses = [];
    for (let vers of upgrade_directives) {
        let notify_msg = `Starting upgrade to version ${vers.version}`;
        log.notify(notify_msg);
        console.log(notify_msg);

        // Run settings file update
        try {
            settings_func_response = runFunctions(vers.settings_file_function);
        } catch(e) {
            log.error('running settings func in process Directives' + e);
            throw e;
        }
        for(let i of settings_func_response) {
            log.info(i);
        }

        // Run upgrade functions/scripts
        try {
            func_responses = runFunctions(vers.functions);
        } catch(e) {
            log.error('running func in process Directives' + e);
            throw e;
        }
    }

    for(let i of func_responses) {
        log.info(i);
    }

    return [...settings_func_response, ...func_responses];
}

/**
 * Runs functions specified in a directive object.
 *
 * @param directive_functions - Array of functions to run
 * @returns - Array of responses from function calls
 */
function runFunctions(directive_functions) {
    if(hdb_util.isEmptyOrZeroLength(directive_functions)) {
        log.info('No functions found to run for upgrade');
        return [];
    }
    if(!Array.isArray(directive_functions)) {
        log.info('Passed parameter is not an array');
        return [];
    }
    let func_responses = [];
    for(let func of directive_functions) {
        log.info(`Running function ${func.name}`);
        if(!(func instanceof Function)) {
            log.info('Variable being processed is not a function');
            continue;
        }
        try {
            // All defined functions should be synchronous
            func_responses.push(func());
        } catch(e) {
            log.error(e);
            // Right now assume any functions that need to be run are critical to a successful upgrade, so fail completely
            // if any of them fail.
            throw e;
        }
    }
    return func_responses;
}

/**
 * Based on the current version, find all upgrade directives that need to be installed to make this installation current.
 * Returns the install directives array sorted from lowest to highest version number.
 *
 * @param curr_version_num - The current version of HDB.
 * @returns {Array}
 */
function getVersionsToInstall(curr_version_num, loaded_directives) {
    if(hdb_util.isEmptyOrZeroLength(curr_version_num)) {
        return [];
    }
    if(hdb_util.isEmptyOrZeroLength(loaded_directives)) {
        return [];
    }
    let version_modules_to_run = [];
    for(let vers of loaded_directives) {
        let module = directive_manager.getModuleByVersion(vers);
        if(module) {
            version_modules_to_run.push(module);
        }
    }
    return version_modules_to_run;
}
