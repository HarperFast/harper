'use strict';

const Joi = require('joi');
const path = require('path');
const fs = require('fs-extra');
const { exec } = require('child_process');
const util = require('util');
const p_exec = util.promisify(exec);
const terms = require('./hdbTerms');
const { handleHDBError, hdb_errors } = require('./errors/hdbError');
const { HTTP_STATUS_CODES } = hdb_errors;
const env = require('./environment/environmentManager');
const validator = require('../validation/validationWrapper');
const harper_logger = require('./logging/harper_logger');
env.initSync();
const CF_ROUTES_DIR = env.get(terms.CONFIG_PARAMS.COMPONENTSROOT);
const NPM_INSTALL_COMMAND = 'npm install --force --omit=dev --json';
const NPM_INSTALL_DRY_RUN_COMMAND = `${NPM_INSTALL_COMMAND} --dry-run`;
const root_dir = env.get(terms.CONFIG_PARAMS.ROOTPATH);
const ssh_dir = path.join(root_dir, 'ssh');

module.exports = {
	installModules,
	auditModules,
	installAllRootModules,
	uninstallRootModule,
	linkHarperdb,
};

/**
 * Runs npm install in the HDB root path.
 * @param ignore_scripts - tell npm to not run any scripts that might exist in a package.json
 * @returns {Promise<void>}
 */
async function installAllRootModules(ignore_scripts = false, working_dir = env.get(terms.CONFIG_PARAMS.ROOTPATH)) {
	await checkNPMInstalled();
	let ssh_key_added = false;
	let env_vars = process.env;
	if (fs.pathExistsSync(ssh_dir)) {
		fs.readdirSync(ssh_dir).forEach((file) => {
			if (file.includes('.key') && !ssh_key_added) {
				env_vars = {
					GIT_SSH_COMMAND:
						'ssh -F ' + path.join(ssh_dir, 'config') + ' -o UserKnownHostsFile=' + path.join(ssh_dir, 'known_hosts'),
					...process.env,
				};
				ssh_key_added = true;
			}
		});
	}

	await runCommand(
		ignore_scripts ? 'npm install --force --ignore-scripts' : 'npm install --force',
		working_dir,
		env_vars
	);
}

/**
 * Uninstall a HDB root module
 * @param pkg_name
 * @returns {Promise<void>}
 */
async function uninstallRootModule(pkg_name) {
	await runCommand(`npm uninstall ${pkg_name}`, env.get(terms.CONFIG_PARAMS.ROOTPATH));
}

/**
 * Create a symlink of HarperDB app in the node_modules
 * @returns {Promise<void>}
 */
async function linkHarperdb() {
	await checkNPMInstalled();
	await runCommand(`npm link ${terms.PACKAGE_ROOT}`, env.get(terms.CONFIG_PARAMS.ROOTPATH));
}

/**
 * Runs a bash script in a new shell
 * @param {String} command - the command to execute
 * @param {String=} cwd - path to the current working directory
 * @returns {Promise<*>}
 */
async function runCommand(command, cwd = undefined, env = process.env) {
	let stdout, stderr;
	try {
		({ stdout, stderr } = await p_exec(command, { cwd, env }));
	} catch (err) {
		throw new Error(err.stderr.replace('\n', ''));
	}

	if (stderr && !stderr.includes('Debugger listening')) {
		harper_logger.error('Error running NPM command:', command, stderr);
	}

	harper_logger.trace(stdout, stderr);
	return stdout?.replace('\n', '');
}

/**
 * Executes npm install against specified custom function projects
 * @param {Object} req
 * @returns {Promise<{}>}
 */
async function installModules(req) {
	const deprecation_warning =
		'install_node_modules is deprecated. Dependencies are automatically installed on' +
		' deploy, and install_node_modules can lead to inconsistent behavior';
	harper_logger.warn(deprecation_warning, req);
	const validation = modulesValidator(req);
	if (validation) {
		throw handleHDBError(validation, validation.message, HTTP_STATUS_CODES.BAD_REQUEST);
	}

	let { projects, dry_run } = req;
	//dry_run decides whether or not to use the npm --dry-run flag: https://docs.npmjs.com/cli/v8/commands/npm-install#dry-run
	const command = dry_run === true ? NPM_INSTALL_DRY_RUN_COMMAND : NPM_INSTALL_COMMAND;
	await checkNPMInstalled();

	await checkProjectPaths(projects);

	//loop projects and run npm install
	let response_object = {};
	for (let x = 0, length = projects.length; x < length; x++) {
		const project_name = projects[x];
		response_object[project_name] = { npm_output: null, npm_error: null };
		const PROJECT_PATH = path.join(CF_ROUTES_DIR, project_name);

		let output,
			error = null;
		try {
			const { stdout, stderr } = await p_exec(command, { cwd: PROJECT_PATH });
			output = stdout ? stdout.replace('\n', '') : null;
			error = stderr ? stderr.replace('\n', '') : null;
		} catch (e) {
			if (e.stderr) {
				response_object[project_name].npm_error = parseNPMStdErr(e.stderr);
			} else {
				response_object[project_name].npm_error = e.message;
			}
			continue;
		}

		try {
			response_object[project_name].npm_output = JSON.parse(output);
		} catch (e) {
			response_object[project_name].npm_output = output;
		}

		try {
			response_object[project_name].npm_error = JSON.parse(error);
		} catch (e) {
			response_object[project_name].npm_error = error;
		}
	}
	harper_logger.info(`finished installModules with response ${response_object}`);
	response_object.warning = deprecation_warning;
	return response_object;
}

function parseNPMStdErr(stderr) {
	//npm returns errors inconsistently, on 6 it returns json, on 8 it returns json stringified inside of a larger string
	let start_search_string = '"error": {';
	let start = stderr.indexOf('"error": {');
	let end = stderr.indexOf('}\n');
	if (start > -1 && end > -1) {
		return JSON.parse(stderr.substring(start + start_search_string.length - 1, end + 1));
	} else {
		return stderr;
	}
}

/**
 * Executes command npm audit against specified custom function projects
 * @param {Object} req
 * @returns {Promise<{}>}
 */
async function auditModules(req) {
	harper_logger.info(`starting auditModules for request: ${req}`);
	const validation = modulesValidator(req);
	if (validation) {
		throw handleHDBError(validation, validation.message, HTTP_STATUS_CODES.BAD_REQUEST);
	}
	let { projects } = req;

	await checkNPMInstalled();

	await checkProjectPaths(projects);

	//loop projects and run npm audit
	let response_object = {};
	for (let x = 0, length = projects.length; x < length; x++) {
		const project_name = projects[x];
		const PROJECT_PATH = path.join(CF_ROUTES_DIR, project_name);
		response_object[project_name] = { npm_output: null, npm_error: null };
		try {
			let output = await runCommand('npm audit --json', PROJECT_PATH);
			response_object[project_name].npm_output = JSON.parse(output);
		} catch (e) {
			response_object[project_name].npm_error = parseNPMStdErr(e.stderr);
		}
	}
	harper_logger.info(`finished auditModules with response ${response_object}`);
	return response_object;
}

/**
 * Checks if npm is installed
 * @returns {Promise<boolean>}
 */
async function checkNPMInstalled() {
	//verify npm is available on this machine
	try {
		await runCommand('npm -v');
		return true;
	} catch (e) {
		throw handleHDBError(
			new Error(),
			`Unable to install project dependencies: npm is not installed on this instance of HarperDB.`,
			HTTP_STATUS_CODES.BAD_REQUEST,
			undefined,
			undefined,
			true
		);
	}
}

/**
 * checks if projects exists & have package.json
 * @param projects
 * @returns {Promise<void>}
 */
async function checkProjectPaths(projects) {
	if (!Array.isArray(projects) || projects.length === 0) {
		throw handleHDBError(
			new Error(),
			`projects argument must be an array with at least 1 element`,
			HTTP_STATUS_CODES.BAD_REQUEST,
			undefined,
			undefined,
			true
		);
	}
	//verify all projects exist and have package.json
	let no_projects = [];
	let no_package_jsons = [];
	for (let x = 0, length = projects.length; x < length; x++) {
		const project_name = projects[x];
		const PROJECT_PATH = path.join(CF_ROUTES_DIR, project_name.toString());
		//check project exists
		let project_exists = await fs.pathExists(PROJECT_PATH);
		if (!project_exists) {
			no_projects.push(project_name);
			continue;
		}

		//check project has package.json
		const package_json_path = path.join(PROJECT_PATH, 'package.json');
		let package_json_exists = await fs.pathExists(package_json_path);
		if (!package_json_exists) {
			no_package_jsons.push(project_name);
		}
	}

	if (no_projects.length > 0) {
		throw handleHDBError(
			new Error(),
			`Unable to install project dependencies: custom function projects '${no_projects.join(',')}' does not exist.`,
			HTTP_STATUS_CODES.BAD_REQUEST,
			undefined,
			undefined,
			true
		);
	}

	if (no_package_jsons.length > 0) {
		throw handleHDBError(
			new Error(),
			`Unable to install project dependencies: custom function projects '${no_package_jsons.join(
				','
			)}' do not have a package.json file.`,
			HTTP_STATUS_CODES.BAD_REQUEST,
			undefined,
			undefined,
			true
		);
	}
}

/**
 * Validator for both installModules & auditModules
 * @param {Object} req
 * @returns {*}
 */
function modulesValidator(req) {
	const func_schema = Joi.object({
		projects: Joi.array().min(1).items(Joi.string()).required(),
		dry_run: Joi.boolean().default(false),
	});

	return validator.validateBySchema(req, func_schema);
}
