'use strict';

const fs = require('fs-extra');
const fg = require('fast-glob');
const path = require('path');

const log = require('../../utility/logging/harper_logger');
const terms = require('../../utility/hdbTerms');
const env = require('../../utility/environment/environmentManager');


/**
 * Read the settings.js file and return the
 *
 * @return Object.<String>
 */
async function customFunctionsStatus() {
    log.trace(`getting custom api status`);
    let response = {};

    try {
        response = {
            is_enabled: env.getProperty(terms.HDB_SETTINGS_NAMES.CUSTOM_FUNCTIONS_ENABLED_KEY),
            port: env.getProperty(terms.HDB_SETTINGS_NAMES.CUSTOM_FUNCTIONS_PORT_KEY),
            directory: env.getProperty(terms.HDB_SETTINGS_NAMES.CUSTOM_FUNCTIONS_DIRECTORY_KEY),
        };
    } catch (err) {
        const errString = `Error getting custom function status: ${err}`;
        log.error(errString);
        throw errString;
    }
    return response;
}


/**
 * Read the user-defined custom_functions/routes directory and return the file names
 *
 * @return Array.<String>
 */
async function getCustomFunctions() {
    log.trace(`getting custom api endpoints`);
    let response = {};
    const dir = env.getProperty(terms.HDB_SETTINGS_NAMES.CUSTOM_FUNCTIONS_DIRECTORY_KEY);

    try {
        const projectFolders = fg.sync(`${dir}/*`, { onlyDirectories: true });

        projectFolders.forEach((projectFolder) => {
            const folderName = projectFolder.split('/').pop();
            response[folderName] = {
                routes: fg.sync(`${projectFolder}/routes/*.js`).map((filepath) => filepath.split('/').pop().split('.js')[0]),
                helpers: fg.sync(`${projectFolder}/helpers/*.js`).map((filepath) => filepath.split('/').pop().split('.js')[0]),
            };
        });
    } catch (err) {
        const errString = `Error getting custom functions: ${err}`;
        log.error(errString);
        throw errString;
    }
    return response;
}


/**
 * Read the specified function_name file in the custom_functions/routes directory and return the file content
 *
 * @param {NodeObject} req
 * @returns {string}
 */
async function getCustomFunction(req) {
    log.trace(`getting custom api endpoint file content`);
    const dir = env.getProperty(terms.HDB_SETTINGS_NAMES.CUSTOM_FUNCTIONS_DIRECTORY_KEY);
    const { project, type, file } = req;
    const fileLocation = `${dir}/${project}/${type}/${file}.js`;

    try {
        if (!fs.existsSync(fileLocation)){
            throw new Error('Could not locate that endpoint file');
        }
        return fs.readFileSync(fileLocation, { encoding:'utf8' });

    } catch (err) {
        const errString = `Error getting custom function: ${err}`;
        log.error(errString);
        throw errString;
    }
}


/**
 * Write the supplied function_content to the provided function_name file in the custom_functions/routes directory
 *
 * @param {NodeObject} req
 * @returns {string}
 */
async function setCustomFunction(req) {
    log.trace(`setting custom function file content`);
    const dir = env.getProperty(terms.HDB_SETTINGS_NAMES.CUSTOM_FUNCTIONS_DIRECTORY_KEY);
    const { project, type, file, function_content } = req;
    let cwd;

    try {
        if (type === 'projects') {
            cwd = `${dir}/${project}`;
            fs.mkdirSync(cwd, { recursive: true });
            fs.copySync(path.join(__dirname, 'template'), cwd);
            return `Successfully created project: ${file}.js`;
        }

        cwd = `${dir}/${project}/${type}/${file}.js`;
        fs.outputFileSync(cwd, function_content);
        return `Successfully updated custom function: ${file}.js`;
    } catch (err) {
        const errString = `Error setting custom function: ${err}`;
        log.error(errString);
        throw errString;
    }
}


/**
 * Delete the provided function_name file from the custom_functions/routes directory
 *
 * @param {NodeObject} req
 * @returns {string}
 */
async function dropCustomFunction(req) {
    log.trace(`setting custom function file content`);
    const dir = env.getProperty(terms.HDB_SETTINGS_NAMES.CUSTOM_FUNCTIONS_DIRECTORY_KEY);
    const { project, type, file } = req;

    try {
        if (type === 'projects') {
            fs.rmdirSync(`${dir}/${project}`, { recursive: true });
            return `Successfully deleted project: ${req.project}`;
        }
        fs.unlinkSync(`${dir}/${project}/${type}/${file}.js`);
        return `Successfully deleted custom function: ${req.file}.js`;
    } catch (err) {
        const errString = `Error deleting custom function: ${err}`;
        log.error(errString);
        throw errString;
    }
}

module.exports = {
    customFunctionsStatus,
    getCustomFunctions,
    getCustomFunction,
    setCustomFunction,
    dropCustomFunction,
};
