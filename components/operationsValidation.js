'use strict';

const Joi = require('joi');
const fs = require('fs-extra');
const path = require('path');
const validator = require('../validation/validationWrapper');
const env_mangr = require('../utility/environment/environmentManager');
const hdb_terms = require('../utility/hdbTerms');
const hdb_logger = require('../utility/logging/harper_logger');
const { hdb_errors } = require('../utility/errors/hdbError');
const { HDB_ERROR_MSGS } = hdb_errors;

// File name can only be alphanumeric, dash and underscores
const PROJECT_FILE_NAME_REGEX = /^[a-zA-Z0-9-_]+$/;

module.exports = {
	getDropCustomFunctionValidator,
	setCustomFunctionValidator,
	addComponentValidator,
	dropCustomFunctionProjectValidator,
	packageComponentValidator,
	deployComponentValidator,
	setComponentFileValidator,
	getComponentFileValidator,
	dropComponentFileValidator,
};

/**
 * Check to see if a project dir exists in the custom functions dir.
 * @param check_exists - determine if validator returns error if exists or vice versa
 * @param project
 * @param helpers
 * @returns {*}
 */
function checkProjectExists(check_exists, project, helpers) {
	try {
		const cf_dir = env_mangr.get(hdb_terms.HDB_SETTINGS_NAMES.CUSTOM_FUNCTIONS_DIRECTORY_KEY);
		const project_dir = path.join(cf_dir, project);

		if (!fs.existsSync(project_dir)) {
			if (check_exists) {
				return helpers.message(HDB_ERROR_MSGS.NO_PROJECT);
			}

			return project;
		}

		if (check_exists) {
			return project;
		}

		return helpers.message(HDB_ERROR_MSGS.PROJECT_EXISTS);
	} catch (err) {
		hdb_logger.error(err);
		return helpers.message(HDB_ERROR_MSGS.VALIDATION_ERR);
	}
}

function checkFilePath(path, helpers) {
	if (path.includes('..')) return helpers.message('Invalid file path');
	return path;
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
		const cf_dir = env_mangr.get(hdb_terms.HDB_SETTINGS_NAMES.CUSTOM_FUNCTIONS_DIRECTORY_KEY);
		const file_path = path.join(cf_dir, project, type, file + '.js');
		if (!fs.existsSync(file_path)) {
			return helpers.message(HDB_ERROR_MSGS.NO_FILE);
		}

		return file;
	} catch (err) {
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
		project: Joi.string()
			.pattern(PROJECT_FILE_NAME_REGEX)
			.custom(checkProjectExists.bind(null, true))
			.required()
			.messages({ 'string.pattern.base': HDB_ERROR_MSGS.BAD_PROJECT_NAME }),
		type: Joi.string().valid('helpers', 'routes').required(),
		file: Joi.string()
			.pattern(PROJECT_FILE_NAME_REGEX)
			.custom(checkFileExists.bind(null, req.project, req.type))
			.custom(checkFilePath)
			.required()
			.messages({ 'string.pattern.base': HDB_ERROR_MSGS.BAD_FILE_NAME }),
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
		project: Joi.string()
			.pattern(PROJECT_FILE_NAME_REGEX)
			.custom(checkProjectExists.bind(null, true))
			.required()
			.messages({ 'string.pattern.base': HDB_ERROR_MSGS.BAD_PROJECT_NAME }),
		type: Joi.string().valid('helpers', 'routes').required(),
		file: Joi.string().custom(checkFilePath).required(),
		function_content: Joi.string().required(),
	});

	return validator.validateBySchema(req, set_func_schema);
}

/**
 * Validate set_component_file requests.
 * @param req
 * @returns {*}
 */
function setComponentFileValidator(req) {
	const set_comp_schema = Joi.object({
		project: Joi.string()
			.pattern(PROJECT_FILE_NAME_REGEX)
			.required()
			.messages({ 'string.pattern.base': HDB_ERROR_MSGS.BAD_PROJECT_NAME }),
		file: Joi.string().custom(checkFilePath).required(),
		payload: Joi.string().optional(),
		encoding: Joi.string().valid('utf8', 'ASCII', 'binary', 'hex', 'base64', 'utf16le', 'latin1', 'ucs2').optional(),
	});

	return validator.validateBySchema(req, set_comp_schema);
}

function dropComponentFileValidator(req) {
	const drop_comp_schema = Joi.object({
		project: Joi.string()
			.pattern(PROJECT_FILE_NAME_REGEX)
			.required()
			.messages({ 'string.pattern.base': HDB_ERROR_MSGS.BAD_PROJECT_NAME }),
		file: Joi.string().custom(checkFilePath).optional(),
	});

	return validator.validateBySchema(req, drop_comp_schema);
}

function getComponentFileValidator(req) {
	const get_comp_schema = Joi.object({
		project: Joi.string().required(),
		file: Joi.string().custom(checkFilePath).required(),
		encoding: Joi.string().valid('utf8', 'ASCII', 'binary', 'hex', 'base64', 'utf16le', 'latin1', 'ucs2').optional(),
	});

	return validator.validateBySchema(req, get_comp_schema);
}

/**
 * Validate addCustomFunctionProject requests.
 * @param req
 * @returns {*}
 */
function addComponentValidator(req) {
	const add_func_schema = Joi.object({
		project: Joi.string()
			.pattern(PROJECT_FILE_NAME_REGEX)
			.custom(checkProjectExists.bind(null, false))
			.required()
			.messages({ 'string.pattern.base': HDB_ERROR_MSGS.BAD_PROJECT_NAME }),
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
		project: Joi.string()
			.pattern(PROJECT_FILE_NAME_REGEX)
			.custom(checkProjectExists.bind(null, true))
			.required()
			.messages({ 'string.pattern.base': HDB_ERROR_MSGS.BAD_PROJECT_NAME }),
	});

	return validator.validateBySchema(req, drop_func_schema);
}

/**
 * Validate packageCustomFunctionProject requests.
 * @param req
 * @returns {*}
 */
function packageComponentValidator(req) {
	const package_proj_schema = Joi.object({
		project: Joi.string()
			.pattern(PROJECT_FILE_NAME_REGEX)
			.required()
			.messages({ 'string.pattern.base': HDB_ERROR_MSGS.BAD_PROJECT_NAME }),
		skip_node_modules: Joi.boolean(),
	});

	return validator.validateBySchema(req, package_proj_schema);
}

/**
 * Validate deployComponent requests.
 * @param req
 * @returns {*}
 */
function deployComponentValidator(req) {
	const deploy_proj_schema = Joi.object({
		project: Joi.string()
			.pattern(PROJECT_FILE_NAME_REGEX)
			.required()
			.messages({ 'string.pattern.base': HDB_ERROR_MSGS.BAD_PROJECT_NAME }),
		payload: Joi.string().optional().messages({ 'string.pattern.base': HDB_ERROR_MSGS.BAD_PACKAGE }),
		package: Joi.string().optional(),
		bypass_config: Joi.boolean().optional(),
	});

	return validator.validateBySchema(req, deploy_proj_schema);
}
