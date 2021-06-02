'use strict';

const fs = require('fs');

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
        log.error(`Got an error getting custom api status ${err}`);
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
    let response = [];
    const dir = env.getProperty(terms.HDB_SETTINGS_NAMES.CUSTOM_FUNCTIONS_DIRECTORY_KEY);
    const routesDir = `${dir}/routes`;

    try {
        fs.readdirSync(routesDir).forEach(file => {
            if (file.endsWith('.js')) {
                response.push(file.replace('.js', ''));
            }
        });

    } catch (err) {
        log.error(`Got an error getting custom api status ${err}`);
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
    const routesDir = `${dir}/routes`;
    let file = `${routesDir}/${req.function_name}.js`;

    try {
        if (!fs.existsSync(file)){
            throw new Error('Could not locate that endpoint file');
        }
        return fs.readFileSync(file, { encoding:'utf8' });

    } catch (err) {
        log.error(`Error getting custom function ${err}`);
        throw err;
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
    const routesDir = `${dir}/routes`;
    let file = `${routesDir}/${req.function_name}.js`;

    try {
        fs.writeFileSync(file, req.function_content);
        return `Successfully updated custom function: ${req.function_name}.js`;
    } catch (err) {
        log.error(`Error setting custom function ${err}`);
        throw err;
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
    const routesDir = `${dir}/routes`;
    let file = `${routesDir}/${req.function_name}.js`;

    try {
        fs.unlinkSync(file);
        return `Successfully deleted custom function: ${req.function_name}.js`;
    } catch (err) {
        log.error(`Error deleting custom function ${err}`);
        throw err;
    }
}

module.exports = {
    customFunctionsStatus,
    getCustomFunctions,
    getCustomFunction,
    setCustomFunction,
    dropCustomFunction,
};
