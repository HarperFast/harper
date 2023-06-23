'use strict';

const fs = require('fs-extra');
const fg = require('fast-glob');
const path = require('path');
const tar = require('tar-fs');
const uuidV4 = require('uuid').v4;
const normalize = require('normalize-path');
const { parentPort } = require('worker_threads');

const validator = require('./operationsValidation');
const log = require('../utility/logging/harper_logger');
const terms = require('../utility/hdbTerms');
const env = require('../utility/environment/environmentManager');
const config_utils = require('../config/configUtils');
const hdb_utils = require('../utility/common_utils');
const { PACKAGE_ROOT } = require('../utility/hdbTerms');
const { handleHDBError, hdb_errors } = require('../utility/errors/hdbError');
const { HDB_ERROR_MSGS, HTTP_STATUS_CODES } = hdb_errors;

const CUSTOM_FUNCTION_TEMPLATE = path.join(PACKAGE_ROOT, 'custom_function_template');
const TMP_PATH = path.join(env.get(terms.HDB_SETTINGS_NAMES.HDB_ROOT_KEY), 'tmp');

function isCFEnabled() {
	const custom_functions_enabled = env.get(terms.HDB_SETTINGS_NAMES.CUSTOM_FUNCTIONS_ENABLED_KEY);
	if (custom_functions_enabled === 'true' || custom_functions_enabled === true || custom_functions_enabled === 'TRUE') {
		return;
	}
	throw handleHDBError(
		new Error(),
		HDB_ERROR_MSGS.NOT_ENABLED,
		HTTP_STATUS_CODES.BAD_REQUEST,
		undefined,
		undefined,
		true
	);
}

/**
 * Read the settings.js file and return the
 *
 * @return Object.<String>
 */
function customFunctionsStatus() {
	console.log(`getting custom api status`);
	log.trace(`getting custom api status`);
	let response = {};

	try {
		response = {
			is_enabled: env.get(terms.HDB_SETTINGS_NAMES.CUSTOM_FUNCTIONS_ENABLED_KEY),
			port: env.get(terms.HDB_SETTINGS_NAMES.CUSTOM_FUNCTIONS_PORT_KEY),
			directory: env.get(terms.HDB_SETTINGS_NAMES.CUSTOM_FUNCTIONS_DIRECTORY_KEY),
		};
	} catch (err) {
		throw handleHDBError(
			new Error(),
			HDB_ERROR_MSGS.FUNCTION_STATUS,
			HTTP_STATUS_CODES.INTERNAL_SERVER_ERROR,
			log.ERR,
			err
		);
	}
	return response;
}

/**
 * Read the user-defined custom_functions/routes directory and return the file names
 *
 * @return Array.<String>
 */
function getCustomFunctions() {
	log.trace(`getting custom api endpoints`);
	let response = {};
	const dir = env.get(terms.HDB_SETTINGS_NAMES.CUSTOM_FUNCTIONS_DIRECTORY_KEY);

	try {
		const project_folders = fg.sync(normalize(`${dir}/*`), { onlyDirectories: true });

		project_folders.forEach((project_folder) => {
			const folderName = project_folder.split('/').pop();
			response[folderName] = {
				routes: fg
					.sync(normalize(`${project_folder}/routes/*.js`))
					.map((filepath) => filepath.split('/').pop().split('.js')[0]),
				helpers: fg
					.sync(normalize(`${project_folder}/helpers/*.js`))
					.map((filepath) => filepath.split('/').pop().split('.js')[0]),
			};
		});
	} catch (err) {
		throw handleHDBError(
			new Error(),
			HDB_ERROR_MSGS.GET_FUNCTIONS,
			HTTP_STATUS_CODES.INTERNAL_SERVER_ERROR,
			log.ERR,
			err
		);
	}
	return response;
}

/**
 * Read the specified function_name file in the custom_functions/routes directory and return the file content
 *
 * @param {NodeObject} req
 * @returns {string}
 */
function getCustomFunction(req) {
	if (req.project) {
		req.project = path.parse(req.project).name;
	}

	if (req.file) {
		req.file = path.parse(req.file).name;
	}

	const validation = validator.getDropCustomFunctionValidator(req);
	if (validation) {
		throw handleHDBError(validation, validation.message, HTTP_STATUS_CODES.BAD_REQUEST);
	}

	log.trace(`getting custom api endpoint file content`);
	const cf_dir = env.get(terms.HDB_SETTINGS_NAMES.CUSTOM_FUNCTIONS_DIRECTORY_KEY);
	const { project, type, file } = req;
	const fileLocation = path.join(cf_dir, project, type, file + '.js');

	try {
		return fs.readFileSync(fileLocation, { encoding: 'utf8' });
	} catch (err) {
		throw handleHDBError(
			new Error(),
			HDB_ERROR_MSGS.GET_FUNCTION,
			HTTP_STATUS_CODES.INTERNAL_SERVER_ERROR,
			log.ERR,
			err
		);
	}
}

/**
 * Write the supplied function_content to the provided function_name file in the custom_functions/routes directory
 *
 * @param {NodeObject} req
 * @returns {string}
 */
function setCustomFunction(req) {
	isCFEnabled();
	if (req.project) {
		req.project = path.parse(req.project).name;
	}

	if (req.file) {
		req.file = path.parse(req.file).name;
	}

	const validation = validator.setCustomFunctionValidator(req);
	if (validation) {
		throw handleHDBError(validation, validation.message, HTTP_STATUS_CODES.BAD_REQUEST);
	}

	log.trace(`setting custom function file content`);
	const cf_dir = env.get(terms.HDB_SETTINGS_NAMES.CUSTOM_FUNCTIONS_DIRECTORY_KEY);
	const { project, type, file, function_content } = req;

	try {
		fs.outputFileSync(path.join(cf_dir, project, type, file + '.js'), function_content);
		return `Successfully updated custom function: ${file}.js`;
	} catch (err) {
		throw handleHDBError(
			new Error(),
			HDB_ERROR_MSGS.SET_FUNCTION,
			HTTP_STATUS_CODES.INTERNAL_SERVER_ERROR,
			log.ERR,
			err
		);
	}
}

/**
 * Delete the provided function_name file from the custom_functions/routes directory
 *
 * @param {NodeObject} req
 * @returns {string}
 */
function dropCustomFunction(req) {
	if (req.project) {
		req.project = path.parse(req.project).name;
	}

	if (req.file) {
		req.file = path.parse(req.file).name;
	}

	const validation = validator.getDropCustomFunctionValidator(req);
	if (validation) {
		throw handleHDBError(validation, validation.message, HTTP_STATUS_CODES.BAD_REQUEST);
	}

	log.trace(`dropping custom function file`);
	const cf_dir = env.get(terms.HDB_SETTINGS_NAMES.CUSTOM_FUNCTIONS_DIRECTORY_KEY);
	const { project, type, file } = req;

	try {
		fs.unlinkSync(path.join(cf_dir, project, type, file + '.js'));
		return `Successfully deleted custom function: ${file}.js`;
	} catch (err) {
		throw handleHDBError(
			new Error(),
			HDB_ERROR_MSGS.DROP_FUNCTION,
			HTTP_STATUS_CODES.INTERNAL_SERVER_ERROR,
			log.ERR,
			err
		);
	}
}

/**
 * Create a new project folder in the custom_functions folder and copy the template into it
 *
 * @param {NodeObject} req
 * @returns {string}
 */
function addCustomFunctionProject(req) {
	isCFEnabled();
	if (req.project) {
		req.project = path.parse(req.project).name;
	}

	const validation = validator.addCustomFunctionProjectValidator(req);
	if (validation) {
		throw handleHDBError(validation, validation.message, HTTP_STATUS_CODES.BAD_REQUEST);
	}

	log.trace(`adding custom function project`);
	const cf_dir = env.get(terms.HDB_SETTINGS_NAMES.CUSTOM_FUNCTIONS_DIRECTORY_KEY);
	const { project } = req;

	try {
		const project_dir = path.join(cf_dir, project);
		fs.mkdirSync(project_dir, { recursive: true });
		fs.copySync(CUSTOM_FUNCTION_TEMPLATE, project_dir);
		return `Successfully created custom function project: ${project}`;
	} catch (err) {
		throw handleHDBError(
			new Error(),
			HDB_ERROR_MSGS.ADD_FUNCTION,
			HTTP_STATUS_CODES.INTERNAL_SERVER_ERROR,
			log.ERR,
			err
		);
	}
}

/**
 * Remove a project folder from the custom_functions folder
 *
 * @param {NodeObject} req
 * @returns {string}
 */
function dropCustomFunctionProject(req) {
	if (req.project) {
		req.project = path.parse(req.project).name;
	}

	const validation = validator.dropCustomFunctionProjectValidator(req);
	if (validation) {
		throw handleHDBError(validation, validation.message, HTTP_STATUS_CODES.BAD_REQUEST);
	}

	log.trace(`dropping custom function project`);
	const cf_dir = env.get(terms.HDB_SETTINGS_NAMES.CUSTOM_FUNCTIONS_DIRECTORY_KEY);
	const { project } = req;

	let apps = env.get(terms.CONFIG_PARAMS.APPS);
	if (!hdb_utils.isEmptyOrZeroLength(apps)) {
		let app_found = false;
		for (const [i, app] of apps.entries()) {
			if (app.name === project) {
				apps.splice(i, 1);
				app_found = true;
				break;
			}
		}

		if (app_found) {
			config_utils.updateConfigValue(terms.CONFIG_PARAMS.APPS, apps);

			return `Successfully deleted project: ${project}`;
		}
	}

	try {
		const project_dir = path.join(cf_dir, project);
		fs.rmSync(project_dir, { recursive: true });
		return `Successfully deleted project: ${project}`;
	} catch (err) {
		throw handleHDBError(
			new Error(),
			HDB_ERROR_MSGS.DROP_FUNCTION_PROJECT,
			HTTP_STATUS_CODES.INTERNAL_SERVER_ERROR,
			log.ERR,
			err
		);
	}
}

/**
 * Packages a CF project into a tar file and also returns the base64 encode of said tar file.
 * Will copy the project into a temp dir call 'package', this is done because when npm installing tar
 * files the contents of the tar need to be in a dir called package. Deploy CF project uses npm install.
 * @param req
 * @returns {Promise<{file: string, payload: *, project}>}
 */
async function packageCustomFunctionProject(req) {
	if (req.project) {
		req.project = path.parse(req.project).name;
	}

	const validation = validator.packageCustomFunctionProjectValidator(req);
	if (validation) {
		throw handleHDBError(validation, validation.message, HTTP_STATUS_CODES.BAD_REQUEST);
	}

	log.trace(`packaging custom function project`);
	const cf_dir = env.get(terms.HDB_SETTINGS_NAMES.CUSTOM_FUNCTIONS_DIRECTORY_KEY);
	const { project } = req;
	const path_to_project = await fs.realpath(path.join(cf_dir, project));

	// npm requires the contents of a module to be in a 'package' directory.
	const tmp_project_dir = path.join(TMP_PATH, project);
	const tmp_package_dir = path.join(tmp_project_dir, 'package');
	fs.ensureDirSync(tmp_package_dir);
	await fs.copy(path_to_project, tmp_package_dir, { overwrite: true });

	const file = path.join(TMP_PATH, `${project}.tar`);
	let tar_opts = {};
	if (req.skip_node_modules === true || req.skip_node_modules === 'true') {
		// Create options for tar module that will exclude the CF projects node_modules directory.
		tar_opts = {
			ignore: (name) => {
				return name.includes(path.join(tmp_package_dir, 'node_modules'));
			},
		};
	}

	// pack the directory
	tar.pack(tmp_project_dir, tar_opts).pipe(fs.createWriteStream(file, { overwrite: true }));

	// wait for a second
	// eslint-disable-next-line no-magic-numbers
	await new Promise((resolve) => setTimeout(resolve, 2000));

	// read the output into base64
	const payload = fs.readFileSync(file, { encoding: 'base64' });

	await fs.remove(tmp_project_dir);

	// return the package payload as base64-encoded string
	return { project, file, payload };
}

/**
 * Tar a project folder from the custom_functions folder
 *
 * @param {NodeObject} req
 * @returns {string}
 */
async function deployCustomFunctionProject(req) {
	isCFEnabled();
	if (req.project) {
		req.project = path.parse(req.project).name;
	}

	const validation = validator.deployCustomFunctionProjectValidator(req);
	if (validation) {
		throw handleHDBError(validation, validation.message, HTTP_STATUS_CODES.BAD_REQUEST);
	}

	log.trace(`deploying custom function project`);
	const cf_dir = env.get(terms.HDB_SETTINGS_NAMES.CUSTOM_FUNCTIONS_DIRECTORY_KEY);
	const { project, payload, package: pkg, bypass_apps } = req;

	if (bypass_apps !== true) {
		let new_app = {
			name: project,
		};

		if (payload) {
			const path_to_project_tar = path.join(cf_dir, project + '.tar');
			await fs.outputFile(path_to_project_tar, payload, { encoding: 'base64' });
			new_app.package = path_to_project_tar;
		} else if (pkg) {
			new_app.package = pkg;
		} else {
			throw new Error("'payload' or 'package' must be provided");
		}

		// Adds package to harperdb-config and then relies on restart to call install on the new app
		let apps = env.get(terms.CONFIG_PARAMS.APPS);
		if (apps === undefined) apps = [];

		let app_already_exists = false;
		for (const app of apps) {
			if (app.name === new_app.name) {
				app.package = new_app.package;
				app_already_exists = true;
			}
		}

		if (!app_already_exists) {
			apps.push(new_app);
		}

		config_utils.updateConfigValue(terms.CONFIG_PARAMS.APPS, apps);
	} else {
		// If they are bypassing apps we do not add the deployment to the apps config, it goes directly so the custom functions dir
		if (pkg) throw new Error('bypass_apps is not available when deploying from package');
		const path_to_project = path.join(cf_dir, project);
		// check if the project exists, if it doesn't, create it.
		await fs.ensureDir(path_to_project);

		// Create a temp file to store project tar in. Check that is doesn't already exist, if it does create another path and test.
		let temp_file_path;
		let temp_file_exists;
		do {
			temp_file_path = path.join(TMP_PATH, uuidV4() + '.tar');
			temp_file_exists = await fs.pathExists(temp_file_path);
		} while (temp_file_exists);

		// pack the directory
		await fs.outputFile(temp_file_path, payload, { encoding: 'base64' });

		// extract the reconstituted file to the proper project directory
		const stream = fs.createReadStream(temp_file_path);
		stream.pipe(tar.extract(path_to_project));
		await new Promise((resolve) => stream.on('end', resolve));

		// delete the file
		await fs.unlink(temp_file_path);
	}

	return `Successfully deployed project: ${project}`;
}

async function getComponentFiles() {
	const files = await fs.readdir(env.get(terms.CONFIG_PARAMS.CUSTOMFUNCTIONS_ROOT));
	console.log(files);
}

async function getComponentFile(name, path) {}

async function setComponentFile() {}

module.exports = {
	customFunctionsStatus,
	getCustomFunctions,
	getCustomFunction,
	setCustomFunction,
	dropCustomFunction,
	addCustomFunctionProject,
	dropCustomFunctionProject,
	packageCustomFunctionProject,
	deployCustomFunctionProject,
	getComponentFiles,
	getComponentFile,
	setComponentFile,
};
