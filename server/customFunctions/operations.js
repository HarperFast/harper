'use strict';

const fs = require('fs-extra');
const fg = require('fast-glob');
const path = require('path');
const tar = require('tar-fs');
const uuidV4 = require('uuid/v4');
const normalize = require('normalize-path');

const validator = require('./operationsValidation');
const log = require('../../utility/logging/harper_logger');
const terms = require('../../utility/hdbTerms');
const env = require('../../utility/environment/environmentManager');
const { handleHDBError, hdb_errors } = require('../../utility/errors/hdbError');
const { HDB_ERROR_MSGS, HTTP_STATUS_CODES } = hdb_errors;

const CUSTOM_FUNCTION_TEMPLATE = path.resolve(__dirname, '../../custom_function_template');
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
				static:
					fs.existsSync(normalize(`${project_folder}/static`)) &&
					fg.sync(normalize(`${project_folder}/static/**/*`)).length,
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
 * Tar a project folder from the custom_functions folder
 *
 * @param {NodeObject} req
 * @returns Object package info: { project, payload, file }
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
	const path_to_project = path.join(cf_dir, project);
	const project_hash = uuidV4();

	// check if the project exists
	const projectExists = fs.existsSync(path_to_project);

	if (!projectExists) {
		const err_string = `Unable to locate custom function project: ${project}`;
		log.error(err_string);
		throw err_string;
	}

	// ensure /tmp exists
	if (!fs.existsSync(TMP_PATH)) {
		fs.mkdirSync(TMP_PATH);
	}

	const file = path.join(TMP_PATH, `${project_hash}.tar`);

	let tar_opts = {};
	if (req.skip_node_modules === true || req.skip_node_modules === 'true') {
		// Create options for tar module that will exclude the CF projects node_modules directory.
		tar_opts = {
			ignore: (name) => {
				return name.includes(path.join(path_to_project, 'node_modules'));
			},
		};
	}

	// pack the directory
	tar.pack(path_to_project, tar_opts).pipe(fs.createWriteStream(file));

	// wait for a second
	// eslint-disable-next-line no-magic-numbers
	await new Promise((resolve) => setTimeout(resolve, 2000));

	// read the output into base64
	const payload = fs.readFileSync(file, { encoding: 'base64' });

	// delete the file
	fs.unlinkSync(file);

	// return the package payload as base64-encoded string
	return { project, payload, file };
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
	const { project, payload, file } = req;
	const path_to_project = path.join(cf_dir, project);

	// check if the project exists
	const projectExists = fs.existsSync(path_to_project);

	if (!projectExists) {
		fs.mkdirSync(path_to_project, { recursive: true });
	}

	// ensure /tmp exists
	if (!fs.existsSync(TMP_PATH)) {
		fs.mkdirSync(TMP_PATH);
	}

	// pack the directory
	fs.writeFileSync(file, payload, { encoding: 'base64' });

	// wait for a second
	// eslint-disable-next-line no-magic-numbers
	await new Promise((resolve) => setTimeout(resolve, 2000));

	// extract the reconstituted file to the proper project directory
	fs.createReadStream(file).pipe(tar.extract(path_to_project));

	// delete the file
	fs.unlinkSync(file);

	// return the package payload as base64-encoded string
	return `Successfully deployed project: ${project}`;
}

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
};
