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
const propertiesReader = require('properties-reader');
const upgrade_directive = require('./UpgradeDirective');
const env_variable = require('./EnvironmentVariable');
const dirTest = require('./directives/ver1-1-0.js');

// Promisified functions
const p_fs_writeFile = promisify(fs.writeFile);
const p_fs_readdir = promisify(fs.readdir);

module.exports = {
    readDirectiveFiles: readDirectiveFiles,
    listFoundDirectives: listFoundDirectives,
    writeEnvVariables: writeEnvVariables
};

// Classes are not hoisted, so need to declare them first.




let loaded_directives = [];
let hdb_properties = undefined;
let hdb_boot_properties = PropertiesReader(`${process.cwd()}/../hdb_boot_properties.file`);
hdb_properties = PropertiesReader(hdb_boot_properties.get('settings_path'));

async function processDirectives() {
    if(hdb_util.isEmptyOrZeroLength(loaded_directives)) {
        console.error(`No directive files found.  Exiting.`);
        log.error(`No directive files found.  Exiting.`);
        process.exit(1);
    }
    for(let i = 0; i<loaded_directives.length; i++) {
        let curr_dir_path = loaded_directives[i].relative_directory_paths;
    }
    for(let i = 0; i<loaded_directives.length; i++) {
        let curr_env_var = loaded_directives[i].environment_variables;
    }
}

async function writeEnvVariables(directives) {
    let comments = [];
    for(let dir_var in var_directive) {
        if(hdb_properties.get(dir_var.name) === null) {
            // our current props file doesn't have this var, add it
            hdb_properties.set(dir_var.name, dir_var.value);
        }
        if(!hdb_util.isEmptyOrZeroLength(dir_var.comments)) {
            comments[dir_var.name] = dir_var.comments;
        }
    }

    try {
        p_fs_writeFile(hdb_boot_properties.get('settings_path'), stringifyProps(hdb_properties, comments));
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
            for(let comm in curr_comments) {
                lines.push(';' + comm + os.EOL);
            }
        }
        lines.push(key + '=' + value);
    });
    return lines;
}

async function writeDirectory(var_rel_path) {

}

//TODO:
function makeDirectory(targetDir, {isRelativeToScript = false} = {}) {
    const sep = path.sep;
    const initDir = path.isAbsolute(targetDir) ? sep : '';
    const baseDir = isRelativeToScript ? __dirname : '.';

    targetDir.split(sep).reduce((parentDir, childDir) => {
        const curDir = path.resolve(baseDir, parentDir, childDir);
        try {
            if(curDir && curDir !== '/') {
                fs.mkdirSync(curDir);
                logger.info(`Directory ${curDir} created`);
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
