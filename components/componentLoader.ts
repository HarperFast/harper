import { readdirSync, promises, readFileSync, existsSync, symlinkSync, mkdirSync } from 'fs';
import { join, relative, basename, dirname } from 'path';
import { isMainThread } from 'worker_threads';
import { parseDocument } from 'yaml';
import * as env from '../utility/environment/environmentManager';
import { HDB_SETTINGS_NAMES, CONFIG_PARAMS } from '../utility/hdbTerms';
import * as graphql_handler from '../resources/graphql';
import * as js_handler from '../resources/jsResource';
import * as login from '../resources/login';
import * as REST from '../server/REST';
import * as fastify_routes_handler from '../server/fastifyRoutes';
import * as staticFiles from '../server/static';
import fg from 'fast-glob';
import { watchDir, restartWorkers } from '../server/threads/manageThreads';
import { secureImport } from '../security/jsLoader';
import { server } from '../server/Server';
import { Resources } from '../resources/Resources';
import { handleHDBError } from '../utility/errors/hdbError';
import { Resource } from '../resources/Resource';
import { table } from '../resources/databases';
import { startSocketServer } from '../server/threads/socketRouter';
import { getHdbBasePath } from '../utility/environment/environmentManager';
import * as operationsServer from '../server/operationsServer';
import * as auth from '../security/auth';
import * as natsReplicator from '../server/nats/natsReplicator';
import * as mqtt from '../server/mqtt';

const { readFile } = promises;

const CONFIG_FILENAME = 'config.yaml';
const CF_ROUTES_DIR = env.get(CONFIG_PARAMS.CUSTOMFUNCTIONS_ROOT);
let loaded_components = new Map<any, any>();
let watches_setup;
let resources;

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
			cfs_loaded.push(loadComponent(app_folder, resources, 'hdb', false));
		}
	}
	const hdb_app_folder = process.env.RUN_HDB_APP;
	if (hdb_app_folder) {
		cfs_loaded.push(loadComponent(hdb_app_folder, resources, hdb_app_folder));
	}
	return Promise.all(cfs_loaded).then(() => {
		watches_setup = true;
	});
}

const TRUSTED_RESOURCE_LOADERS = {
	REST,
	graphqlSchema: graphql_handler,
	jsResource: js_handler,
	fastifyRoutes: fastify_routes_handler,
	login,
	static: staticFiles,
	operationsApi: operationsServer,
	customFunctions: {},
	clustering: natsReplicator,
	authentication: auth,
	mqtt,
	/*
	static: ...
	login: ...
	 */
};

const DEFAULT_CONFIG = {
	REST: true,
	graphqlSchema: {
		files: '*.graphql',
		//path: '/', // from root path by default, like http://server/query
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

const ports_started = [];
const loaded_paths = new Map();
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
	provided_loaded_components?: Map
) {
	if (loaded_paths.has(folder)) return;
	loaded_paths.set(folder, true);
	if (provided_loaded_components) loaded_components = provided_loaded_components;
	try {
		let config;
		const config_path = join(folder, is_root ? 'harperdb-config.yaml' : 'config.yaml');
		if (existsSync(config_path)) {
			config = parseDocument(readFileSync(config_path, 'utf8'), { simpleKeys: true }).toJSON();
		} else {
			config = DEFAULT_CONFIG;
		}
		const handler_modules = [];
		// iterate through the app handlers so they can each do their own loading process
		for (const component_name in config) {
			const component_config = config[component_name];
			if (!component_config) continue;
			let extension_module;
			const pkg = component_config.package;
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
				} else {
					throw new Error(`Unable to find package ${component_name}:${pkg}`);
				}
			} else extension_module = TRUSTED_RESOURCE_LOADERS[component_name];
			if (!extension_module) continue;
			try {
				// our own trusted modules can be directly retrieved from our map, otherwise use the (configurable) secure
				// module loader
				handler_modules.push(extension_module);
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
									// if there is a TCP port associated with the plugin, we set up the routing on the main thread for it
									ports_started.push(possible_port);
									const session_affinity = env.get(CONFIG_PARAMS.HTTP_SESSION_AFFINITY);
									startSocketServer(possible_port, session_affinity);
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
				if (extension_module.handleFile && component_config.files) {
					if (component_config.files.includes('..')) throw handleHDBError('Can not reference parent directories');
					const files = join(folder, component_config.files);
					for (const entry of await fg(files, { onlyFiles: false, objectMode: true })) {
						const { path, dirent } = entry;
						const relative_path = relative(folder, path);
						const app_name = basename(folder);
						let url_path = component_config.path || '/';
						url_path = url_path.startsWith('/')
							? url_path
							: url_path.startsWith('./')
							? '/' + app_name + url_path.slice(2)
							: url_path === '.'
							? '/' + app_name
							: '/' + app_name + '/' + url_path;
						url_path += (url_path.endsWith('/') ? '' : '/') + relative_path;
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
							console.error(
								`Could not load ${dirent.isFile() ? 'file' : 'directory'} ${path} using ${
									component_config.module
								} for application ${folder}`,
								error
							);
							resources.set(component_config.path || '/', new ErrorResource(error));
						}
					}
				}
			} catch (error) {
				console.error(`Could not load component ${component_name} for application ${folder}`, error);
				resources.set(component_config.path || '/', new ErrorResource(error));
			}
		}
		// Auto restart threads on changes to any app folder. TODO: Make this configurable
		if (isMainThread && !watches_setup) {
			watchDir(folder, async () => {
				return loadComponentDirectories(); // return the promise
			});
		}
		if (config.extensionModule) {
			return await secureImport(join(folder, config.extensionModule));
		}
	} catch (error) {
		console.error(`Could not load application directory ${folder}`, error);
		resources.set('', new ErrorResource(error));
	}
}
class ErrorResource extends Resource {
	constructor(public error) {
		super();
	}
	get() {
		throw this.error;
	}
	post() {
		throw this.error;
	}
	put() {
		throw this.error;
	}
	delete() {
		throw this.error;
	}
	connect() {
		throw this.error;
	}
	getResource() {
		// all child paths resolve back to reporting this error
		return this;
	}
	publish() {
		throw this.error;
	}
	subscribe() {
		throw this.error;
	}
}
