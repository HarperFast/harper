'use strict';

const Joi = require('joi');
const path = require('path');
const fs = require('fs-extra');
const { exec, spawn } = require('child_process');
const util = require('util');
const pExec = util.promisify(exec);
const terms = require('./hdbTerms.ts');
const { PACKAGE_ROOT } = require('./packageUtils.js');
const { handleHDBError, hdbErrors } = require('./errors/hdbError.js');
const { HTTP_STATUS_CODES } = hdbErrors;
const env = require('./environment/environmentManager.js');
const validator = require('../validation/validationWrapper.js');
const harperLogger = require('./logging/harper_logger.js');
const { once } = require('events');
env.initSync();
const CF_ROUTES_DIR = env.get(terms.CONFIG_PARAMS.COMPONENTSROOT);
const NPM_INSTALL_COMMAND = 'npm install --force --omit=dev --json';
const NPM_INSTALL_DRY_RUN_COMMAND = `${NPM_INSTALL_COMMAND} --dry-run`;
const rootDir = env.get(terms.CONFIG_PARAMS.ROOTPATH);
const sshDir = path.join(rootDir, 'ssh');

module.exports = {
	installModules,
	auditModules,
	installAllRootModules,
	uninstallRootModule,
	linkHarperdb,
	runCommand,
};

/**
 * Runs npm install in the HDB root path.
 * @param ignoreScripts - tell npm to not run any scripts that might exist in a package.json
 * @returns {Promise<void>}
 */
async function installAllRootModules(ignoreScripts = false, workingDir = env.get(terms.CONFIG_PARAMS.ROOTPATH)) {
	await checkNPMInstalled();
	let sshKeyAdded = false;
	let envVars = process.env;
	if (fs.pathExistsSync(sshDir)) {
		fs.readdirSync(sshDir).forEach((file) => {
			if (file.includes('.key') && !sshKeyAdded) {
				envVars = {
					GIT_SSH_COMMAND:
						'ssh -F ' + path.join(sshDir, 'config') + ' -o UserKnownHostsFile=' + path.join(sshDir, 'known_hosts'),
					...process.env,
				};
				sshKeyAdded = true;
			}
		});
	}

	// When the user running HarperDB does not have write permissions to the global nodeModules directory npm install will fail due to the symlink
	try {
		const rootPath = env.get(terms.CONFIG_PARAMS.ROOTPATH);
		const harperModule = path.join(rootPath, 'node_modules', 'harperdb');

		if (fs.lstatSync(harperModule).isSymbolicLink()) {
			fs.unlinkSync(harperModule);
		}
	} catch (err) {
		if (err.code !== 'ENOENT') {
			harperLogger.error('Error removing symlink:', err);
		}
	}

	await runCommand(ignoreScripts ? 'npm install --force --ignore-scripts' : 'npm install --force', workingDir, envVars);
}

/**
 * Uninstall a HDB root module
 * @param pkgName
 * @returns {Promise<void>}
 */
async function uninstallRootModule(pkgName) {
	await runCommand(`npm uninstall ${pkgName}`, env.get(terms.CONFIG_PARAMS.ROOTPATH));
}

/**
 * Create a symlink of HarperDB app in the nodeModules
 * @returns {Promise<void>}
 */
async function linkHarperdb() {
	await checkNPMInstalled();
	await runCommand(`npm link ${PACKAGE_ROOT}`, env.get(terms.CONFIG_PARAMS.ROOTPATH));
}

/**
 * Runs a bash script in a new shell
 * @param {String} command - the command to execute
 * @param {String=} cwd - path to the current working directory
 * @returns {Promise<*>}
 */
async function runCommand(command, cwd = undefined, env = process.env) {
	harperLogger.debug({ tagName: 'npm_run_command' }, `running command: \`${command}\``);

	// eslint-disable-next-line sonarjs/os-command
	const commandProcess = spawn(command, {
		shell: true,
		cwd,
		env,
		stdio: ['ignore', 'pipe', 'pipe'],
	});

	let stdout = '';
	let stderr = '';

	commandProcess.stdout.on('data', (chunk) => {
		const str = chunk.toString();
		harperLogger.debug({ tagName: 'npm_run_command:stdout' }, str);
		stdout += str;
	});

	commandProcess.stderr.on('data', (chunk) => {
		const str = chunk.toString();
		harperLogger.error({ tagName: 'npm_run_command:stderr' }, str);
		stderr += str;
	});

	const [code] = await once(commandProcess, 'close');

	if (code !== 0) {
		// eslint-disable-next-line sonarjs/no-nested-template-literals
		throw new Error(`Command \`${command}\` exited with code ${code}.${stderr === '' ? '' : ` Error: ${stderr}`}`);
	}

	return stdout || undefined;
}

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
	//dryRun decides whether or not to use the npm --dry-run flag: https://docs.npmjs.com/cli/v8/commands/npm-install#dry-run
	const command = dryRun === true ? NPM_INSTALL_DRY_RUN_COMMAND : NPM_INSTALL_COMMAND;
	await checkNPMInstalled();

	await checkProjectPaths(projects);

	//loop projects and run npm install
	let responseObject = {};
	for (let x = 0, length = projects.length; x < length; x++) {
		const projectName = projects[x];
		responseObject[projectName] = { npm_output: null, npm_error: null };
		const PROJECT_PATH = path.join(CF_ROUTES_DIR, projectName);

		let output,
			error = null;
		try {
			const { stdout, stderr } = await pExec(command, { cwd: PROJECT_PATH });
			output = stdout ? stdout.replace('\n', '') : null;
			error = stderr ? stderr.replace('\n', '') : null;
		} catch (e) {
			if (e.stderr) {
				responseObject[projectName].npm_error = parseNPMStdErr(e.stderr);
			} else {
				responseObject[projectName].npm_error = e.message;
			}
			continue;
		}

		try {
			responseObject[projectName].npm_output = JSON.parse(output);
		} catch (e) {
			responseObject[projectName].npm_output = output;
		}

		try {
			responseObject[projectName].npm_error = JSON.parse(error);
		} catch (e) {
			responseObject[projectName].npm_error = error;
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
 * Executes command npm audit against specified custom function projects
 * @param {Object} req
 * @returns {Promise<{}>}
 */
async function auditModules(req) {
	harperLogger.info(`starting auditModules for request: ${req}`);
	const validation = modulesValidator(req);
	if (validation) {
		throw handleHDBError(validation, validation.message, HTTP_STATUS_CODES.BAD_REQUEST);
	}
	let { projects } = req;

	await checkNPMInstalled();

	await checkProjectPaths(projects);

	//loop projects and run npm audit
	let responseObject = {};
	for (let x = 0, length = projects.length; x < length; x++) {
		const projectName = projects[x];
		const PROJECT_PATH = path.join(CF_ROUTES_DIR, projectName);
		responseObject[projectName] = { npm_output: null, npm_error: null };
		try {
			let output = await runCommand('npm audit --json', PROJECT_PATH);
			responseObject[projectName].npm_output = JSON.parse(output);
		} catch (e) {
			responseObject[projectName].npm_error = parseNPMStdErr(e.stderr);
		}
	}
	harperLogger.info(`finished auditModules with response ${responseObject}`);
	return responseObject;
}

/**
 * Checks if npm is installed
 * @returns {Promise<boolean>}
 */
async function checkNPMInstalled() {
	//verify npm is available on this machine
	await runCommand('npm -v');
	return true;
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
	let noPackageJsons = [];
	for (let x = 0, length = projects.length; x < length; x++) {
		const projectName = projects[x];
		const PROJECT_PATH = path.join(CF_ROUTES_DIR, projectName.toString());
		//check project exists
		let projectExists = await fs.pathExists(PROJECT_PATH);
		if (!projectExists) {
			no_projects.push(projectName);
			continue;
		}

		//check project has package.json
		const packageJsonPath = path.join(PROJECT_PATH, 'package.json');
		let packageJsonExists = await fs.pathExists(packageJsonPath);
		if (!packageJsonExists) {
			noPackageJsons.push(projectName);
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

	if (noPackageJsons.length > 0) {
		throw handleHDBError(
			new Error(),
			`Unable to install project dependencies: custom function projects '${noPackageJsons.join(
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
	const funcSchema = Joi.object({
		projects: Joi.array().min(1).items(Joi.string()).required(),
		dry_run: Joi.boolean().default(false),
	});

	return validator.validateBySchema(req, funcSchema);
}
