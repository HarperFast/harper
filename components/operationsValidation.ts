'use strict';

import Joi from 'joi';
import fs from 'fs-extra';
import path from 'path';
import * as validator from '../validation/validationWrapper.js';
import * as hdbTerms from '../utility/hdbTerms.js';
import * as hdbLogger from '../utility/logging/harper_logger.js';
import * as configUtils from '../config/configUtils.js';
import { hdbErrors } from '../utility/errors/hdbError.js';
const { HDB_ERROR_MSGS } = hdbErrors;

// File name can only be alphanumeric, dash and underscores
const PROJECT_FILE_NAME_REGEX = /^[a-zA-Z0-9-_]+$/;

export {
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
 * @param checkExists - determine if validator returns error if exists or vice versa
 * @param project
 * @param helpers
 * @returns {*}
 */
function checkProjectExists(checkExists: boolean, project: string, helpers: Joi.CustomHelpers): any {
	try {
		const cfDir = configUtils.getConfigPath(hdbTerms.CONFIG_PARAMS.COMPONENTSROOT);
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
		hdbLogger.error(err as any);
		return helpers.message(HDB_ERROR_MSGS.VALIDATION_ERR);
	}
}

function checkFilePath(path: string, helpers: Joi.CustomHelpers): any {
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
function checkFileExists(project: string, type: string, file: string, helpers: Joi.CustomHelpers): any {
	try {
		const cfDir = configUtils.getConfigPath(hdbTerms.CONFIG_PARAMS.COMPONENTSROOT);
		const filePath = path.join(cfDir, project, type, file + '.js');
		if (!fs.existsSync(filePath)) {
			return helpers.message(HDB_ERROR_MSGS.NO_FILE);
		}

		return file;
	} catch (err) {
		hdbLogger.error(err as any);
		return helpers.message(HDB_ERROR_MSGS.VALIDATION_ERR);
	}
}

/**
 * Used to validate getCustomFunction and dropCustomFunction
 * @param req
 * @returns {*}
 */
function getDropCustomFunctionValidator(req: any): Error | undefined {
	const getFuncSchema = Joi.object({
		project: Joi.string()
			.pattern(PROJECT_FILE_NAME_REGEX)
			.custom((value, helpers) => checkProjectExists(true, value, helpers))
			.required()
			.messages({ 'string.pattern.base': HDB_ERROR_MSGS.BAD_PROJECT_NAME }),
		type: Joi.string().valid('helpers', 'routes').required(),
		file: Joi.string()
			.pattern(PROJECT_FILE_NAME_REGEX)
			.custom((value, helpers) => checkFileExists(req.project, req.type, value, helpers))
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
function setCustomFunctionValidator(req: any): Error | undefined {
	const setFuncSchema = Joi.object({
		project: Joi.string()
			.pattern(PROJECT_FILE_NAME_REGEX)
			.custom((value, helpers) => checkProjectExists(true, value, helpers))
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
function setComponentFileValidator(req: any): Error | undefined {
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

function dropComponentFileValidator(req: any): Error | undefined {
	const dropCompSchema = Joi.object({
		project: Joi.string()
			.pattern(PROJECT_FILE_NAME_REGEX)
			.required()
			.messages({ 'string.pattern.base': HDB_ERROR_MSGS.BAD_PROJECT_NAME }),
		file: Joi.string().custom(checkFilePath).optional(),
	});

	return validator.validateBySchema(req, dropCompSchema);
}

function getComponentFileValidator(req: any): Error | undefined {
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
function addComponentValidator(req: any): Error | undefined {
	const addFuncSchema = Joi.object({
		project: Joi.string()
			.pattern(PROJECT_FILE_NAME_REGEX)
			.custom((value, helpers) => checkProjectExists(false, value, helpers))
			.required()
			.messages({ 'string.pattern.base': HDB_ERROR_MSGS.BAD_PROJECT_NAME }),
		template: Joi.string().optional(),
		install_command: Joi.string().optional(),
		install_timeout: Joi.number().optional(),
	});

	return validator.validateBySchema(req, addFuncSchema);
}

/**
 * Validate dropCustomFunctionProject requests.
 * @param req
 * @returns {*}
 */
function dropCustomFunctionProjectValidator(req: any): Error | undefined {
	const dropFuncSchema = Joi.object({
		project: Joi.string()
			.pattern(PROJECT_FILE_NAME_REGEX)
			.custom((value, helpers) => checkProjectExists(true, value, helpers))
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
function packageComponentValidator(req: any): Error | undefined {
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
function deployComponentValidator(req: any): Error | undefined {
	const deployProjSchema = Joi.object({
		project: Joi.string()
			.pattern(PROJECT_FILE_NAME_REGEX)
			.required()
			.messages({ 'string.pattern.base': HDB_ERROR_MSGS.BAD_PROJECT_NAME }),
		package: Joi.string().optional(),
		restart: Joi.alternatives().try(Joi.boolean(), Joi.string().valid('rolling')).optional(),
		install_command: Joi.string().optional(),
		install_timeout: Joi.number().optional(),
		force: Joi.boolean().optional(),
	});

	return validator.validateBySchema(req, deployProjSchema);
}
