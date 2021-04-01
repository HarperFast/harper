'use strict';

const hdb_util = require('../utility/common_utils');
const log = require('../utility/logging/harper_logger');
const directivesController = require('./directives/directivesController');
const terms = require('../utility/hdbTerms');
const { DATA_VERSION } = terms.UPGRADE_JSON_FIELD_NAMES_ENUM;

module.exports = {
    getDirectiveChangeDescriptions,
    processDirectives
};

/**
 * Create an array containing change descriptor objects.
 *
 * @param upgrade_obj {UpgradeObject}
 * @returns {[]} - Array of change descriptions to display to the user before confirming/starting the upgrade process
 */
function getDirectiveChangeDescriptions(upgrade_obj) {
    let change_descriptions = [];
    let loaded_directives = directivesController.getVersionsForUpgrade(upgrade_obj);
    let upgrade_directives = getUpgradeDirectivesToInstall(loaded_directives);

    for (let vers of upgrade_directives) {
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
    console.log('Starting upgrade process...');

    let loaded_directives = directivesController.getVersionsForUpgrade(upgrade_obj);
    let upgrade_directives = getUpgradeDirectivesToInstall(loaded_directives);

    let all_responses = [];
    for (let vers of upgrade_directives) {
        let notify_msg = `Running upgrade from version ${vers.version}`;
        log.notify(notify_msg);
        console.log(notify_msg);

        let settings_func_response = [];
        let func_responses = [];

        // Run settings file update
        try {
            settings_func_response = runFunctions(vers.settings_file_function);
        } catch(e) {
            log.error(`Error while running a settings upgrade script for ${vers.version}: ` + e);
            throw e;
        }
        for(let i of settings_func_response) {
            log.info(i);
        }

        // Run upgrade functions/scripts
        try {
            func_responses = runFunctions(vers.functions);
        } catch(e) {
            log.error(`Error while running an upgrade script for ${vers.version}: ` + e);
            throw e;
        }

        for(let i of func_responses) {
            log.info(i);
        }

        all_responses.push(...settings_func_response, ...func_responses);
    }

    return all_responses;
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
function getUpgradeDirectivesToInstall(loaded_directives) {
    if(hdb_util.isEmptyOrZeroLength(loaded_directives)) {
        return [];
    }

    let version_modules_to_run = [];
    for(let vers of loaded_directives) {
        let module = directivesController.getModuleByVersion(vers);
        if(module) {
            version_modules_to_run.push(module);
        }
    }
    return version_modules_to_run;
}
