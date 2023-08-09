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

const APPLICATION_TEMPLATE = path.join(PACKAGE_ROOT, 'application-template');
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
 * Create a new project folder in the components folder and copy the template into it
 * @param {NodeObject} req
 * @returns {string}
 */
function addComponent(req) {
	isCFEnabled();
	if (req.project) {
		req.project = path.parse(req.project).name;
	}

	const validation = validator.addComponentValidator(req);
	if (validation) {
		throw handleHDBError(validation, validation.message, HTTP_STATUS_CODES.BAD_REQUEST);
	}

	log.trace(`adding component`);
	const cf_dir = env.get(terms.HDB_SETTINGS_NAMES.CUSTOM_FUNCTIONS_DIRECTORY_KEY);
	const { project } = req;

	try {
		const project_dir = path.join(cf_dir, project);
		fs.mkdirSync(project_dir, { recursive: true });
		fs.copySync(APPLICATION_TEMPLATE, project_dir);
		return `Successfully added project: ${project}`;
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
 * Will package a component into a temp tar file then output that file as a base64 string.
 * Req can accept a skip_node_modules boolean which will skip the node mods when creating temp tar file.
 * @param req
 * @returns {Promise<{payload: *, project}>}
 */
async function packageComponent(req) {
	if (req.project) {
		req.project = path.parse(req.project).name;
	}

	const validation = validator.packageComponentValidator(req);
	if (validation) {
		throw handleHDBError(validation, validation.message, HTTP_STATUS_CODES.BAD_REQUEST);
	}

	const cf_dir = env.get(terms.HDB_SETTINGS_NAMES.CUSTOM_FUNCTIONS_DIRECTORY_KEY);
	const { project } = req;
	log.trace(`packaging component`, project);

	let path_to_project;
	try {
		path_to_project = await fs.realpath(path.join(cf_dir, project));
	} catch (err) {
		if (err.code !== terms.NODE_ERROR_CODES.ENOENT) throw err;
		try {
			path_to_project = await fs.realpath(path.join(env.get(terms.CONFIG_PARAMS.ROOTPATH), 'node_modules', project));
		} catch (err) {
			if (err.code === terms.NODE_ERROR_CODES.ENOENT) throw new Error(`Unable to locate project '${project}'`);
		}
	}

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
	await fs.remove(file);

	// return the package payload as base64-encoded string
	return { project, payload };
}

/**
 * Can deploy a component in multiple ways. If a 'package' is provided all it will do is write that package to
 * harperdb-config, when HDB is restarted the package will be installed in hdb/node_modules. If a base64 encoded string is passed it
 * will write string to a tar file in the hdb/components dir. When deploying with a payload and bypass_config: true
 * is provided it will extract the tar in hdb/components. If bypass_config is false it will not extract tar file but
 * instead add ref to it in harper-config which will install the component in hdb/node_modules on restart/run
 * @param req
 * @returns {Promise<string>}
 */
async function deployComponent(req) {
	if (req.project) {
		req.project = path.parse(req.project).name;
	}

	const validation = validator.deployComponentValidator(req);
	if (validation) {
		throw handleHDBError(validation, validation.message, HTTP_STATUS_CODES.BAD_REQUEST);
	}

	const cf_dir = env.get(terms.HDB_SETTINGS_NAMES.CUSTOM_FUNCTIONS_DIRECTORY_KEY);
	let { project, payload, package: pkg, bypass_config } = req;
	log.trace(`deploying component`, project);
	bypass_config = bypass_config === true;

	if (bypass_config && pkg) {
		throw new Error('Cannot bypass_config when deploying with a package');
	}

	if (!payload && !pkg) {
		throw new Error("'payload' or 'package' must be provided");
	}

	if (!bypass_config) {
		if (payload) {
			pkg = path.join(cf_dir, project + '.tar');
			await fs.outputFile(pkg, payload, { encoding: 'base64' });
		}

		// Adds package to harperdb-config and then relies on restart to call install on the new app
		config_utils.updateConfigValue(`${project}_package`, pkg, undefined, false, false, true);
	} else {
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

		// HDB will package a component into a 'package` folder, this is done for npm install,
		// however if we are here npm install is not being used, so we copy/remove component code up one dir.
		const dir = await fs.readdir(path_to_project);
		if (
			(dir.length === 1 && dir.includes('package')) ||
			(dir.length === 2 && dir.includes('package') && dir.includes('.DS_Store'))
		) {
			await fs.copy(path.join(path_to_project, 'package'), path_to_project);
			await fs.remove(path.join(path_to_project, 'package'));
		}
	}

	return `Successfully deployed: ${project}`;
}

/**
 * Gets a JSON directory tree of the components dir and all nested files/folders
 * @returns {Promise<*>}
 */
async function getComponents() {
	const all_config = config_utils.getConfiguration();
	let comps = [];
	for (const element in all_config) {
		if (all_config[element]?.package) {
			comps.push(Object.assign(all_config[element], { name: element }));
		}
	}

	// Recursive function that will traverse the components dir and build json
	// directory tree as it goes.
	const walk_dir = async (dir, result) => {
		const list = await fs.readdir(dir, { withFileTypes: true });
		for (let item of list) {
			const item_name = item.name;
			if (item_name.startsWith('.') || item_name === 'node_modules') continue;
			const item_path = path.join(dir, item_name);
			if (await item.isDirectory()) {
				let res = {
					name: item_name,
					entries: [],
				};
				result.entries.push(res);
				await walk_dir(item_path, res);
			} else {
				const stats = await fs.stat(item_path);
				const res = {
					name: path.basename(item_name),
					mtime: stats.mtime,
					size: stats.size,
				};
				result.entries.push(res);
			}
		}
		return result;
	};

	return walk_dir(env.get(terms.CONFIG_PARAMS.CUSTOMFUNCTIONS_ROOT), {
		name: env.get(terms.CONFIG_PARAMS.CUSTOMFUNCTIONS_ROOT).split(path.sep).slice(-1).pop(),
		entries: comps,
	});
}

/**
 * Gets the contents of a component file
 * @param req
 * @returns {Promise<*>}
 */
async function getComponentFile(req) {
	const validation = validator.getComponentFileValidator(req);
	if (validation) {
		throw handleHDBError(validation, validation.message, HTTP_STATUS_CODES.BAD_REQUEST);
	}

	const options = req.encoding ? { encoding: req.encoding } : { encoding: 'utf8' };
	try {
		return await fs.readFile(
			path.join(env.get(terms.CONFIG_PARAMS.CUSTOMFUNCTIONS_ROOT), req.project, req.file),
			options
		);
	} catch (err) {
		if (err.code === terms.NODE_ERROR_CODES.ENOENT) {
			throw new Error(`Component file not found '${path.join(req.project, req.file)}'`);
		}
		throw err;
	}
}

/**
 * Used to update or create a component file
 * @param req
 * @returns {Promise<string>}
 */
async function setComponentFile(req) {
	const validation = validator.setComponentFileValidator(req);
	if (validation) {
		throw handleHDBError(validation, validation.message, HTTP_STATUS_CODES.BAD_REQUEST);
	}

	const options = req.encoding ? { encoding: req.encoding } : { encoding: 'utf8' };
	const path_to_comp = path.join(env.get(terms.CONFIG_PARAMS.CUSTOMFUNCTIONS_ROOT), req.project, req.file);
	await fs.ensureFile(path_to_comp);
	await fs.outputFile(path_to_comp, req.payload, options);
	return `Successfully set component: ` + req.file;
}

module.exports = {
	customFunctionsStatus,
	getCustomFunctions,
	getCustomFunction,
	setCustomFunction,
	dropCustomFunction,
	addComponent,
	dropCustomFunctionProject,
	packageComponent,
	deployComponent,
	getComponents,
	getComponentFile,
	setComponentFile,
};
