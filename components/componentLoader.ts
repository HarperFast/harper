import { readdirSync, promises, readFileSync, existsSync, symlinkSync, rmSync, mkdirSync, realpathSync } from 'fs';
import { join, relative, basename, dirname } from 'path';
import { isMainThread } from 'worker_threads';
import { parseDocument } from 'yaml';
import * as env from '../utility/environment/environmentManager';
import { PACKAGE_ROOT } from '../utility/packageUtils';
import { CONFIG_PARAMS, HDB_ROOT_DIR_NAME } from '../utility/hdbTerms';
import * as graphql_handler from '../resources/graphql';
import * as graphql_query_handler from '../server/graphqlQuerying';
import * as roles from '../resources/roles';
import * as js_handler from '../resources/jsResource';
import * as login from '../resources/login';
import * as REST from '../server/REST';
import * as fastify_routes_handler from '../server/fastifyRoutes';
import * as staticFiles from '../server/static';
import * as loadEnv from '../resources/loadEnv';
import fg from 'fast-glob';
import { watchDir, getWorkerIndex } from '../server/threads/manageThreads';
import harper_logger from '../utility/logging/harper_logger';
import { secureImport } from '../security/jsLoader';
import { server } from '../server/Server';
import { Resources } from '../resources/Resources';
import { handleHDBError } from '../utility/errors/hdbError';
import { table } from '../resources/databases';
import { startSocketServer } from '../server/threads/socketRouter';
import { getHdbBasePath } from '../utility/environment/environmentManager';
import * as operationsServer from '../server/operationsServer';
import * as auth from '../security/auth';
import * as natsReplicator from '../server/nats/natsReplicator';
import * as replication from '../server/replication/replicator';
import * as mqtt from '../server/mqtt';
import { getConfigObj, resolvePath } from '../config/configUtils';
import { createReuseportFd } from '../server/serverHelpers/Request';
import { ErrorResource } from '../resources/ErrorResource';

const { readFile } = promises;

const CF_ROUTES_DIR = resolvePath(env.get(CONFIG_PARAMS.COMPONENTSROOT));
let loaded_components = new Map<any, any>();
let watches_setup;
let resources;
// eslint-disable-next-line radar/no-unused-collection -- This is not used within this file, but is used within `./operations.js`
export let component_errors = new Map();

/**
 * Load all the applications registered in HarperDB, those in the components directory as well as any directly
 * specified to run
 * @param loaded_plugin_modules
 * @param loaded_resources
 */
export function loadComponentDirectories(loaded_plugin_modules?: Map<any, any>, loaded_resources?: Resources) {
	if (loaded_resources) resources = loaded_resources;
	if (loaded_plugin_modules) loaded_components = loaded_plugin_modules;
	const cfs_loaded = [];
	if (existsSync(CF_ROUTES_DIR)) {
		const cf_folders = readdirSync(CF_ROUTES_DIR, { withFileTypes: true });
		for (const app_entry of cf_folders) {
			if (!app_entry.isDirectory() && !app_entry.isSymbolicLink()) continue;
			const app_name = app_entry.name;
			const app_folder = join(CF_ROUTES_DIR, app_name);
			cfs_loaded.push(loadComponent(app_folder, resources, HDB_ROOT_DIR_NAME, false));
		}
	}
	const hdb_app_folder = process.env.RUN_HDB_APP;
	if (hdb_app_folder) {
		cfs_loaded.push(
			loadComponent(hdb_app_folder, resources, hdb_app_folder, false, null, Boolean(process.env.DEV_MODE))
		);
	}
	return Promise.all(cfs_loaded).then(() => {
		watches_setup = true;
	});
}

const TRUSTED_RESOURCE_LOADERS = {
	REST, // for backwards compatibility with older configs
	rest: REST,
	graphql: graphql_query_handler,
	graphqlSchema: graphql_handler,
	roles,
	jsResource: js_handler,
	fastifyRoutes: fastify_routes_handler,
	login,
	static: staticFiles,
	operationsApi: operationsServer,
	customFunctions: {},
	http: {},
	clustering: natsReplicator,
	replication,
	authentication: auth,
	mqtt,
	loadEnv,
	/*
	static: ...
	login: ...
	 */
};

const DEFAULT_CONFIG = {
	rest: true,
	graphqlSchema: {
		files: '*.graphql',
		//path: '/', // from root path by default, like http://server/query
	},
	roles: {
		files: 'roles.yaml',
	},
	jsResource: {
		files: 'resources.js',
		//path: '/', // from root path by default, like http://server/resource-name
	},
	fastifyRoutes: {
		files: 'routes/*.js',
		path: '.', // relative to the app-name, like  http://server/app-name/route-name
	},
	/*{
		module: 'login',
		path: '/',
	},
	/*{
		files: 'static',
		module: 'fastify_routes',
		path: '.',
	},
	{
		module: 'login',
		path: '/login', // relative to the app-name, like http://server/login
	},*/
};
// make this non-enumerable so we don't load by default, but has a default 'files' so we don't show errors on
// templates that want to have a default static handler:
Object.defineProperty(DEFAULT_CONFIG, 'static', { value: { files: 'web/**' } });

const ports_started = [];
const loaded_paths = new Map();
let error_reporter;
export function setErrorReporter(reporter) {
	error_reporter = reporter;
}

let comp_name: string;
export const getComponentName = () => comp_name;

/**
 * Load a component from the specified directory
 * @param component_path
 * @param resources
 * @param origin
 * @param ports_allowed
 * @param provided_loaded_components
 */
export async function loadComponent(
	folder: string,
	resources: Resources,
	origin: string,
	is_root?: boolean,
	provided_loaded_components?: Map<any, any>,
	auto_reload?: boolean
) {
	const resolved_folder = realpathSync(folder);
	if (loaded_paths.has(resolved_folder)) return loaded_paths.get(resolved_folder);
	loaded_paths.set(resolved_folder, true);
	if (provided_loaded_components) loaded_components = provided_loaded_components;
	try {
		let config;
		if (is_root) component_errors = new Map();
		let config_path = join(folder, 'harperdb-config.yaml'); // look for the specific harperdb-config.yaml first
		if (existsSync(config_path)) {
			config = is_root ? getConfigObj() : parseDocument(readFileSync(config_path, 'utf8')).toJSON();
			// if not found, look for the generic config.yaml, the config filename we have historically used, but only if not the root
		} else if (!is_root && existsSync((config_path = join(folder, 'config.yaml')))) {
			config = parseDocument(readFileSync(config_path, 'utf8')).toJSON();
		} else {
			config = DEFAULT_CONFIG;
		}

		const harperdb_module = join(folder, 'node_modules', 'harperdb');
		try {
			if (
				isMainThread &&
				(is_root ||
					((existsSync(harperdb_module) || !folder.startsWith(getHdbBasePath())) &&
						(!existsSync(harperdb_module) || realpathSync(PACKAGE_ROOT) !== realpathSync(harperdb_module))))
			) {
				// if the app has a harperdb module, we symlink it to the main app so it can be used in the main app (with the running modules)
				rmSync(harperdb_module, { recursive: true, force: true });
				if (!existsSync(join(folder, 'node_modules'))) {
					mkdirSync(join(folder, 'node_modules'));
				}
				symlinkSync(PACKAGE_ROOT, harperdb_module, 'dir');
			}
		} catch (error) {
			harper_logger.error('Error symlinking harperdb module', error);
			if (error.code == 'EPERM' && require('os').platform() === 'win32') {
				harper_logger.error('You may need to enable developer mode in "Settings" / "Update & Security" / "For developers", in order to enable symlinks so components can use `import from "harperdb"`');
			}
		}

		const parent_comp_name: string = comp_name;
		let has_functionality = is_root;
		// iterate through the app handlers so they can each do their own loading process
		for (const component_name in config) {
			comp_name = component_name;
			const component_config = config[component_name];
			component_errors.set(is_root ? component_name : basename(folder), false);
			if (!component_config) continue;
			let extension_module;
			const pkg = component_config.package;
			try {
				if (pkg) {
					let container_folder = folder;
					let component_path;
					while (!existsSync((component_path = join(container_folder, 'node_modules', component_name)))) {
						container_folder = dirname(container_folder);
						if (container_folder.length < getHdbBasePath().length) {
							component_path = null;
							break;
						}
					}
					if (component_path) {
						extension_module = await loadComponent(component_path, resources, origin, false);
						has_functionality = true;
					} else {
						throw new Error(`Unable to find package ${component_name}:${pkg}`);
					}
				} else extension_module = TRUSTED_RESOURCE_LOADERS[component_name];
				if (!extension_module) continue;
				// our own trusted modules can be directly retrieved from our map, otherwise use the (configurable) secure module loader
				const ensureTable = (options) => {
					options.origin = origin;
					return table(options);
				};
				// call the main start hook
				const network =
					component_config.network || ((component_config.port || component_config.securePort) && component_config);
				const securePort =
					network?.securePort ||
					// legacy support for switching to securePort
					(network?.https && network.port);
				const port = !network?.https && network?.port;
				if (isMainThread) {
					extension_module =
						(await extension_module.startOnMainThread?.({
							server,
							ensureTable,
							port,
							securePort,
							resources,
							...component_config,
						})) || extension_module;
					if (is_root && network) {
						for (const possible_port of [port, securePort]) {
							try {
								if (+possible_port && !ports_started.includes(possible_port)) {
									const session_affinity = env.get(CONFIG_PARAMS.HTTP_SESSIONAFFINITY);
									if (session_affinity)
										harper_logger.warn('Session affinity is not recommended and may cause memory leaks');
									if (session_affinity || !createReuseportFd) {
										// if there is a TCP port associated with the plugin, we set up the routing on the main thread for it
										ports_started.push(possible_port);
										startSocketServer(possible_port, session_affinity);
									}
								}
							} catch (error) {
								console.error('Error listening on socket', possible_port, error, component_name);
							}
						}
					}
				}
				if (resources.isWorker)
					extension_module =
						(await extension_module.start?.({
							server,
							ensureTable,
							port,
							securePort,
							resources,
							...component_config,
						})) || extension_module;
				loaded_components.set(extension_module, true);

				// a loader is configured to specify a glob of files to be loaded, we pass each of those to the plugin
				// handling files ourselves allows us to pass files to sandboxed modules that might not otherwise have
				// access to the file system.
				if (
					(extension_module.handleFile ||
						extension_module.handleDirectory ||
						extension_module.setupFile ||
						extension_module.setupDirectory) &&
					component_config.files != undefined
				) {
					if (component_config.files.includes('..')) throw handleHDBError('Can not reference parent directories');
					const files = join(folder, component_config.files).replace(/\\/g, '/'); // must normalize to slashes for fast-glob to work
					const end_of_fixed_path = files.indexOf('/*');
					if (
						end_of_fixed_path > -1 &&
						component_config.files !== DEFAULT_CONFIG[component_name]?.files &&
						!existsSync(files.slice(0, end_of_fixed_path))
					)
						throw new Error(
							`The path '${files.slice(
								0,
								end_of_fixed_path
							)}' does not exist and cannot be used as the base of the resolved 'files' path value '${
								component_config.files
							}'`
						);
					const app_name = basename(folder);
					let base_url_path = component_config.path || '/';
					base_url_path = base_url_path.startsWith('/')
						? base_url_path
						: base_url_path.startsWith('./')
							? '/' + app_name + base_url_path.slice(2)
							: base_url_path === '.'
								? '/' + app_name
								: '/' + app_name + '/' + base_url_path;
					let root_path, root_file_path;
					let root_end;
					if (component_config.root) {
						let root_path = component_config.root;
						if (root_path.startsWith('/')) root_path = root_path.slice(1);
						if (root_path.endsWith('/')) root_path = root_path.slice(0, -1);
						root_path += '/';
						root_file_path = join(folder, root_path);
					} else if ((root_end = files.indexOf('/*')) > -1) {
						root_file_path = files.slice(0, root_end + 1);
						root_path = relative(folder, root_file_path);
					} else if (component_config.files.indexOf('/') > -1) {
						root_file_path = files.slice(0, files.lastIndexOf('/') + 1);
						root_path = relative(folder, root_file_path);
					}
					let directory_handled = false;
					if (isMainThread && extension_module.setupDirectory) {
						directory_handled = await extension_module.setupDirectory?.(base_url_path, root_file_path, resources);
					}
					if (resources.isWorker && extension_module.handleDirectory) {
						directory_handled = await extension_module.handleDirectory?.(base_url_path, root_file_path, resources);
					}
					if (directory_handled) {
						has_functionality = true;
						continue;
					}
					for (const entry of await fg(files, { onlyFiles: false, objectMode: true })) {
						const { path, dirent } = entry;
						has_functionality = true;
						let relative_path = relative(folder, path).replace(/\\/g, '/');
						if (root_path) {
							if (relative_path.startsWith(root_path)) relative_path = relative_path.slice(root_path.length + 1);
							else
								throw new Error(
									`The root path '${component_config.root}' does not reference a valid part of the file path '${relative_path}'.` +
										`The root path should be used to indicate the relative path/part of the file path for determining the exported web path.`
								);
						}
						const url_path = base_url_path + (base_url_path.endsWith('/') ? '' : '/') + relative_path;
						try {
							if (dirent.isFile()) {
								const contents = await readFile(path);
								if (isMainThread) await extension_module.setupFile?.(contents, url_path, path, resources);
								if (resources.isWorker) await extension_module.handleFile?.(contents, url_path, path, resources);
							} else {
								// some plugins may want to just handle whole directories
								if (isMainThread) await extension_module.setupDirectory?.(url_path, path, resources);
								if (resources.isWorker) await extension_module.handleDirectory?.(url_path, path, resources);
							}
						} catch (error) {
							const message = `Could not load ${dirent.isFile() ? 'file' : 'directory'} '${path}'${
								component_config.module ? ` using '${component_config.module}'` : ''
							} for application '${folder}' due to:\n`;
							error.message = `${message}${error.message}`;
							error.stack = `${message}${error.stack}`;
							error_reporter?.(error);
							harper_logger.error(error);
							resources.set(component_config.path || '/', new ErrorResource(error));
							component_errors.set(is_root ? component_name : basename(folder), error.message);
						}
					}
				}
			} catch (error) {
				error.message = `Could not load component '${component_name}' for application '${basename(folder)}' due to: ${
					error.message
				}`;
				error_reporter?.(error);
				(getWorkerIndex() === 0 ? console : harper_logger).error(error);
				resources.set(component_config.path || '/', new ErrorResource(error), null, true);
				component_errors.set(is_root ? component_name : basename(folder), error.message);
			}
		}

		comp_name = parent_comp_name;
		// Auto restart threads on changes to any app folder. TODO: Make this configurable
		if (isMainThread && !watches_setup && auto_reload) {
			watchDir(folder, async () => {
				return loadComponentDirectories(); // return the promise
			});
		}
		if (config.extensionModule) {
			const extension_module = await secureImport(join(folder, config.extensionModule));
			loaded_paths.set(resolved_folder, extension_module);
			return extension_module;
		}
		if (!has_functionality && resources.isWorker) {
			const error_message = `${folder} did not load any modules, resources, or files, is this a valid component?`;
			error_reporter?.(new Error(error_message));
			(getWorkerIndex() === 0 ? console : harper_logger).error(error_message);
			component_errors.set(basename(folder), error_message);
		}
	} catch (error) {
		console.error(`Could not load application directory ${folder}`, error);
		error.message = `Could not load application due to ${error.message}`;
		error_reporter?.(error);
		resources.set('', new ErrorResource(error));
	}
}
