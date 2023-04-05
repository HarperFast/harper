import { readdirSync, promises, readFileSync, existsSync } from 'fs';
import { join, relative, basename } from 'path';
import { isMainThread } from 'worker_threads';
import { parseDocument } from 'yaml';
import * as env from '../../utility/environment/environmentManager';
import { HDB_SETTINGS_NAMES, CONFIG_PARAMS } from '../../utility/hdbTerms';
import * as graphql_handler from '../resources/graphql';
import * as js_handler from '../resources/jsResource';
import * as login from '../resources/login';
import * as REST from '../server/REST';
import * as fastify_routes_handler from '../server/fastifyRoutes';
import * as fg from 'fast-glob';
import { watchDir, restartWorkers } from '../../server/threads/manageThreads';
import { secureImport } from '../security/jsLoader';
import { server } from '../server/Server';
import { Resources } from '../resources/Resources';
import { handleHDBError } from '../utility/errors/hdbError';
const { readFile } = promises;

const CONFIG_FILENAME = 'config.yaml';
const CF_ROUTES_DIR = env.get(HDB_SETTINGS_NAMES.CUSTOM_FUNCTIONS_DIRECTORY_KEY);
let loaded_plugins: Map<any, any>;
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
	if (loaded_plugin_modules) loaded_plugins = loaded_plugin_modules;
	const cf_folders = readdirSync(CF_ROUTES_DIR, { withFileTypes: true });
	const cfs_loaded = [];
	for (const app_entry of cf_folders) {
		if (!app_entry.isDirectory() && !app_entry.isSymbolicLink()) return;
		const app_name = app_entry.name;
		const app_folder = join(CF_ROUTES_DIR, app_name);
		cfs_loaded.push(loadApplication(app_folder, resources));
	}
	if (process.env.RUN_HDB_APP) {
		cfs_loaded.push(loadApplication(process.env.RUN_HDB_APP, resources));
	}
	return Promise.all(cfs_loaded).then(() => {
		watches_setup = true;
	});
}

const TRUSTED_RESOURCE_LOADERS = {
	REST,
	'graphql-schema': graphql_handler,
	'js-resource': js_handler,
	'fastify-routes': fastify_routes_handler,
	login,
	/*
	static: ...
	login: ...
	 */
};

const DEFAULT_RESOURCE_LOADERS = [
	'REST',
	{
		files: '*.graphql',
		module: 'graphql-schema',
		//path: '/', // from root path by default, like http://server/query
	},
	{
		files: 'resources.js',
		module: 'js-resource',
		//path: '/', // from root path by default, like http://server/resource-name
	},
	{
		files: 'routes/*.js',
		module: 'fastify-routes',
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
];

/**
 * Load an application from the specified directory
 * @param app_folder
 * @param resources
 */
export async function loadApplication(app_folder: string, resources: Resources) {
	try {
		const config_path = join(app_folder, CONFIG_FILENAME);
		let config;
		if (existsSync(config_path)) {
			config = parseDocument(readFileSync(app_folder, 'utf8'), { simpleKeys: true }).toJSON();
		} else {
			config = {};
		}
		const handler_modules = [];
		// iterate through the app handlers so they can each do their own loading process
		for (let handler_config of config.resourceLoaders || DEFAULT_RESOURCE_LOADERS) {
			if (typeof handler_config === 'string') handler_config = { module: handler_config };
			// our own trusted modules can be directly retrieved from our map, otherwise use the (configurable) secure
			// module loader
			const module = TRUSTED_RESOURCE_LOADERS[handler_config.module] || (await secureImport(handler_config.module));
			handler_modules.push(module);
			let start_resolution = loaded_plugins.get(module);
			// call the main start hook
			if (!start_resolution) {
				if (isMainThread) start_resolution = module.startOnMainThread?.({ server, resources });
				if (resources.isWorker) start_resolution = module.start?.({ server, resources });
				loaded_plugins.set(module, start_resolution);
			}
			await start_resolution;
			// a loader is configured to specify a glob of files to be loaded, we pass each of those to the plugin
			// handling files ourselves allows us to pass files to sandboxed modules that might not otherwise have
			// access to the file system.
			if (module.handleFile && handler_config.files) {
				if (handler_config.files.includes('..')) throw handleHDBError('Can not reference parent directories');
				const files = join(app_folder, handler_config.files);
				for (const entry of await fg(files, { onlyFiles: false, objectMode: true })) {
					const { path, dirent } = entry;
					const relative_path = relative(app_folder, path);
					const app_name = basename(app_folder);
					let url_path = handler_config.path || '/';
					url_path = url_path.startsWith('/')
						? url_path
						: url_path.startsWith('./')
						? '/' + app_name + url_path.slice(2)
						: url_path === '.'
						? '/' + app_name
						: '/' + app_name + '/' + url_path;
					url_path += (url_path.endsWith('/') ? '' : '/') + relative_path;
					if (dirent.isFile()) {
						const contents = await readFile(path);
						if (isMainThread) await module.setupFile?.(contents, url_path, path, resources);
						if (resources.isWorker) await module.handleFile?.(contents, url_path, path, resources);
					} else {
						// some plugins may want to just handle whole directories
						if (isMainThread) await module.setupDirectory?.(url_path, path, resources);
						if (resources.isWorker) await module.handleDirectory?.(url_path, path, resources);
					}
				}
			}
		}
		// Auto restart threads on changes to any app folder. TODO: Make this configurable
		if (isMainThread && !watches_setup) {
			watchDir(app_folder, () => {
				loadApplications();
				restartWorkers();
			});
		}
	} catch (error) {
		// TODO: Put HTTP into error state which always returns error message
		console.error(`Could not load application directory ${app_folder}`, error);
	}
}
