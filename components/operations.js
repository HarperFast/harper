'use strict';

const fs = require('fs-extra');
const fg = require('fast-glob');
const path = require('path');
const tar = require('tar-fs');
const gunzip = require('gunzip-maybe');
const uuidV4 = require('uuid').v4;
const normalize = require('normalize-path');

const validator = require('./operationsValidation');
const log = require('../utility/logging/harper_logger');
const terms = require('../utility/hdbTerms');
const env = require('../utility/environment/environmentManager');
const config_utils = require('../config/configUtils');
const hdb_utils = require('../utility/common_utils');
const { PACKAGE_ROOT } = require('../utility/hdbTerms');
const { handleHDBError, hdb_errors, ClientError } = require('../utility/errors/hdbError');
const { basename } = require('path');
const installComponents = require('../components/installComponents');
const eng_mgr = require('../utility/environment/environmentManager');
const hdb_terms = require('../utility/hdbTerms');
const { Readable } = require('stream');
const { isMainThread } = require('worker_threads');
const { HDB_ERROR_MSGS, HTTP_STATUS_CODES } = hdb_errors;
const manage_threads = require('../server/threads/manageThreads');
const { replicateOperation } = require('../server/replication/replicator');
const { packageDirectory } = require('../components/packageComponent');
const { installModules } = require('../utility/npmUtilities');
const npm_utils = require('../utility/npmUtilities');
const APPLICATION_TEMPLATE = path.join(PACKAGE_ROOT, 'application-template');
const TMP_PATH = path.join(env.get(terms.HDB_SETTINGS_NAMES.HDB_ROOT_KEY), 'tmp');
const root_dir = env.get(terms.CONFIG_PARAMS.ROOTPATH);
const ssh_dir = path.join(root_dir, 'ssh');
const known_hosts_file = path.join(ssh_dir, 'known_hosts');

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
			port: env.get(terms.CONFIG_PARAMS.HTTP_PORT),
			directory: env.get(terms.CONFIG_PARAMS.COMPONENTSROOT),
			is_enabled: true,
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
	const dir = env.get(terms.CONFIG_PARAMS.COMPONENTSROOT);

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
	const cf_dir = env.get(terms.CONFIG_PARAMS.COMPONENTSROOT);
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
 * @returns {{message:string}}
 */
async function setCustomFunction(req) {
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
	const cf_dir = env.get(terms.CONFIG_PARAMS.COMPONENTSROOT);
	const { project, type, file, function_content } = req;

	try {
		fs.outputFileSync(path.join(cf_dir, project, type, file + '.js'), function_content);
		let response = await replicateOperation(req);
		response.message = `Successfully updated custom function: ${file}.js`;
		return response;
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
 * @returns {{message:string}}
 */
async function dropCustomFunction(req) {
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
	const cf_dir = env.get(terms.CONFIG_PARAMS.COMPONENTSROOT);
	const { project, type, file } = req;

	try {
		fs.unlinkSync(path.join(cf_dir, project, type, file + '.js'));
		let response = await replicateOperation(req);
		response.message = `Successfully deleted custom function: ${file}.js`;
		return response;
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
 * @returns {{message:string}}
 */
async function addComponent(req) {
	if (req.project) {
		req.project = path.parse(req.project).name;
	}

	const validation = validator.addComponentValidator(req);
	if (validation) {
		throw handleHDBError(validation, validation.message, HTTP_STATUS_CODES.BAD_REQUEST);
	}

	log.trace(`adding component`);
	const cf_dir = env.get(terms.CONFIG_PARAMS.COMPONENTSROOT);
	const { project } = req;

	try {
		const project_dir = path.join(cf_dir, project);
		fs.mkdirSync(project_dir, { recursive: true });
		fs.copySync(APPLICATION_TEMPLATE, project_dir);
		let response = await replicateOperation(req);
		response.message = `Successfully added project: ${project}`;
		return response;
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
async function dropCustomFunctionProject(req) {
	if (req.project) {
		req.project = path.parse(req.project).name;
	}

	const validation = validator.dropCustomFunctionProjectValidator(req);
	if (validation) {
		throw handleHDBError(validation, validation.message, HTTP_STATUS_CODES.BAD_REQUEST);
	}

	log.trace(`dropping custom function project`);
	const cf_dir = env.get(terms.CONFIG_PARAMS.COMPONENTSROOT);
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
		let response = await replicateOperation(req);
		response.message = `Successfully deleted project: ${project}`;
		return response;
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

	const cf_dir = env.get(terms.CONFIG_PARAMS.COMPONENTSROOT);
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

	const payload = (await packageDirectory(path_to_project, req)).toString('base64');

	// return the package payload as base64-encoded string
	return { project, payload };
}

/**
 * Can deploy a component in multiple ways. If a 'package' is provided all it will do is write that package to
 * harperdb-config, when HDB is restarted the package will be installed in hdb/node_modules. If a base64 encoded string is passed it
 * will write string to a temp tar file and extract that file into the deployed project in hdb/components.
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

	const cf_dir = env.get(terms.CONFIG_PARAMS.COMPONENTSROOT);
	let { project, payload, package: pkg } = req;
	log.trace(`deploying component`, project);

	if (!payload && !pkg) {
		throw new Error("'payload' or 'package' must be provided");
	}
	let path_to_project;
	if (payload) {
		path_to_project = path.join(cf_dir, project);
		pkg = 'file:' + path_to_project;
		// check if the project exists, if it doesn't, create it, if it does, empty it.
		await fs.emptyDir(path_to_project);

		// extract the reconstituted file to the proper project directory
		const stream = Readable.from(payload instanceof Buffer ? payload : Buffer.from(payload, 'base64'));
		await new Promise((resolve, reject) => {
			stream
				.pipe(gunzip())
				.pipe(tar.extract(path_to_project, { finish: resolve }))
				.on('error', reject);
		});

		const comp_dir = await fs.readdir(path_to_project);
		if (comp_dir.length === 1 && comp_dir[0] === 'package') {
			await fs.copy(path.join(path_to_project, 'package'), path_to_project);
			await fs.remove(path.join(path_to_project, 'package'));
		}
		// if we have a node_modules folder, we assume we have our own modules, and we don't need to npm install them
		const node_modules_path = path.join(path_to_project, 'node_modules');
		if (!fs.existsSync(node_modules_path)) {
			// if the package came with node_modules, we don't need to npm install
			// them, but otherwise we do
			const npm_utils = require('../utility/npmUtilities');
			await npm_utils.installAllRootModules(false, path_to_project);
		}
	} else {
		// Adds package to harperdb-config and then relies on restart to call install on the new app
		await config_utils.addConfig(project, { package: pkg });

		// The main thread can install the components, but we do it here and now so that if it fails, we can immediately
		// know about it and report it.
		await installComponents();
		const root_path = eng_mgr.get(hdb_terms.CONFIG_PARAMS.ROOTPATH);
		path_to_project = path.join(root_path, 'node_modules', project);
	}

	// the main thread should never actually load component, just do a deploy
	if (isMainThread) return;
	// now we attempt to actually load the component in case there is
	// an error we can immediately detect and report
	const pseudo_resources = new Map();
	pseudo_resources.isWorker = true;
	const component_loader = require('./componentLoader');
	let last_error;
	component_loader.setErrorReporter((error) => (last_error = error));
	const component_name = basename(path_to_project);
	const original_error = component_loader.component_errors.get(component_name); // we don't want this to change to preserve
	// consistency with other threads
	try {
		await component_loader.loadComponent(path_to_project, pseudo_resources);
	} finally {
		component_loader.component_errors.set(component_name, original_error);
	}
	if (last_error) throw last_error;
	log.info('Installed component');
	let response = await replicateOperation(req);
	if (req.restart === true) {
		manage_threads.restartWorkers('http');
		response.message = `Successfully deployed: ${project}, restarting HarperDB`;
	} else response.message = `Successfully deployed: ${project}`;
	return response;
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
			// Do not return packages that are file paths.
			if (all_config[element].package.startsWith('file:')) {
				continue;
			}
			comps.push({ ...all_config[element], name: element });
		}
	}

	// Recursive function that will traverse the components dir and build json
	// directory tree as it goes.
	const walk_dir = async (dir, result) => {
		try {
			const list = await fs.readdir(dir, { withFileTypes: true });
			for (let item of list) {
				const item_name = item.name;
				if (item_name.startsWith('.') || item_name === 'node_modules') continue;
				const item_path = path.join(dir, item_name);
				if (item.isDirectory() || item.isSymbolicLink()) {
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
		} catch (error) {
			log.warn('Error loading package', error);
			return { error: error.toString(), entries: [] };
		}
	};

	const results = await walk_dir(env.get(terms.CONFIG_PARAMS.COMPONENTSROOT), {
		name: env.get(terms.CONFIG_PARAMS.COMPONENTSROOT).split(path.sep).slice(-1).pop(),
		entries: comps,
	});

	for (const c of results.entries) {
		if (c.package) {
			const c_dir = await walk_dir(path.join(env.get(terms.CONFIG_PARAMS.ROOTPATH), 'node_modules', c.name), {
				name: c.name,
				entries: [],
			});
			Object.assign(c, c_dir);
		}
	}

	const component_loader = require('./componentLoader');
	const component_errors = component_loader.component_errors;
	for (const component of comps) {
		const error = component_errors.get(component.name);
		// if it is loaded properly, this should be false
		if (error) component.error = component_errors.get(component.name);
		else if (error === undefined) component.error = 'The component has not been loaded yet (may need a restart)';
	}
	return results;
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

	// If comp is in config we know it is a referenced comp and lives in node_modules
	const config_obj = config_utils.getConfigObj();
	const comp_root =
		config_obj[req.project] || req.project === 'harperdb'
			? path.join(eng_mgr.get(terms.CONFIG_PARAMS.ROOTPATH), 'node_modules')
			: env.get(terms.CONFIG_PARAMS.COMPONENTSROOT);
	const options = req.encoding ? { encoding: req.encoding } : { encoding: 'utf8' };

	try {
		const stats = await fs.stat(path.join(comp_root, req.project, req.file));
		return {
			message: await fs.readFile(path.join(comp_root, req.project, req.file), options),
			size: stats.size,
			birthtime: stats.birthtime,
			mtime: stats.mtime,
		};
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
 * @returns {Promise<{message:string}>}
 */
async function setComponentFile(req) {
	const validation = validator.setComponentFileValidator(req);
	if (validation) {
		throw handleHDBError(validation, validation.message, HTTP_STATUS_CODES.BAD_REQUEST);
	}

	const options = req.encoding ? { encoding: req.encoding } : { encoding: 'utf8' };
	const path_to_comp = path.join(env.get(terms.CONFIG_PARAMS.COMPONENTSROOT), req.project, req.file);
	if (req.payload !== undefined) {
		await fs.ensureFile(path_to_comp);
		await fs.outputFile(path_to_comp, req.payload, options);
	} else {
		await fs.ensureDir(path_to_comp);
	}
	let response = await replicateOperation(req);
	response.message = `Successfully set component: ` + req.file;
	return response;
}

/**
 * Deletes a component dir/file
 * @param req
 * @returns {Promise<{message:string}>}
 */
async function dropComponent(req) {
	const validation = validator.dropComponentFileValidator(req);
	if (validation) {
		throw handleHDBError(validation, validation.message, HTTP_STATUS_CODES.BAD_REQUEST);
	}

	const { project, file } = req;
	const project_path = req.file ? path.join(project, file) : project;
	const path_to_comp = path.join(env.get(terms.CONFIG_PARAMS.COMPONENTSROOT), project_path);

	const componentSymlink = path.join(env.get(terms.CONFIG_PARAMS.ROOTPATH), 'node_modules', project);
	if (await fs.pathExists(componentSymlink)) {
		await fs.unlink(componentSymlink);
	} else {
		throw new ClientError(`Component not found: ${project}`, HTTP_STATUS_CODES.NOT_FOUND);
	}

	if (await fs.pathExists(path_to_comp)) {
		await fs.remove(path_to_comp);
	}

	// Remove the component from the package.json file
	const packageJsonPath = path.join(env.get(terms.CONFIG_PARAMS.ROOTPATH), 'package.json');
	if (await fs.pathExists(packageJsonPath)) {
		const packageJson = JSON.parse(await fs.readFile(packageJsonPath, 'utf8'));
		if (packageJson?.dependencies?.[project]) {
			delete packageJson.dependencies[project];
		}
		await fs.writeFile(packageJsonPath, JSON.stringify(packageJson, null, 2), 'utf8');
	}

	config_utils.deleteConfigFromFile([project]);
	let response = await replicateOperation(req);
	response.message = 'Successfully dropped: ' + project_path;
	return response;
}

async function addSSHKey(req) {
	const validation = validator.addSSHKeyValidator(req);
	if (validation) {
		throw handleHDBError(validation, validation.message, HTTP_STATUS_CODES.BAD_REQUEST);
	}
	let { name, key, host, hostname, known_hosts } = req;
	log.trace(`adding ssh key`, name);

	const file_path = path.join(ssh_dir, name + '.key');
	const config_file = path.join(ssh_dir, 'config');

	// Check if the key already exists
	if (await fs.pathExists(file_path)) {
		throw new Error('Key already exists. Use update_ssh_key or delete_ssh_key and then add_ssh_key');
	}

	// Create the key file
	await fs.outputFile(file_path, key);
	await fs.chmod(file_path, '0600');

	// Build the config block string
	const config_block = `#${name}
Host ${host}
	HostName ${hostname}
	User git
	IdentityFile ${file_path}
	IdentitiesOnly yes`;

	// If the file already exists, add a new config block, otherwise write the file for the first time
	if (await fs.pathExists(config_file)) {
		await fs.appendFile(config_file, '\n' + config_block);
	} else {
		await fs.outputFile(config_file, config_block);
	}

	let additional_message = '';

	// Create the known_hosts file and set permissions if missing
	if (!(await fs.pathExists(known_hosts_file))) {
		await fs.writeFile(known_hosts_file, '');
		await fs.chmod(known_hosts_file, '0600');
	}

	// If adding a github.com ssh key download it automatically
	if (hostname == 'github.com') {
		const file_contents = await fs.readFile(known_hosts_file, 'utf8');

		// Check if there's already github.com entries
		if (!file_contents.includes('github.com')) {
			try {
				const response = await fetch('https://api.github.com/meta');
				const resp_json = await response.json();
				const ssh_keys = resp_json['ssh_keys'];
				for (let known_host of ssh_keys) {
					fs.appendFile(known_hosts_file, 'github.com ' + known_host + '\n');
				}
			} catch (err) {
				additional_message =
					'. Unable to get known hosts from github.com. Set your known hosts manually using set_ssh_known_hosts.';
			}
		}
	}

	if (known_hosts) {
		await fs.appendFile(known_hosts_file, known_hosts);
	}
	let response = await replicateOperation(req);
	response.message = `Added ssh key: ${name}${additional_message}`;
	return response;
}

async function updateSSHKey(req) {
	const validation = validator.updateSSHKeyValidator(req);
	if (validation) {
		throw handleHDBError(validation, validation.message, HTTP_STATUS_CODES.BAD_REQUEST);
	}
	let { name, key } = req;
	log.trace(`updating ssh key`, name);

	const file_path = path.join(ssh_dir, name + '.key');
	if (!(await fs.pathExists(file_path))) {
		throw new Error('Key does not exist. Use add_ssh_key');
	}

	await fs.outputFile(file_path, key);
	let response = await replicateOperation(req);
	response.message = `Updated ssh key: ${name}`;
	return response;
}

async function deleteSSHKey(req) {
	const validation = validator.deleteSSHKeyValidator(req);
	if (validation) {
		throw handleHDBError(validation, validation.message, HTTP_STATUS_CODES.BAD_REQUEST);
	}
	let { name } = req;
	log.trace(`deleting ssh key`, name);

	const file_path = path.join(ssh_dir, name + '.key');
	const config_file = path.join(ssh_dir, 'config');

	if (!(await fs.pathExists(file_path))) {
		throw new Error('Key does not exist');
	}

	let file_contents = await fs.readFile(config_file, 'utf8');

	let config_block_regex = new RegExp(`#${name}[\\S\\s]*?IdentitiesOnly yes`, 'g');
	file_contents = file_contents.replace(config_block_regex, '');

	await fs.outputFile(config_file, file_contents);
	fs.removeSync(file_path);
	let response = await replicateOperation(req);
	response.message = `Deleted ssh key: ${name}`;
	return response;
}

async function listSSHKeys(req) {
	let results = [];
	if (await fs.pathExists(ssh_dir)) {
		(await fs.readdir(ssh_dir)).forEach((file) => {
			if (file != 'known_hosts' && file != 'config') {
				results.push({ name: file.split('.')[0] });
			}
		});
	}

	return results;
}

async function setSSHKnownHosts(req) {
	const validation = validator.setSSHKnownHostsValidator(req);
	if (validation) {
		throw handleHDBError(validation, validation.message, HTTP_STATUS_CODES.BAD_REQUEST);
	}
	let { known_hosts } = req;

	await fs.outputFile(known_hosts_file, known_hosts);
	let response = await replicateOperation(req);
	response.message = `Known hosts successfully set`;
	return response;
}

async function getSSHKnownHosts(req) {
	if (!(await fs.pathExists(known_hosts_file))) {
		return { known_hosts: null };
	}
	return { known_hosts: await fs.readFile(known_hosts_file, 'utf8') };
}

Object.assign(exports, {
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
	dropComponent,
	addSSHKey,
	updateSSHKey,
	deleteSSHKey,
	listSSHKeys,
	setSSHKnownHosts,
	getSSHKnownHosts,
});
