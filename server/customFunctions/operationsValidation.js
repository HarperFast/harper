'use strict';

const Joi = require('joi');
const fs = require('fs-extra');
const path = require('path');
const validator = require('../../validation/validationWrapper');
const env_mangr = require('../../utility/environment/environmentManager');
const hdb_terms = require('../../utility/hdbTerms');
const hdb_logger = require('../../utility/logging/harper_logger');
const { hdb_errors } = require('../../utility/errors/hdbError');
const { HDB_ERROR_MSGS } = hdb_errors;

// File name can only be alphanumeric and underscores
const PROJECT_FILE_NAME_REGEX = /^\w+$/;

module.exports = {
    getDropCustomFunctionValidator,
    setCustomFunctionValidator,
    addCustomFunctionProjectValidator,
    dropCustomFunctionProjectValidator
};

/**
 * Check to see if a project dir exists in the custom functions dir.
 * @param project
 * @param helpers
 * @returns {*}
 */
function checkProjectExists(project, helpers) {
    try {
        const cf_dir = env_mangr.getProperty(hdb_terms.HDB_SETTINGS_NAMES.CUSTOM_FUNCTIONS_DIRECTORY_KEY);
        const project_dir = path.join(cf_dir, project);
        if (!fs.existsSync(project_dir)) {
            return helpers.message(HDB_ERROR_MSGS.NO_PROJECT);
        }

        return project;
    } catch(err) {
        hdb_logger.error(err);
        return helpers.message(HDB_ERROR_MSGS.VALIDATION_ERR);
    }
}

/**
 * Check the custom functions dir to see if a file exists.
 * @param project
 * @param type
 * @param file
 * @param helpers
 * @returns {*}
 */
function checkFileExists(project, type, file, helpers) {
    try {
        const cf_dir = env_mangr.getProperty(hdb_terms.HDB_SETTINGS_NAMES.CUSTOM_FUNCTIONS_DIRECTORY_KEY);
        const file_path = path.join(cf_dir, project, type, file + '.js');
        if (!fs.existsSync(file_path)) {
            return helpers.message(HDB_ERROR_MSGS.NO_FILE);
        }

        return file;
    } catch(err) {
        hdb_logger.error(err);
        return helpers.message(HDB_ERROR_MSGS.VALIDATION_ERR);
    }
}

/**
 * Used to validate getCustomFunction and dropCustomFunction
 * @param req
 * @returns {*}
 */
function getDropCustomFunctionValidator(req) {
    const get_func_schema = Joi.object({
        project: Joi.string().pattern(PROJECT_FILE_NAME_REGEX).custom(checkProjectExists).required()
            .messages({'string.pattern.base': HDB_ERROR_MSGS.BAD_PROJECT_NAME}),
        type: Joi.string().valid('helpers', 'routes').required(),
        file: Joi.string().pattern(PROJECT_FILE_NAME_REGEX).custom(checkFileExists.bind(null, req.project, req.type)).required()
            .messages({'string.pattern.base': HDB_ERROR_MSGS.BAD_FILE_NAME})
    });

    return validator.validateBySchema(req, get_func_schema);
}

/**
 * Validate setCustomFunction requests.
 * @param req
 * @returns {*}
 */
function setCustomFunctionValidator(req) {
    const set_func_schema = Joi.object({
        project: Joi.string().pattern(PROJECT_FILE_NAME_REGEX).custom(checkProjectExists).required()
            .messages({'string.pattern.base': HDB_ERROR_MSGS.BAD_PROJECT_NAME}),
        type: Joi.string().valid('helpers', 'routes').required(),
        file: Joi.string().pattern(PROJECT_FILE_NAME_REGEX).required()
            .messages({'string.pattern.base': HDB_ERROR_MSGS.BAD_FILE_NAME}),
        function_content: Joi.string().required()
    });

    return validator.validateBySchema(req, set_func_schema);
}

/**
 * Validate addCustomFunctionProject requests.
 * @param req
 * @returns {*}
 */
function addCustomFunctionProjectValidator(req) {
    const add_func_schema = Joi.object({
        project: Joi.string().pattern(PROJECT_FILE_NAME_REGEX).required()
            .messages({'string.pattern.base': HDB_ERROR_MSGS.BAD_PROJECT_NAME}),
    });

    return validator.validateBySchema(req, add_func_schema);
}

/**
 * Validate dropCustomFunctionProject requests.
 * @param req
 * @returns {*}
 */
function dropCustomFunctionProjectValidator(req) {
    const drop_func_schema = Joi.object({
        project: Joi.string().pattern(PROJECT_FILE_NAME_REGEX).custom(checkProjectExists).required()
            .messages({'string.pattern.base': HDB_ERROR_MSGS.BAD_PROJECT_NAME})
    });

    return validator.validateBySchema(req, drop_func_schema);
}