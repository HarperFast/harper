'use strict';

const Joi = require('joi');
const path = require('path');

const { handleHDBError, hdbErrors } = require('./errors/hdbError.js');
const { HTTP_STATUS_CODES } = hdbErrors;

const validator = require('../validation/validationWrapper.js');
const harperLogger = require('./logging/harper_logger.js');

module.exports = {
	installModules,
};

const { CONFIG_PARAMS } = require('./hdbTerms.ts');
const { getConfigValue } = require('../config/configUtils.js');
const { nonInteractiveSpawn } = require('../components/Application.ts');

/**
 * Executes npm install against specified custom function projects
 * @param {Object} req
 * @returns {Promise<{}>}
 */
async function installModules(req) {
	const deprecationWarning =
		'install_node_modules is deprecated. Dependencies are automatically installed on' +
		' deploy, and install_node_modules can lead to inconsistent behavior';
	harperLogger.warn(deprecationWarning, req.projects);
	const validation = modulesValidator(req);
	if (validation) {
		throw handleHDBError(validation, validation.message, HTTP_STATUS_CODES.BAD_REQUEST);
	}

	let { projects, dryRun } = req;

	const componentsRootDirPath = getConfigValue(CONFIG_PARAMS.COMPONENTSROOT);

	const responseObject = {};

	const args = ['install', '--force', '--omit=dev', '--json'];
	if (dryRun) args.push('--dry-run');

	for (const project of projects) {
		responseObject[project] = { npm_output: null, npm_error: null };
		const projectPath = path.join(componentsRootDirPath, project);
		try {
			let { stdout, stderr } = nonInteractiveSpawn(project, 'npm', args, projectPath);
			stdout = stdout ? stdout.replace('\n', '') : null;
			stderr = stderr ? stderr.replace('\n', '') : null;

			try {
				responseObject[project].npm_output = JSON.parse(stdout);
			} catch {
				responseObject[project].npm_output = stdout;
			}

			try {
				responseObject[project].npm_error = JSON.parse(stderr);
			} catch {
				responseObject[project].npm_error = stderr;
			}
		} catch (error) {
			if (error.stderr) {
				responseObject[project].npm_error = parseNPMStdErr(error.stderr);
			} else {
				responseObject[project].npm_error = error.message;
			}
			continue;
		}
	}

	harperLogger.info(`finished installModules with response ${responseObject}`);
	responseObject.warning = deprecationWarning;
	return responseObject;
}

function parseNPMStdErr(stderr) {
	//npm returns errors inconsistently, on 6 it returns json, on 8 it returns json stringified inside of a larger string
	let startSearchString = '"error": {';
	let start = stderr.indexOf('"error": {');
	let end = stderr.indexOf('}\n');
	if (start > -1 && end > -1) {
		return JSON.parse(stderr.substring(start + startSearchString.length - 1, end + 1));
	} else {
		return stderr;
	}
}

/**
 * Validator for both installModules & auditModules
 * @param {Object} req
 * @returns {*}
 */
function modulesValidator(req) {
	const funcSchema = Joi.object({
		projects: Joi.array().min(1).items(Joi.string()).required(),
		dry_run: Joi.boolean().default(false),
	});

	return validator.validateBySchema(req, funcSchema);
}
