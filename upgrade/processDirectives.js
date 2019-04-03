'use strict';
/**
 * These classes define the data types used to define the necessary items for an upgrade.
 */

const hdb_util = require('../utility/common_utils');
const log = require('../utility/logging/harper_logger');
const os = require('os');
const fs = require('fs');
const path = require('path');
const PropertiesReader = require('properties-reader');
const directive_manager = require('./directives/directiveManager');

module.exports = {
    writeEnvVariables: writeEnvVariables,
    processDirectives: processDirectives
};

let hdb_boot_properties = undefined;
let hdb_properties = undefined;

try {
    hdb_boot_properties = PropertiesReader(`${process.cwd()}/../hdb_boot_properties.file`);
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
 * Iterates through the directives files to find uninstalled updates and runs the files.
 * @param curr_version - The version of HDB at this point.
 * @param upgrade_version - The desired upgrade version
 */
function processDirectives(curr_version, upgrade_version) {
    // Currently we only support upgrading to latest which will be the largest version in the directive manager.  We
    // could support upgrading to a specific version later by allowing the filter function to accept a specific version;
    let loaded_directives = directive_manager.filterInvalidVersions(curr_version);
    if(hdb_util.isEmptyOrZeroLength(loaded_directives)) {
        console.error('No directive files found.  Exiting.');
        log.error('No directive files found.  Exiting.');
        process.exit(1);
    }
    if(hdb_util.isEmptyOrZeroLength(curr_version)) {
        log.info('Invalid value for curr_version');
    }
    if(hdb_util.isEmptyOrZeroLength(upgrade_version)) {
        log.info('Invalid value for curr_version');
    }
    let upgrade_directives = getVersionsToInstall(curr_version, loaded_directives);
    let variable_comments = undefined;
    let func_responses = [];
    for(let vers of upgrade_directives) {
        log.info(`Starting upgrade to version ${vers.version}`);
        // Create Directories
        let directories_to_create = vers.relative_directory_paths;
        try {
            createDirectories(directories_to_create);
        } catch(e) {
            log.error('Error creating directories in process Directives' + e);
            throw e;
        }
        // Update Environment variables
        try {
            variable_comments = updateEnvironmentVariable(vers.environment_variables);
        } catch(e) {
            log.error('Error updating environment variables in process Directives' + e);
            throw e;
        }
        // Run Functions
        try {
            func_responses = runFunctions(vers.functions);
        } catch(e) {
            log.error('running func in process Directives' + e);
            throw e;
        }
    }
    try {
        writeEnvVariables(variable_comments);
    } catch(e) {
        log.error('Error writing environment variables in process Directives' + e);
        throw e;
    }
    for(let i of func_responses) {
        log.info(i);
    }
    return func_responses;
}

/**
 * Creates all directories specified in a directive file.
 * @param directive_paths
 */
function createDirectories(directive_paths) {
    if(hdb_util.isEmptyOrZeroLength(directive_paths)) {
        log.info('No upgrade directories to create.');
        return;
    }
    for(let dir_path of directive_paths) {
        // This is synchronous
        let new_dir_path = path.join(hdb_base, dir_path)
        log.info(`Creating directory ${new_dir_path}`)
        makeDirectory(new_dir_path);
    }
}

/**
 * Update the properties reader object with env variables specified in the directives
 * @param directive_variables - Variables from a directives object
 * @returns array of variable comments in the form comments[key] = [values]
 */
function updateEnvironmentVariable(directive_variables) {
    let comments = [];
    if(hdb_util.isEmptyOrZeroLength(directive_variables)) {
        log.info('No upgrade environment variables were found.');
        return comments;
    }
    for(let dir_var of directive_variables) {
        let found_var = hdb_properties.get(dir_var.name);
        if( found_var === null || dir_var.force_value_update) {
            log.info(`Updating settings variable: ${dir_var.name} to value: ${dir_var.value}`);
            hdb_properties.set(dir_var.name, dir_var.value);
        }
        if(!hdb_util.isEmptyOrZeroLength(dir_var.comments)) {
            comments[dir_var.name] = dir_var.comments;
        }
    }
    return comments;
}

// TODO: The functions data member may need to be a map with a function as a key and
// arguments as the value.  For now, don't allow values passed into functions.
/**
 * Runs the functions specified in a directive object.
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
 * Write the environment variables updated in the
 * @param - comments - Object with key,value describing comments that should be placed above a variable in the settings file.
 * The key is the variable name (PROJECT_DIR) and the value will be the string comment.
 */
function writeEnvVariables(comments) {
    if(hdb_util.isEmptyOrZeroLength(settings_file_path)) {
        let err_msg = 'In process directives, the settings file path is not set';
        log.warn(err_msg);
        throw new Error(err_msg);
    }
    try {
        log.info(`Writing config values to ${settings_file_path}`);
        fs.writeFileSync(settings_file_path, stringifyProps(hdb_properties, comments));
    } catch (e) {
        console.error('There was a problem writing the settings file.  Please check the install log for details.');
        log.error(e);
        throw e;
    }

    // reload written props
    try {
        log.info(`Reloading config values from ${settings_file_path}`);
        hdb_properties = PropertiesReader(hdb_boot_properties.get('settings_path'));
    } catch (e) {
        log.trace('there was a problem reloading new properties file.');
        throw e;
    }
}

/**
 * Takes a PropertiesReader object and converts it to a string so it can be printed to a file.
 * @param prop_reader_object - An object of type properties-reader containing properties stored in settings.js
 * @param comments - Object with key,value describing comments that should be placed above a variable in the settings file.
 * The key is the variable name (PROJECT_DIR) and the value will be the string comment.
 * @returns {string}
 */
function stringifyProps(prop_reader_object, comments) {
    if(hdb_util.isEmpty(prop_reader_object)) {
        log.info('Properties object is null');
        return '';
    }
    let lines = '';
    let section = null;
    prop_reader_object.each(function (key, value) {
        try {
            let tokens = key.split('.');
            if (tokens && tokens.length > 1) {
                if (section !== tokens[0]) {
                    section = tokens[0];
                    lines += ('\t' + section + os.EOL);
                }
                key = tokens.slice(1).join('.');
            } else {
                section = null;
            }
            if (comments && comments[key]) {
                let curr_comments = comments[key];
                for (let comm of curr_comments) {
                    lines += (';' + comm + os.EOL);
                }
            }
            if(!hdb_util.isEmptyOrZeroLength(key) ) {
                lines += key + '=' + value + os.EOL;
            }
        } catch(e) {
            log.error(`Found bad property during upgrade with key ${key} and value: ${value}`);
        }
    });
    return lines;
}

//This is synchronous to ensure everything runs in order.
/**
 * Recursively create directory specified.
 * @param targetDir - Directory to create
 * @param isRelativeToScript - Defaults to false, if true will use curr directory as the base path
 */
function makeDirectory(targetDir, {isRelativeToScript = false} = {}) {
    if(hdb_util.isEmptyOrZeroLength(targetDir)) {
        log.info('Invalid directory path.');
        return;
    }
    const sep = path.sep;
    const initDir = path.isAbsolute(targetDir) ? sep : '';
    const baseDir = isRelativeToScript ? __dirname : '.';

    targetDir.split(sep).reduce((parentDir, childDir) => {
        const curDir = path.resolve(baseDir, parentDir, childDir);
        try {
            if(curDir && curDir !== '/') {
                fs.mkdirSync(curDir);
                log.info(`Directory ${curDir} created`);
            }
        } catch (err) {
            if (err.code !== 'EEXIST') {
                throw err;
            }
        }
        return curDir;
    }, initDir);
}

/**
 * Based on the current version, find all upgrade directives that need to be installed to make this installation current.
 * Returns the install directives array sorted from lowest to highest version number.
 * @param curr_version_num - The current versrion of HDB.
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