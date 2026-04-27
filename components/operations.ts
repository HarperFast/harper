'use strict';

import path from 'node:path';
import { isMainThread } from 'node:worker_threads';
import fs from 'fs-extra';
import fg from 'fast-glob';
import normalize from 'normalize-path';
import * as validator from './operationsValidation.js';
import * as log from '../utility/logging/harper_logger.js';
import * as hdbTerms from '../utility/hdbTerms.js';
import * as env from '../utility/environment/environmentManager.js';
import * as configUtils from '../config/configUtils.js';
import * as hdbUtils from '../utility/common_utils.js';
import { handleHDBError, hdbErrors } from '../utility/errors/hdbError.js';
const { HDB_ERROR_MSGS, HTTP_STATUS_CODES } = hdbErrors;
import * as manageThreads from '../server/threads/manageThreads.js';
import { packageDirectory } from '../components/packageComponent.js';
import { Resources } from '../resources/Resources.js';
import { Application, prepareApplication } from './Application.js';
import { server } from '../server/Server.js';
import { TRUSTED_RESOURCE_PLUGINS } from './componentLoader.js';
import * as componentLoader from './componentLoader.js';
import * as serverUtilities from '../server/serverHelpers/serverUtilities.js';
import { internal as statusInternal } from './status/index.js';

/**
 * Read the settings.js file and return the
 *
 * @return Object.<String>
 */
export function customFunctionsStatus(): any {
	log.trace(`getting custom api status`);
	let response = {};

	try {
		response = {
			port: env.get(hdbTerms.CONFIG_PARAMS.HTTP_PORT),
			directory: configUtils.getConfigPath(hdbTerms.CONFIG_PARAMS.COMPONENTSROOT),
			is_enabled: true,
		};
	} catch (err) {
		throw handleHDBError(
			new Error(),
			HDB_ERROR_MSGS.FUNCTION_STATUS,
			HTTP_STATUS_CODES.INTERNAL_SERVER_ERROR,
			log.ERR,
			err as any
		);
	}
	return response;
}

/**
 * Read the user-defined custom_functions/routes directory and return the file names
 *
 * @return Array.<String>
 */
export function getCustomFunctions(): any {
	log.trace(`getting custom api endpoints`);
	let response: any = {};
	const dir = configUtils.getConfigPath(hdbTerms.CONFIG_PARAMS.COMPONENTSROOT);

	try {
		const projectFolders = fg.sync(normalize(`${dir}/*`), { onlyDirectories: true });

		projectFolders.forEach((projectFolder) => {
			const folderName = projectFolder.split('/').pop() as any;
			response[folderName] = {
				routes: fg
					.sync(normalize(`${projectFolder}/routes/*.js`))
					.map((filepath) => filepath.split('/').pop()!.split('.js')[0]),
				helpers: fg
					.sync(normalize(`${projectFolder}/helpers/*.js`))
					.map((filepath) => filepath.split('/').pop()!.split('.js')[0]),
			};
		});
	} catch (err) {
		throw handleHDBError(
			new Error(),
			HDB_ERROR_MSGS.GET_FUNCTIONS,
			HTTP_STATUS_CODES.INTERNAL_SERVER_ERROR,
			log.ERR,
			err as any
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
export function getCustomFunction(req: any): string {
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
	const cfDir = configUtils.getConfigPath(hdbTerms.CONFIG_PARAMS.COMPONENTSROOT);
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
			err as any
		);
	}
}

/**
 * Write the supplied function_content to the provided functionName file in the custom_functions/routes directory
 *
 * @param {NodeObject} req
 * @returns {{message:string}}
 */
export async function setCustomFunction(req: any): Promise<any> {
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
	const cfDir = configUtils.getConfigPath(hdbTerms.CONFIG_PARAMS.COMPONENTSROOT);
	const { project, type, file, function_content } = req;

	try {
		fs.outputFileSync(path.join(cfDir, project, type, file + '.js'), function_content);
		let response = await server.replication.replicateOperation(req);
		response.message = `Successfully updated custom function: ${file}.js`;
		return response;
	} catch (err) {
		throw handleHDBError(
			new Error(),
			HDB_ERROR_MSGS.SET_FUNCTION,
			HTTP_STATUS_CODES.INTERNAL_SERVER_ERROR,
			log.ERR,
			err as any
		);
	}
}

/**
 * Delete the provided functionName file from the custom_functions/routes directory
 *
 * @param {NodeObject} req
 * @returns {{message:string}}
 */
export async function dropCustomFunction(req: any): Promise<any> {
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
	const cfDir = configUtils.getConfigPath(hdbTerms.CONFIG_PARAMS.COMPONENTSROOT);
	const { project, type, file } = req;

	try {
		fs.unlinkSync(path.join(cfDir, project, type, file + '.js'));
		let response = await server.replication.replicateOperation(req);
		response.message = `Successfully deleted custom function: ${file}.js`;
		return response;
	} catch (err) {
		throw handleHDBError(
			new Error(),
			HDB_ERROR_MSGS.DROP_FUNCTION,
			HTTP_STATUS_CODES.INTERNAL_SERVER_ERROR,
			log.ERR,
			err as any
		);
	}
}

/**
 * Create a new project folder in the components folder and copy the template into it
 * @param {NodeObject} req
 * @returns {{message:string}}
 */
export async function addComponent(req: any): Promise<any> {
	if (req.project) {
		req.project = path.parse(req.project).name;
	}

	const validation = validator.addComponentValidator(req);
	if (validation) {
		throw handleHDBError(validation, validation.message, HTTP_STATUS_CODES.BAD_REQUEST);
	}

	log.trace(`adding component`);
	const cfDir = configUtils.getConfigPath(hdbTerms.CONFIG_PARAMS.COMPONENTSROOT);
	const { project, install_command, install_timeout } = req;

	const template = req.template || 'https://github.com/harperdb/application-template';

	try {
		const projectDir = path.join(cfDir, project);
		fs.mkdirSync(projectDir, { recursive: true });
		const application = new Application({
			name: project,
			packageIdentifier: template,
			install: {
				command: install_command,
				timeout: install_timeout,
			},
		});
		await prepareApplication(application);
		let response = await server.replication.replicateOperation(req);
		response.message = `Successfully added project: ${project}`;
		return response;
	} catch (err) {
		throw handleHDBError(
			new Error(),
			HDB_ERROR_MSGS.ADD_FUNCTION,
			HTTP_STATUS_CODES.INTERNAL_SERVER_ERROR,
			log.ERR,
			err as any
		);
	}
}

/**
 * Remove a project folder from the custom_functions folder
 *
 * @param {NodeObject} req
 * @returns {string}
 */
export async function dropCustomFunctionProject(req: any): Promise<any> {
	if (req.project) {
		req.project = path.parse(req.project).name;
	}

	const validation = validator.dropCustomFunctionProjectValidator(req);
	if (validation) {
		throw handleHDBError(validation, validation.message, HTTP_STATUS_CODES.BAD_REQUEST);
	}

	log.trace(`dropping custom function project`);
	const cfDir = configUtils.getConfigPath(hdbTerms.CONFIG_PARAMS.COMPONENTSROOT);
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
		let response = await server.replication.replicateOperation(req);
		response.message = `Successfully deleted project: ${project}`;
		return response;
	} catch (err) {
		throw handleHDBError(
			new Error(),
			HDB_ERROR_MSGS.DROP_FUNCTION_PROJECT,
			HTTP_STATUS_CODES.INTERNAL_SERVER_ERROR,
			log.ERR,
			err as any
		);
	}
}

/**
 * Will package a component into a temp tar file then output that file as a base64 string.
 * Req can accept a skip_node_modules boolean which will skip the node mods when creating temp tar file.
 * @param req
 * @returns {Promise<{payload: *, project}>}
 */
export async function packageComponent(req: any): Promise<any> {
	if (req.project) {
		req.project = path.parse(req.project).name;
	}

	const validation = validator.packageComponentValidator(req);
	if (validation) {
		throw handleHDBError(validation, validation.message, HTTP_STATUS_CODES.BAD_REQUEST);
	}

	const cfDir = configUtils.getConfigPath(hdbTerms.CONFIG_PARAMS.COMPONENTSROOT);
	const { project } = req;
	log.trace(`packaging component`, project);

	let pathToProject;
	try {
		pathToProject = await fs.realpath(path.join(cfDir, project));
	} catch (err: any) {
		if (err.code !== hdbTerms.NODE_ERROR_CODES.ENOENT) throw err;
		try {
			pathToProject = await fs.realpath(path.join(env.get(hdbTerms.CONFIG_PARAMS.ROOTPATH), 'node_modules', project));
		} catch (err: any) {
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
export async function deployComponent(req: any): Promise<any> {
	if (req.project) {
		req.project = path.parse(req.project).name;
	} else if (req.package) {
		req.project = getProjectNameFromPackage(req.package);
	}

	const validation = validator.deployComponentValidator(req);
	if (validation) {
		throw handleHDBError(validation, validation.message, HTTP_STATUS_CODES.BAD_REQUEST);
	}

	// Write to root config if the request contains a package identifier
	// TODO: how can we keep record of the `payload`? Its often too large to stuff into a config file; especially the root config. Maybe we can write it to a file and reference that way?
	if (req.package) {
        if (TRUSTED_RESOURCE_PLUGINS[req.project] && !req.force) {
			throw handleHDBError(
				new Error(),
				`Cannot deploy component with name '${req.project}': this is a protected core component name. Use force: true to overwrite.`,
				HTTP_STATUS_CODES.CONFLICT
			);
		}

        const applicationConfig: any = { package: req.package };
        // Avoid writing an empty `install:` block
        if (req.install_command || req.install_timeout) {
			applicationConfig.install = {
				command: req.install_command,
				timeout: req.install_timeout,
			};
		}
        await configUtils.addConfig(req.project, applicationConfig);
    }

	const application = new Application({
		name: req.project,
		payload: req.payload,
		packageIdentifier: req.package,
		install: {
			command: req.install_command,
			timeout: req.install_timeout,
		},
	});

	await prepareApplication(application);

	// the main thread should never actually load component, just do a deploy
	if (isMainThread) return;

	// now we attempt to actually load the component in case there is
	// an error we can immediately detect and report
	const pseudoResources = new Resources();
	pseudoResources.isWorker = true;

	if (!process.env.HARPER_SAFE_MODE) {
        let lastError;
        componentLoader.setErrorReporter((error: any) => (lastError = error));
        await componentLoader.loadComponent(
			application.dirPath,
			pseudoResources,
			undefined,
			false,
			undefined,
			false,
			req.project
		);

        if (lastError) throw lastError;
    }
	const rollingRestart = req.restart === 'rolling';
	// if doing a rolling restart set restart to false so that other nodes don't also restart.
	req.restart = rollingRestart ? false : req.restart;
	let response = await server.replication.replicateOperation(req);
	if (req.restart === true) {
		manageThreads.restartWorkers('http');
		response.message = `Successfully deployed: ${application.name}, restarting Harper`;
	} else if (rollingRestart) {
        const jobResponse = await serverUtilities.executeJob({
			operation: 'restart_service',
			service: 'http',
			replicated: true,
		});

        response.restartJobId = jobResponse.job_id;
        response.message = `Successfully deployed: ${application.name}, restarting Harper`;
    } else response.message = `Successfully deployed: ${application.name}`;

	return response;
}

/**
 * Extracts a project name from the specified package name or URL
 * @param {string} pkg - Package name or URL
 * @returns {string} The project name
 */
function getProjectNameFromPackage(pkg: string): string {
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
		} catch {
			//
		}
	}

	return path.basename(pkg);
}

/**
 * Gets a JSON directory tree of the components dir and all nested files/folders
 * @returns {Promise<*>}
 */
export async function getComponents(): Promise<any> {
    // Recursive function that will traverse the components dir and build json
    // directory tree as it goes.
    const rootConfig = configUtils.getConfiguration();
    const walkDir = async (dir: string, result: any): Promise<any> => {
		try {
			const list = await fs.readdir(dir, { withFileTypes: true });
			for (let item of list) {
				const itemName = item.name;
				if (itemName === 'node_modules') continue;
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
		} catch (error: any) {
			log.warn('Error loading package', error);
			return { error: error.toString(), entries: [] };
		}
	};

    const results = await walkDir(configUtils.getConfigPath(hdbTerms.CONFIG_PARAMS.COMPONENTSROOT), {
		name: configUtils.getConfigPath(hdbTerms.CONFIG_PARAMS.COMPONENTSROOT).split(path.sep).slice(-1).pop(),
		entries: [],
	});
    for (let entry of results.entries) {
		const sourcePackage = rootConfig[entry.name]?.package;
		if (sourcePackage) entry.package = sourcePackage;
	}

    let consolidatedStatuses;

    try {
		consolidatedStatuses = await statusInternal.ComponentStatusRegistry.getAggregatedFromAllThreads(
			statusInternal.componentStatusRegistry
		);
	} catch (error: any) {
		// If we can't get status from threads, continue with unknown statuses
		log.debug(`Failed to get component status from threads: ${error.message}`);
	}

    for (const component of results.entries) {
		try {
			component.status = await statusInternal.componentStatusRegistry.getAggregatedStatusFor(
				component.name,
				consolidatedStatuses
			);
		} catch (error: any) {
			log.debug(`Failed to get aggregated status for component ${component.name}: ${error.message}`);
			component.status = {
				status: 'unknown',
				message: 'Failed to retrieve component status',
				lastChecked: { workers: {} },
			};
		}
	}
    return results;
}

/**
 * Gets the contents of a component file
 * @param req
 * @returns {Promise<*>}
 */
export async function getComponentFile(req: any): Promise<any> {
	const validation = validator.getComponentFileValidator(req);
	if (validation) {
		throw handleHDBError(validation, validation.message, HTTP_STATUS_CODES.BAD_REQUEST);
	}

	const compRoot = configUtils.getConfigPath(hdbTerms.CONFIG_PARAMS.COMPONENTSROOT);
	const options = req.encoding ? { encoding: req.encoding } : { encoding: 'utf8' };

	try {
		const stats = await fs.stat(path.join(compRoot, req.project, req.file));
		return {
			message: await fs.readFile(path.join(compRoot, req.project, req.file), options),
			size: stats.size,
			birthtime: stats.birthtime,
			mtime: stats.mtime,
		};
	} catch (err: any) {
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
export async function setComponentFile(req: any): Promise<any> {
	const validation = validator.setComponentFileValidator(req);
	if (validation) {
		throw handleHDBError(validation, validation.message, HTTP_STATUS_CODES.BAD_REQUEST);
	}

	const options = req.encoding ? { encoding: req.encoding } : { encoding: 'utf8' };
	const pathToComp = path.join(configUtils.getConfigPath(hdbTerms.CONFIG_PARAMS.COMPONENTSROOT), req.project, req.file);
	if (req.payload !== undefined) {
		await fs.ensureFile(pathToComp);
		await fs.outputFile(pathToComp, req.payload, options);
	} else {
		await fs.ensureDir(pathToComp);
	}
	let response = await server.replication.replicateOperation(req);
	response.message = `Successfully set component: ` + req.file;
	return response;
}

/**
 * Deletes a component dir/file
 * @param req
 * @returns {Promise<{message:string}>}
 */
export async function dropComponent(req: any): Promise<any> {
	const validation = validator.dropComponentFileValidator(req);
	if (validation) {
		throw handleHDBError(validation, validation.message, HTTP_STATUS_CODES.BAD_REQUEST);
	}

	const { project, file } = req;
	const projectPath = req.file ? path.join(project, file) : project;
	const pathToComponent = path.join(configUtils.getConfigPath(hdbTerms.CONFIG_PARAMS.COMPONENTSROOT), projectPath);

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
	let response = await server.replication.replicateOperation(req);
	if (req.restart === true) {
		manageThreads.restartWorkers('http');
		response.message = `Successfully dropped: ${projectPath}, restarting Harper`;
	} else response.message = `Successfully dropped: ${projectPath}`;
	return response;
}
