'use strict';

import Joi from 'joi';
import * as path from 'path';

import { handleHDBError, hdbErrors } from './errors/hdbError.ts';

const { HTTP_STATUS_CODES } = hdbErrors;

import * as validator from '../validation/validationWrapper.ts';
import harperLogger from './logging/harper_logger.ts';

import { CONFIG_PARAMS } from './hdbTerms.ts';
import { getConfigPath } from '../config/configUtils.js';
import { nonInteractiveSpawn } from '../components/Application.ts';

/**
 * Executes npm install against specified custom function projects
 * @param {Object} req
 * @returns {Promise<{}>}
 */
export async function installModules(req: any) {
	const deprecationWarning =
		'install_node_modules is deprecated. Dependencies are automatically installed on' +
		' deploy, and install_node_modules can lead to inconsistent behavior';
	harperLogger.warn(deprecationWarning, req.projects);
	const validation = modulesValidator(req);
	if (validation) {
		throw handleHDBError(validation, validation.message, HTTP_STATUS_CODES.BAD_REQUEST);
	}

	let { projects, dryRun } = req;

	const componentsRootDirPath = getConfigPath(CONFIG_PARAMS.COMPONENTSROOT);

	const responseObject: any = {};

	const args = ['install', '--force', '--omit=dev', '--json'];
	if (dryRun) args.push('--dry-run');

	for (const project of projects) {
		responseObject[project] = { npm_output: null, npm_error: null };
		const projectPath = path.join(componentsRootDirPath, project);
		try {
			let { stdout, stderr } = await nonInteractiveSpawn(project, 'npm', args, projectPath);
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

function parseNPMStdErr(stderr: string) {
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
function modulesValidator(req: any) {
	const funcSchema = Joi.object({
		projects: Joi.array().min(1).items(Joi.string()).required(),
		dry_run: Joi.boolean().default(false),
	});

	return validator.validateBySchema(req, funcSchema);
}
