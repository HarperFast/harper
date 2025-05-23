'use strict';

const fs = require('fs-extra');
const fg = require('fast-glob');
const path = require('path');
const tar = require('tar-fs');
const gunzip = require('gunzip-maybe');
const normalize = require('normalize-path');

const validator = require('./operationsValidation.js');
const log = require('../utility/logging/harper_logger.js');
const hdbTerms = require('../utility/hdbTerms.ts');
const env = require('../utility/environment/environmentManager.js');
const configUtils = require('../config/configUtils.js');
const hdbUtils = require('../utility/common_utils.js');
const { PACKAGE_ROOT } = require('../utility/packageUtils.js');
const { handleHDBError, hdbErrors } = require('../utility/errors/hdbError.js');
const { basename } = require('path');
const installComponents = require('../components/installComponents.js');
const engMgr = require('../utility/environment/environmentManager.js');
const { Readable } = require('stream');
const { isMainThread } = require('worker_threads');
const { HDB_ERROR_MSGS, HTTP_STATUS_CODES } = hdbErrors;
const manageThreads = require('../server/threads/manageThreads.js');
const { replicateOperation } = require('../server/replication/replicator.ts');
const { packageDirectory } = require('../components/packageComponent.ts');
const npmUtils = require('../utility/npmUtilities.js');
const APPLICATION_TEMPLATE = path.join(PACKAGE_ROOT, 'application-template');
const rootDir = env.get(hdbTerms.CONFIG_PARAMS.ROOTPATH);
const sshDir = path.join(rootDir, 'ssh');
const knownHostsFile = path.join(sshDir, 'known_hosts');

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
			port: env.get(hdbTerms.CONFIG_PARAMS.HTTP_PORT),
			directory: env.get(hdbTerms.CONFIG_PARAMS.COMPONENTSROOT),
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
	const dir = env.get(hdbTerms.CONFIG_PARAMS.COMPONENTSROOT);

	try {
		const projectFolders = fg.sync(normalize(`${dir}/*`), { onlyDirectories: true });

		projectFolders.forEach((projectFolder) => {
			const folderName = projectFolder.split('/').pop();
			response[folderName] = {
				routes: fg
					.sync(normalize(`${projectFolder}/routes/*.js`))
					.map((filepath) => filepath.split('/').pop().split('.js')[0]),
				helpers: fg
					.sync(normalize(`${projectFolder}/helpers/*.js`))
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
 * Read the specified functionName file in the custom_functions/routes directory and return the file content
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
	const cfDir = env.get(hdbTerms.CONFIG_PARAMS.COMPONENTSROOT);
	const { project, type, file } = req;
	const fileLocation = path.join(cfDir, project, type, file + '.js');

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
 * Write the supplied function_content to the provided functionName file in the custom_functions/routes directory
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
	const cfDir = env.get(hdbTerms.CONFIG_PARAMS.COMPONENTSROOT);
	const { project, type, file, function_content } = req;

	try {
		fs.outputFileSync(path.join(cfDir, project, type, file + '.js'), function_content);
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
 * Delete the provided functionName file from the custom_functions/routes directory
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
	const cfDir = env.get(hdbTerms.CONFIG_PARAMS.COMPONENTSROOT);
	const { project, type, file } = req;

	try {
		fs.unlinkSync(path.join(cfDir, project, type, file + '.js'));
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
	const cfDir = env.get(hdbTerms.CONFIG_PARAMS.COMPONENTSROOT);
	const { project } = req;

	try {
		const projectDir = path.join(cfDir, project);
		fs.mkdirSync(projectDir, { recursive: true });
		fs.copySync(APPLICATION_TEMPLATE, projectDir);
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
	const cfDir = env.get(hdbTerms.CONFIG_PARAMS.COMPONENTSROOT);
	const { project } = req;

	let apps = env.get(hdbTerms.CONFIG_PARAMS.APPS);
	if (!hdbUtils.isEmptyOrZeroLength(apps)) {
		let appFound = false;
		for (const [i, app] of apps.entries()) {
			if (app.name === project) {
				apps.splice(i, 1);
				appFound = true;
				break;
			}
		}

		if (appFound) {
			configUtils.updateConfigValue(hdbTerms.CONFIG_PARAMS.APPS, apps);

			return `Successfully deleted project: ${project}`;
		}
	}

	try {
		const projectDir = path.join(cfDir, project);
		fs.rmSync(projectDir, { recursive: true });
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
 * Req can accept a skipNodeModules boolean which will skip the node mods when creating temp tar file.
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

	const cfDir = env.get(hdbTerms.CONFIG_PARAMS.COMPONENTSROOT);
	const { project } = req;
	log.trace(`packaging component`, project);

	let pathToProject;
	try {
		pathToProject = await fs.realpath(path.join(cfDir, project));
	} catch (err) {
		if (err.code !== hdbTerms.NODE_ERROR_CODES.ENOENT) throw err;
		try {
			pathToProject = await fs.realpath(path.join(env.get(hdbTerms.CONFIG_PARAMS.ROOTPATH), 'node_modules', project));
		} catch (err) {
			if (err.code === hdbTerms.NODE_ERROR_CODES.ENOENT) throw new Error(`Unable to locate project '${project}'`);
		}
	}

	const payload = (await packageDirectory(pathToProject, req)).toString('base64');

	// return the package payload as base64-encoded string
	return { project, payload };
}

/**
 * Can deploy a component in multiple ways. If a 'package' is provided all it will do is write that package to
 * harperdb-config, when HDB is restarted the package will be installed in hdb/nodeModules. If a base64 encoded string is passed it
 * will write string to a temp tar file and extract that file into the deployed project in hdb/components.
 * @param req
 * @returns {Promise<string>}
 */
async function deployComponent(req) {
	if (req.project) {
		req.project = path.parse(req.project).name;
	} else if (req.package) {
		req.project = getProjectNameFromPackage(req.package);
	}

	const validation = validator.deployComponentValidator(req);
	if (validation) {
		throw handleHDBError(validation, validation.message, HTTP_STATUS_CODES.BAD_REQUEST);
	}

	const cfDir = env.get(hdbTerms.CONFIG_PARAMS.COMPONENTSROOT);
	let { project, payload, package: pkg, installCommand } = req;
	log.trace(`deploying component`, project);

	if (!payload && !pkg) {
		throw new Error("'payload' or 'package' must be provided");
	}
	let pathToProject;
	if (payload) {
		pathToProject = path.join(cfDir, project);
		pkg = 'file:' + pathToProject;
		// check if the project exists, if it doesn't, create it, if it does, empty it.
		await fs.emptyDir(pathToProject);

		// extract the reconstituted file to the proper project directory
		const stream = Readable.from(payload instanceof Buffer ? payload : Buffer.from(payload, 'base64'));
		await new Promise((resolve, reject) => {
			stream
				.pipe(gunzip())
				.pipe(tar.extract(pathToProject, { finish: resolve }))
				.on('error', reject);
		});

		const compDir = await fs.readdir(pathToProject);
		if (compDir.length === 1 && compDir[0] === 'package') {
			await fs.copy(path.join(pathToProject, 'package'), pathToProject);
			await fs.remove(path.join(pathToProject, 'package'));
		}
		const nodeModulesPath = path.join(pathToProject, 'node_modules');
		if (installCommand) {
			// if the user provided an install command, we run that instead of npm install at the root
			// TODO: When we support untrusted packages in a secure mode, we will need to deny this
			await npmUtils.runCommand(installCommand, pathToProject);
		}
		// if we have a nodeModules folder, we assume we have our own modules, and we don't need to npm install them
		else if (!fs.existsSync(nodeModulesPath)) {
			// if the package came with nodeModules, we don't need to npm install
			// them, but otherwise we do
			await npmUtils.installAllRootModules(false, pathToProject);
		}
	} else {
		// Adds package to harperdb-config and then relies on restart to call install on the new app
		await configUtils.addConfig(project, { package: pkg });

		// The main thread can install the components, but we do it here and now so that if it fails, we can immediately
		// know about it and report it.
		await installComponents();
		const rootPath = engMgr.get(hdbTerms.CONFIG_PARAMS.ROOTPATH);
		pathToProject = path.join(rootPath, 'node_modules', project);
	}

	// the main thread should never actually load component, just do a deploy
	if (isMainThread) return;
	// now we attempt to actually load the component in case there is
	// an error we can immediately detect and report
	const pseudoResources = new Map();
	pseudoResources.isWorker = true;
	const componentLoader = require('./componentLoader.ts');
	let lastError;
	componentLoader.setErrorReporter((error) => (lastError = error));
	const componentName = basename(pathToProject);
	const originalError = componentLoader.componentErrors.get(componentName); // we don't want this to change to preserve
	// consistency with other threads
	try {
		await componentLoader.loadComponent(pathToProject, pseudoResources);
	} finally {
		componentLoader.componentErrors.set(componentName, originalError);
	}
	if (lastError) throw lastError;
	log.info('Installed component');

	const rollingRestart = req.restart === 'rolling';
	// if doing a rolling restart set restart to false so that other nodes don't also restart.
	req.restart = rollingRestart ? false : req.restart;
	let response = await replicateOperation(req);
	if (req.restart === true) {
		manageThreads.restartWorkers('http');
		response.message = `Successfully deployed: ${project}, restarting HarperDB`;
	} else if (rollingRestart) {
		const serverUtilities = require('../server/serverHelpers/serverUtilities.ts');
		const jobResponse = await serverUtilities.executeJob({
			operation: 'restart_service',
			service: 'http',
			replicated: true,
		});

		response.restartJobId = jobResponse.job_id;
		response.message = `Successfully deployed: ${project}, restarting HarperDB`;
	} else response.message = `Successfully deployed: ${project}`;

	return response;
}

/**
 * Extracts a project name from the specified package name or URL
 * @param {string} pkg - Package name or URL
 * @returns {string} The project name
 */
function getProjectNameFromPackage(pkg) {
	if (pkg.startsWith('git+ssh://')) {
		return path.basename(pkg.split('#')[0].replace(/\.git$/, ''));
	}

	if (pkg.startsWith('http://') || pkg.startsWith('https://')) {
		return path.basename(new URL(pkg.replace(/\.git$/, '')).pathname);
	}

	if (pkg.startsWith('file://')) {
		try {
			const { name } = JSON.parse(fs.readFileSync(path.join(pkg, 'package.json'), 'utf8'));
			return path.basename(name);
		} catch {}
	}

	return path.basename(pkg);
}

/**
 * Gets a JSON directory tree of the components dir and all nested files/folders
 * @returns {Promise<*>}
 */
async function getComponents() {
	// Recursive function that will traverse the components dir and build json
	// directory tree as it goes.
	const walkDir = async (dir, result) => {
		try {
			const list = await fs.readdir(dir, { withFileTypes: true });
			for (let item of list) {
				const itemName = item.name;
				if (itemName.startsWith('.') || itemName === 'node_modules') continue;
				const itemPath = path.join(dir, itemName);
				if (item.isDirectory() || item.isSymbolicLink()) {
					let res = {
						name: itemName,
						entries: [],
					};
					result.entries.push(res);
					await walkDir(itemPath, res);
				} else {
					const stats = await fs.stat(itemPath);
					const res = {
						name: path.basename(itemName),
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

	const results = await walkDir(env.get(hdbTerms.CONFIG_PARAMS.COMPONENTSROOT), {
		name: env.get(hdbTerms.CONFIG_PARAMS.COMPONENTSROOT).split(path.sep).slice(-1).pop(),
		entries: [],
	});

	const componentLoader = require('./componentLoader.ts');
	const componentErrors = componentLoader.componentErrors;
	for (const component of results.entries) {
		const error = componentErrors.get(component.name);
		// if it is loaded properly, this should be false
		if (error) component.error = componentErrors.get(component.name);
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

	// If comp is in config we know it is a referenced comp and lives in nodeModules
	const configObj = configUtils.getConfigObj();
	const compRoot =
		configObj[req.project] || req.project === 'harperdb'
			? path.join(engMgr.get(hdbTerms.CONFIG_PARAMS.ROOTPATH), 'node_modules')
			: env.get(hdbTerms.CONFIG_PARAMS.COMPONENTSROOT);
	const options = req.encoding ? { encoding: req.encoding } : { encoding: 'utf8' };

	try {
		const stats = await fs.stat(path.join(compRoot, req.project, req.file));
		return {
			message: await fs.readFile(path.join(compRoot, req.project, req.file), options),
			size: stats.size,
			birthtime: stats.birthtime,
			mtime: stats.mtime,
		};
	} catch (err) {
		if (err.code === hdbTerms.NODE_ERROR_CODES.ENOENT) {
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
	const pathToComp = path.join(env.get(hdbTerms.CONFIG_PARAMS.COMPONENTSROOT), req.project, req.file);
	if (req.payload !== undefined) {
		await fs.ensureFile(pathToComp);
		await fs.outputFile(pathToComp, req.payload, options);
	} else {
		await fs.ensureDir(pathToComp);
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
	const projectPath = req.file ? path.join(project, file) : project;
	const pathToComponent = path.join(env.get(hdbTerms.CONFIG_PARAMS.COMPONENTSROOT), projectPath);

	const componentSymlink = path.join(env.get(hdbTerms.CONFIG_PARAMS.ROOTPATH), 'node_modules', project);
	if (await fs.pathExists(componentSymlink)) {
		await fs.unlink(componentSymlink);
	}

	if (await fs.pathExists(pathToComponent)) {
		await fs.remove(pathToComponent);
	}

	// Remove the component from the package.json file
	const packageJsonPath = path.join(env.get(hdbTerms.CONFIG_PARAMS.ROOTPATH), 'package.json');
	if (await fs.pathExists(packageJsonPath)) {
		const packageJson = JSON.parse(await fs.readFile(packageJsonPath, 'utf8'));
		if (packageJson?.dependencies?.[project]) {
			delete packageJson.dependencies[project];
		}
		await fs.writeFile(packageJsonPath, JSON.stringify(packageJson, null, 2), 'utf8');
	}

	configUtils.deleteConfigFromFile([project]);
	let response = await replicateOperation(req);
	if (req.restart === true) {
		manageThreads.restartWorkers('http');
		response.message = `Successfully dropped: ${projectPath}, restarting HarperDB`;
	} else response.message = `Successfully dropped: ${projectPath}`;
	return response;
}

async function addSSHKey(req) {
	const validation = validator.addSSHKeyValidator(req);
	if (validation) {
		throw handleHDBError(validation, validation.message, HTTP_STATUS_CODES.BAD_REQUEST);
	}
	let { name, key, host, hostname, known_hosts } = req;
	log.trace(`adding ssh key`, name);

	const filePath = path.join(sshDir, name + '.key');
	const config_file = path.join(sshDir, 'config');

	// Check if the key already exists
	if (await fs.pathExists(filePath)) {
		throw new Error('Key already exists. Use update_ssh_key or delete_ssh_key and then add_ssh_key');
	}

	// Create the key file
	await fs.outputFile(filePath, key);
	await fs.chmod(filePath, '0600');

	// Build the config block string
	const configBlock = `#${name}
Host ${host}
	HostName ${hostname}
	User git
	IdentityFile ${filePath}
	IdentitiesOnly yes`;

	// If the file already exists, add a new config block, otherwise write the file for the first time
	if (await fs.pathExists(config_file)) {
		await fs.appendFile(config_file, '\n' + configBlock);
	} else {
		await fs.outputFile(config_file, configBlock);
	}

	let additionalMessage = '';

	// Create the known_hosts file and set permissions if missing
	if (!(await fs.pathExists(knownHostsFile))) {
		await fs.writeFile(knownHostsFile, '');
		await fs.chmod(knownHostsFile, '0600');
	}

	// If adding a github.com ssh key download it automatically
	if (hostname == 'github.com') {
		const fileContents = await fs.readFile(knownHostsFile, 'utf8');

		// Check if there's already github.com entries
		if (!fileContents.includes('github.com')) {
			try {
				const response = await fetch('https://api.github.com/meta');
				const respJson = await response.json();
				const sshKeys = respJson['ssh_keys'];
				for (let knownHost of sshKeys) {
					fs.appendFile(knownHostsFile, 'github.com ' + knownHost + '\n');
				}
			} catch (err) {
				additionalMessage =
					'. Unable to get known hosts from github.com. Set your known hosts manually using set_ssh_known_hosts.';
			}
		}
	}

	if (known_hosts) {
		await fs.appendFile(knownHostsFile, known_hosts);
	}
	let response = await replicateOperation(req);
	response.message = `Added ssh key: ${name}${additionalMessage}`;
	return response;
}

async function updateSSHKey(req) {
	const validation = validator.updateSSHKeyValidator(req);
	if (validation) {
		throw handleHDBError(validation, validation.message, HTTP_STATUS_CODES.BAD_REQUEST);
	}
	let { name, key } = req;
	log.trace(`updating ssh key`, name);

	const filePath = path.join(sshDir, name + '.key');
	if (!(await fs.pathExists(filePath))) {
		throw new Error('Key does not exist. Use add_ssh_key');
	}

	await fs.outputFile(filePath, key);
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

	const filePath = path.join(sshDir, name + '.key');
	const config_file = path.join(sshDir, 'config');

	if (!(await fs.pathExists(filePath))) {
		throw new Error('Key does not exist');
	}

	let fileContents = await fs.readFile(config_file, 'utf8');

	let configBlockRegex = new RegExp(`#${name}[\\S\\s]*?IdentitiesOnly yes`, 'g');
	fileContents = fileContents.replace(configBlockRegex, '');

	await fs.outputFile(config_file, fileContents);
	fs.removeSync(filePath);
	let response = await replicateOperation(req);
	response.message = `Deleted ssh key: ${name}`;
	return response;
}

async function listSSHKeys(req) {
	let results = [];
	if (await fs.pathExists(sshDir)) {
		(await fs.readdir(sshDir)).forEach((file) => {
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

	await fs.outputFile(knownHostsFile, known_hosts);
	let response = await replicateOperation(req);
	response.message = `Known hosts successfully set`;
	return response;
}

async function getSSHKnownHosts(req) {
	if (!(await fs.pathExists(knownHostsFile))) {
		return { known_hosts: null };
	}
	return { known_hosts: await fs.readFile(knownHostsFile, 'utf8') };
}

exports.customFunctionsStatus = customFunctionsStatus;
exports.getCustomFunctions = getCustomFunctions;
exports.getCustomFunction = getCustomFunction;
exports.setCustomFunction = setCustomFunction;
exports.dropCustomFunction = dropCustomFunction;
exports.addComponent = addComponent;
exports.dropCustomFunctionProject = dropCustomFunctionProject;
exports.packageComponent = packageComponent;
exports.deployComponent = deployComponent;
exports.getComponents = getComponents;
exports.getComponentFile = getComponentFile;
exports.setComponentFile = setComponentFile;
exports.dropComponent = dropComponent;
exports.addSSHKey = addSSHKey;
exports.updateSSHKey = updateSSHKey;
exports.deleteSSHKey = deleteSSHKey;
exports.listSSHKeys = listSSHKeys;
exports.setSSHKnownHosts = setSSHKnownHosts;
exports.getSSHKnownHosts = getSSHKnownHosts;
