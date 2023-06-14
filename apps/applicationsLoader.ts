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
import * as operationsServer from '../server/operationsServer';
import * as auth from '../security/auth';
import * as natsReplicator from '../server/nats/natsReplicator';
import * as mqtt from '../server/mqtt';

const { readFile } = promises;

const CONFIG_FILENAME = 'config.yaml';
const CF_ROUTES_DIR = env.get(HDB_SETTINGS_NAMES.CUSTOM_FUNCTIONS_DIRECTORY_KEY);
let loaded_components = new Map<any, any>();
let watches_setup;
let resources;

/**
 * Load all the applications registered in HarperDB, those in the custom_functions directory as well as any directly
 * specified to run
 * @param loaded_plugin_modules
 * @param loaded_resources
 */
export function loadApplications(loaded_plugin_modules?: Map<any, any>, loaded_resources?: Resources) {
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

const POSSIBLE_ROOT_FILES = ['config.yaml', 'package.json', 'schema.graphql', 'resources.js', ''];
const ports_started = [];
/**
 * Load a component from the specified directory
 * @param component_path
 * @param resources
 * @param origin
 * @param ports_allowed
 * @param provided_loaded_components
 */
export async function loadComponent(
	component_path: string,
	resources: Resources,
	origin: string,
	ports_allowed?: boolean,
	provided_loaded_components?: Map
) {
	let component_folder;
	if (provided_loaded_components) loaded_components = provided_loaded_components;
	try {
		let config;
		if (component_path.endsWith('config.yaml')) {
			component_folder = dirname(component_path);
			config = parseDocument(readFileSync(component_path, 'utf8'), { simpleKeys: true }).toJSON();
		} else {
			component_folder = component_path;
			config = DEFAULT_CONFIG;
		}
		const handler_modules = [];
		// iterate through the app handlers so they can each do their own loading process
		for (const component_name in config) {
			const component_config = config[component_name];
			let extension_module;
			const pkg = component_config.package;
			if (pkg) {
				let component_path;
				for (const root_file of POSSIBLE_ROOT_FILES) {
					try {
						const root_path = require.resolve(join(pkg, root_file));
						component_path = root_file === 'config.yaml' ? root_path : dirname(root_path);
						break;
					} catch (error) {
						if (error.code !== 'MODULE_NOT_FOUND') {
							throw error;
						}
					}
				}
				if (component_path) {
					extension_module = await loadComponent(component_path, resources, origin, false);
				} else {
					throw new Error(`Unable to find package ${pkg}`);
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
				if (isMainThread) {
					extension_module =
						(await extension_module.startOnMainThread?.({ server, ensureTable, resources, ...component_config })) ||
						extension_module;
					const network =
						component_config.network || ((component_config.port || component_config.securePort) && component_config);
					if (ports_allowed && network) {
						const securePort =
							network.securePort ||
							// legacy support for switching to securePort
							(network.https && network.port);
						const port = !network.https && network.port;
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
						(await extension_module.start?.({ server, ensureTable, resources, ...component_config })) ||
						extension_module;
				loaded_components.set(extension_module, true);
				// a loader is configured to specify a glob of files to be loaded, we pass each of those to the plugin
				// handling files ourselves allows us to pass files to sandboxed modules that might not otherwise have
				// access to the file system.
				if (extension_module.handleFile && component_config.files) {
					if (component_config.files.includes('..')) throw handleHDBError('Can not reference parent directories');
					const files = join(component_folder, component_config.files);
					for (const entry of await fg(files, { onlyFiles: false, objectMode: true })) {
						const { path, dirent } = entry;
						const relative_path = relative(component_folder, path);
						const app_name = basename(component_folder);
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
								} for application ${component_folder}`,
								error
							);
							resources.set(component_config.path || '/', new ErrorResource(error));
						}
					}
				}
			} catch (error) {
				console.error(`Could not load handler ${component_config.module} for application ${component_folder}`, error);
				resources.set(component_config.path || '/', new ErrorResource(error));
			}
		}
		// Auto restart threads on changes to any app folder. TODO: Make this configurable
		if (isMainThread && !watches_setup) {
			watchDir(component_folder, () => {
				loadApplications();
				restartWorkers();
			});
		}
		if (config.extensionModule) {
			return await secureImport(join(component_folder, config.extensionModule));
		}
	} catch (error) {
		console.error(`Could not load application directory ${component_folder}`, error);
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
