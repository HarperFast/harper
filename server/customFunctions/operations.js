'use strict';

const fs = require('fs-extra');
const fg = require('fast-glob');
const path = require('path');

const log = require('../../utility/logging/harper_logger');
const terms = require('../../utility/hdbTerms');
const hdb_utils = require('../../utility/common_utils');
const env = require('../../utility/environment/environmentManager');
const { handleHDBError, hdb_errors } = require('../../utility/errors/hdbError');
const { HDB_ERROR_MSGS, HTTP_STATUS_CODES } = hdb_errors;


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
        throw handleHDBError(new Error(), HDB_ERROR_MSGS.FUNCTION_STATUS, HTTP_STATUS_CODES.INTERNAL_SERVER_ERROR, log.ERR, err);
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
        const project_folders = fg.sync(`${dir}/*`, { onlyDirectories: true });

        project_folders.forEach((project_folder) => {
            const folderName = project_folder.split('/').pop();
            response[folderName] = {
                routes: fg.sync(`${project_folder}/routes/*.js`).map((filepath) => filepath.split('/').pop().split('.js')[0]),
                helpers: fg.sync(`${project_folder}/helpers/*.js`).map((filepath) => filepath.split('/').pop().split('.js')[0]),
            };
        });
    } catch (err) {
        throw handleHDBError(new Error(), HDB_ERROR_MSGS.GET_FUNCTIONS, HTTP_STATUS_CODES.INTERNAL_SERVER_ERROR, log.ERR, err);
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
    if (hdb_utils.isEmpty(req.project)) {
        throw handleHDBError(new Error(), HDB_ERROR_MSGS.MISSING_VALUE('project'), HTTP_STATUS_CODES.BAD_REQUEST);
    }

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
        throw handleHDBError(new Error(), HDB_ERROR_MSGS.GET_FUNCTION, HTTP_STATUS_CODES.INTERNAL_SERVER_ERROR, log.ERR, err);
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

    try {
        fs.outputFileSync(`${dir}/${project}/${type}/${file}.js`, function_content);
        return `Successfully updated custom function: ${file}.js`;
    } catch (err) {
        const err_string = `Error setting custom function: ${err}`;
        log.error(err_string);
        throw err_string;
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
        fs.unlinkSync(`${dir}/${project}/${type}/${file}.js`);
        return `Successfully deleted custom function: ${file}.js`;
    } catch (err) {
        const err_string = `Error deleting custom function: ${err}`;
        log.error(err_string);
        throw err_string;
    }
}

/**
 * Create a new project folder in the custom_functions folder and copy the template into it
 *
 * @param {NodeObject} req
 * @returns {string}
 */
async function addCustomFunctionProject(req) {
    log.trace(`adding custom function project`);
    const dir = env.getProperty(terms.HDB_SETTINGS_NAMES.CUSTOM_FUNCTIONS_DIRECTORY_KEY);
    const { project } = req;
    let cwd;

    try {
        cwd = `${dir}/${project}`;
        fs.mkdirSync(cwd, { recursive: true });
        fs.copySync(path.join(__dirname, 'template'), cwd);
        return `Successfully created custom function project: ${project}`;
    } catch (err) {
        const err_string = `Error creating custom function project: ${err}`;
        log.error(err_string);
        throw err_string;
    }
}

/**
 * Remove a project folder from the custom_functions folder
 *
 * @param {NodeObject} req
 * @returns {string}
 */
async function dropCustomFunctionProject(req) {
    log.trace(`dropping custom function project`);
    const dir = env.getProperty(terms.HDB_SETTINGS_NAMES.CUSTOM_FUNCTIONS_DIRECTORY_KEY);
    const { project } = req;

    try {
        fs.rmdirSync(`${dir}/${project}`, { recursive: true });
        return `Successfully deleted project: ${project}`;
    } catch (err) {
        const err_string = `Error creating custom function project: ${err}`;
        log.error(err_string);
        throw err_string;
    }
}

module.exports = {
    customFunctionsStatus,
    getCustomFunctions,
    getCustomFunction,
    setCustomFunction,
    dropCustomFunction,
    addCustomFunctionProject,
    dropCustomFunctionProject,
};
