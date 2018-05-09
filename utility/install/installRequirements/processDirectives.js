"use strict"
/**
 * These classes define the data types used to define the necessary items for an upgrade.
 */

const hdb_util = require('../../common_utils');
const log = require('../../logging/harper_logger');
const {promisify} = require('util');
const os = require('os');
const fs = require('fs');
const path = require('path');
const PropertiesReader = require('properties-reader');
const upgrade_directive = require('./UpgradeDirective');
const env_variable = require('./EnvironmentVariable');
const dirTest = require('./directives/1-1-0.js');
const hdb_utils = require('../../common_utils');

// Promisified functions
const p_fs_writeFile = promisify(fs.writeFile);
const p_fs_readdir = promisify(fs.readdir);

module.exports = {
    readDirectiveFiles: readDirectiveFiles,
    listFoundDirectives: listFoundDirectives,
    writeEnvVariables: writeEnvVariables,
    processDirectives: processDirectives
};

let loaded_directives = [];
let comments = [];
let hdb_properties = undefined;
let hdb_boot_properties = PropertiesReader(`${process.cwd()}/../hdb_boot_properties.file`);
hdb_properties = PropertiesReader(hdb_boot_properties.get('settings_path'));

// These are stored to make unit testing easier
let hdb_base = undefined;
let settings_file_path = undefined;

try {
    hdb_base = hdb_properties.get("HDB_ROOT");
    settings_file_path = hdb_boot_properties.get('settings_path')
} catch(e) {
    log.info("Could not set hdb_base and settings_file_path" + e);
}

async function processDirectives(curr_version, upgrade_version) {
    if(hdb_util.isEmptyOrZeroLength(loaded_directives)) {
        console.error(`No directive files found.  Exiting.`);
        log.error(`No directive files found.  Exiting.`);
        process.exit(1);
    }
    let upgrade_directives = getVersionsToInstall(curr_version);
    for(let vers of upgrade_directives) {
        // Create Directories
        let directories_to_create = vers.relative_directory_paths;
        await createDirectories(directories_to_create);
        // Update Environment variables
        updateEnvironmentVariable(vers.environment_variables);
        // Run Functions
        runFunctions(vers.functions);
    }
    await writeEnvVariables();
}

async function createDirectories(directive_paths) {
    if(hdb_util.isEmptyOrZeroLength(directive_paths)) {
        log.info('No upgrade directories to create.');
        return;
    }
    for(let dir_path of directive_paths) {
        makeDirectory(path.join(hdb_base, dir_path));
    }
}

async function updateEnvironmentVariable(directive_variables) {
    for(let dir_var of directive_variables) {
        if(hdb_properties.get(dir_var.name) === null) {
            // our current props file doesn't have this var, add it
            hdb_properties.set(dir_var.name, dir_var.value);
        }
        if(!hdb_util.isEmptyOrZeroLength(dir_var.comments)) {
            comments[dir_var.name] = dir_var.comments;
        }
    }
}

// TODO: The functions data member may need to be a map with a function as a key and
// arguments as the value.  For now, don't allow values passed into functions.
async function runFunctions(directive_functions) {
    for(let func of directive_functions) {
        await func();
    }
}

async function writeEnvVariables() {
    try {
        p_fs_writeFile(settings_file_path, stringifyProps(hdb_properties, comments));
    } catch (e) {
        console.error('There was a problem writing the settings file.  Please check the install log for details.');
        log.error(e);
    }

    // reload written props
    try {
        hdb_properties = PropertiesReader(hdb_boot_properties.get('settings_path'));
    } catch (e) {
        log.trace(`there was a problem reloading new properties file.`)
    }
}

function stringifyProps(prop_reader_object, comments) {
    let lines = [];
    let section = null;
    prop_reader_object.each(function (key, value) {
        let tokens = key.split('.');
        if (tokens.length > 1) {
            if (section !== tokens[0]) {
                section = tokens[0];
                lines.push('[' + section + ']');
            }
            key = tokens.slice(1).join('.');
        } else {
            section = null;
        }
        if(comments[key] !== null) {
            let curr_comments = comments[key];
            for(let comm of curr_comments) {
                lines.push(';' + comm + os.EOL);
            }
        }
        lines.push(key + '=' + value);
    });
    return lines;
}

async function writeDirectory(var_rel_path) {

}

//TODO: Should probably make this async, but not a huge priority since this only is called during an upgrade.
function makeDirectory(targetDir, {isRelativeToScript = false} = {}) {
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

function listFoundDirectives() {
    return loaded_directives;
}

async function readDirectiveFiles(base_path) {
    const directive_path = path.join(base_path, 'utility', 'install', 'installRequirements', 'directives');
    let files = undefined;
    try {
        files = await p_fs_readdir(directive_path);
    } catch(e) {
        log.fatal(`not able to read upgrade directive files path ${directive_path}`);
    }
    if(!files) {
        console.error(`No directive files found in path: ${directive_path}`);
        log.fatal(`No directive files found in path: ${directive_path}`);
        throw new Error(`No directive files found in path: ${directive_path}`);
    }
    for(let i = 0; i<files.length; i++) {
        try {
            let directive = require(`${directive_path}/${files[i]}`);
            loaded_directives.push(directive);
            log.trace(`loaded directive ${files[i]}`);
        } catch (e) {
            log.fatal(`could not load file ${files[i]}`);
        }
    }
    return loaded_directives;
}

function getVersionsToInstall(curr_version_num) {
    if(hdb_util.isEmptyOrZeroLength(curr_version_num)) {
        return [];
    }
    if(hdb_util.isEmptyOrZeroLength(loaded_directives)) {
        return [];
    }
    let versions_modules_to_run = [];
    versions_modules_to_run = loaded_directives.sort(compareVersions).filter( function(curr_version) {
        return curr_version.version > curr_version_num;
    });
    return versions_modules_to_run;
}

/**
 * Get old_version list of version directives to run during an upgrade.  Can be used via [<versions>].sort(compareVersions)
 * @param old_version
 * @param new_version_number
 * @returns {*}
 */
function compareVersions (old_version, new_version_number) {
    let i, diff;
    let regExStrip0 = /(\.0+)+$/;
    let segmentsA = old_version.version.replace(regExStrip0, '').split('.');
    let segmentsB = new_version_number.version.replace(regExStrip0, '').split('.');
    let l = Math.min(segmentsA.length, segmentsB.length);

    for (i = 0; i < l; i++) {
        diff = parseInt(segmentsA[i], 10) - parseInt(segmentsB[i], 10);
        if (diff) {
            return diff;
        }
    }
    return segmentsA.length - segmentsB.length;
}
