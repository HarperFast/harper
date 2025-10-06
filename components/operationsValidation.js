'use strict';

const Joi = require('joi');
const fs = require('fs-extra');
const path = require('path');
const validator = require('../validation/validationWrapper.js');
const envMangr = require('../utility/environment/environmentManager.js');
const hdbTerms = require('../utility/hdbTerms.ts');
const hdbLogger = require('../utility/logging/harper_logger.js');
const { hdbErrors } = require('../utility/errors/hdbError.js');
const { HDB_ERROR_MSGS } = hdbErrors;

// File name can only be alphanumeric, dash and underscores
const PROJECT_FILE_NAME_REGEX = /^[a-zA-Z0-9-_]+$/;

// SSH key name can only be alphanumeric, dash and underscores
const SSH_KEY_NAME_REGEX = /^[a-zA-Z0-9-_]+$/;

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
	addSSHKeyValidator,
	updateSSHKeyValidator,
	deleteSSHKeyValidator,
	setSSHKnownHostsValidator,
};

/**
 * Check to see if a project dir exists in the custom functions dir.
 * @param checkExists - determine if validator returns error if exists or vice versa
 * @param project
 * @param helpers
 * @returns {*}
 */
function checkProjectExists(checkExists, project, helpers) {
	try {
		const cfDir = envMangr.get(hdbTerms.CONFIG_PARAMS.COMPONENTSROOT);
		const projectDir = path.join(cfDir, project);

		if (!fs.existsSync(projectDir)) {
			if (checkExists) {
				return helpers.message(HDB_ERROR_MSGS.NO_PROJECT);
			}

			return project;
		}

		if (checkExists) {
			return project;
		}

		return helpers.message(HDB_ERROR_MSGS.PROJECT_EXISTS);
	} catch (err) {
		hdbLogger.error(err);
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
		const cfDir = envMangr.get(hdbTerms.CONFIG_PARAMS.COMPONENTSROOT);
		const filePath = path.join(cfDir, project, type, file + '.js');
		if (!fs.existsSync(filePath)) {
			return helpers.message(HDB_ERROR_MSGS.NO_FILE);
		}

		return file;
	} catch (err) {
		hdbLogger.error(err);
		return helpers.message(HDB_ERROR_MSGS.VALIDATION_ERR);
	}
}

/**
 * Used to validate getCustomFunction and dropCustomFunction
 * @param req
 * @returns {*}
 */
function getDropCustomFunctionValidator(req) {
	const getFuncSchema = Joi.object({
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

	return validator.validateBySchema(req, getFuncSchema);
}

/**
 * Validate setCustomFunction requests.
 * @param req
 * @returns {*}
 */
function setCustomFunctionValidator(req) {
	const setFuncSchema = Joi.object({
		project: Joi.string()
			.pattern(PROJECT_FILE_NAME_REGEX)
			.custom(checkProjectExists.bind(null, true))
			.required()
			.messages({ 'string.pattern.base': HDB_ERROR_MSGS.BAD_PROJECT_NAME }),
		type: Joi.string().valid('helpers', 'routes').required(),
		file: Joi.string().custom(checkFilePath).required(),
		function_content: Joi.string().required(),
	});

	return validator.validateBySchema(req, setFuncSchema);
}

/**
 * Validate set_component_file requests.
 * @param req
 * @returns {*}
 */
function setComponentFileValidator(req) {
	const setCompSchema = Joi.object({
		project: Joi.string()
			.pattern(PROJECT_FILE_NAME_REGEX)
			.required()
			.messages({ 'string.pattern.base': HDB_ERROR_MSGS.BAD_PROJECT_NAME }),
		file: Joi.string().custom(checkFilePath).required(),
		payload: Joi.string().allow('').optional(),
		encoding: Joi.string().valid('utf8', 'ASCII', 'binary', 'hex', 'base64', 'utf16le', 'latin1', 'ucs2').optional(),
	});

	return validator.validateBySchema(req, setCompSchema);
}

function dropComponentFileValidator(req) {
	const dropCompSchema = Joi.object({
		project: Joi.string()
			.pattern(PROJECT_FILE_NAME_REGEX)
			.required()
			.messages({ 'string.pattern.base': HDB_ERROR_MSGS.BAD_PROJECT_NAME }),
		file: Joi.string().custom(checkFilePath).optional(),
	});

	return validator.validateBySchema(req, dropCompSchema);
}

function getComponentFileValidator(req) {
	const getCompSchema = Joi.object({
		project: Joi.string().required(),
		file: Joi.string().custom(checkFilePath).required(),
		encoding: Joi.string().valid('utf8', 'ASCII', 'binary', 'hex', 'base64', 'utf16le', 'latin1', 'ucs2').optional(),
	});

	return validator.validateBySchema(req, getCompSchema);
}

/**
 * Validate addCustomFunctionProject requests.
 * @param req
 * @returns {*}
 */
function addComponentValidator(req) {
	const addFuncSchema = Joi.object({
		project: Joi.string()
			.pattern(PROJECT_FILE_NAME_REGEX)
			.custom(checkProjectExists.bind(null, false))
			.required()
			.messages({ 'string.pattern.base': HDB_ERROR_MSGS.BAD_PROJECT_NAME }),
		template: Joi.string().optional(),
		install: Joi.object({
			command: Joi.string().optional(),
			timeout: Joi.number().optional(),
		}).optional(),
	});

	return validator.validateBySchema(req, addFuncSchema);
}

/**
 * Validate dropCustomFunctionProject requests.
 * @param req
 * @returns {*}
 */
function dropCustomFunctionProjectValidator(req) {
	const dropFuncSchema = Joi.object({
		project: Joi.string()
			.pattern(PROJECT_FILE_NAME_REGEX)
			.custom(checkProjectExists.bind(null, true))
			.required()
			.messages({ 'string.pattern.base': HDB_ERROR_MSGS.BAD_PROJECT_NAME }),
	});

	return validator.validateBySchema(req, dropFuncSchema);
}

/**
 * Validate packageCustomFunctionProject requests.
 * @param req
 * @returns {*}
 */
function packageComponentValidator(req) {
	const packageProjSchema = Joi.object({
		project: Joi.string()
			.pattern(PROJECT_FILE_NAME_REGEX)
			.required()
			.messages({ 'string.pattern.base': HDB_ERROR_MSGS.BAD_PROJECT_NAME }),
		skip_node_modules: Joi.boolean(),
		skip_symlinks: Joi.boolean(),
	});

	return validator.validateBySchema(req, packageProjSchema);
}

/**
 * Validate deployComponent requests.
 * @param req
 * @returns {*}
 */
function deployComponentValidator(req) {
	const deployProjSchema = Joi.object({
		project: Joi.string()
			.pattern(PROJECT_FILE_NAME_REGEX)
			.required()
			.messages({ 'string.pattern.base': HDB_ERROR_MSGS.BAD_PROJECT_NAME }),
		package: Joi.string().optional(),
		restart: Joi.alternatives().try(Joi.boolean(), Joi.string().valid('rolling')).optional(),
	});

	return validator.validateBySchema(req, deployProjSchema);
}

/**
 * Validate addSSHKey requests.
 * @param req
 * @returns {*}
 */
function addSSHKeyValidator(req) {
	const setSshSchema = Joi.object({
		name: Joi.string()
			.pattern(SSH_KEY_NAME_REGEX)
			.required()
			.messages({ 'string.pattern.base': HDB_ERROR_MSGS.BAD_SSH_KEY_NAME }),
		key: Joi.string().required(),
		host: Joi.string().required(),
		hostname: Joi.string().required(),
		known_hosts: Joi.string().optional(),
	});

	return validator.validateBySchema(req, setSshSchema);
}

/**
 * Validate updateSSHKey requests.
 * @param req
 * @returns {*}
 */
function updateSSHKeyValidator(req) {
	const setSshSchema = Joi.object({
		name: Joi.string().required(),
		key: Joi.string().required(),
	});

	return validator.validateBySchema(req, setSshSchema);
}

/**
 * Validate deleteSSHKey requests.
 * @param req
 * @returns {*}
 */
function deleteSSHKeyValidator(req) {
	const setSshSchema = Joi.object({
		name: Joi.string().required(),
	});

	return validator.validateBySchema(req, setSshSchema);
}

/**
 * Validate setSSHKnownHosts requests.
 * @param req
 * @returns {*}
 */
function setSSHKnownHostsValidator(req) {
	const setSshSchema = Joi.object({
		known_hosts: Joi.string().required(),
	});

	return validator.validateBySchema(req, setSshSchema);
}
