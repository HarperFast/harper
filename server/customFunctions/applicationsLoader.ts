import { readdirSync, promises, readFileSync, existsSync } from 'fs';
import { join, relative, basename } from 'path';
import { isMainThread } from 'worker_threads';
import { parseDocument } from 'yaml';
import * as env from '../../utility/environment/environmentManager';
import { HDB_SETTINGS_NAMES } from '../../utility/hdbTerms';
import * as graphql_handler from '../../resources/graphql';
import * as js_handler from '../../resources/js-resource';
import * as REST from '../../resources/REST';
import * as fastify_routes_handler from '../../plugins/fastifyRoutes';
import * as fg from 'fast-glob';
import { watchDir, restartWorkers } from '../../server/threads/manageThreads';
import { secureImport } from '../../resources/jsLoader';
import { server } from '../../index';
import {Resources} from '../../resources/Resources';
const { readFile } = promises;

const CONFIG_FILENAME = 'config.yaml';
let CF_ROUTES_DIR = env.get(HDB_SETTINGS_NAMES.CUSTOM_FUNCTIONS_DIRECTORY_KEY);
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
	if (loaded_resources)
		resources = loaded_resources;
	if (loaded_plugin_modules)
		loaded_plugins = loaded_plugin_modules;
	const cf_folders = readdirSync(CF_ROUTES_DIR, { withFileTypes: true });
	let cfs_loaded = [];
	for (let app_entry of cf_folders) {
		if (!app_entry.isDirectory() && !app_entry.isSymbolicLink()) return;
		const app_name = app_entry.name;
		const app_folder = join(CF_ROUTES_DIR, app_name);
		cfs_loaded.push(loadApplication(app_folder, resources));
	}
	// TODO: Get the "current" app from command line "run" argument or something like that
	cfs_loaded.push(loadApplication(process.cwd(), resources));
	return Promise.all(cfs_loaded).then(() => {
		watches_setup = true;
	});
}

const TRUSTED_HANDLERS = {
	REST,
	'graphql-schema': graphql_handler,
	'js-resource': js_handler,
	'fastify-routes': fastify_routes_handler,
};

const DEFAULT_HANDLERS = [
	'REST',
	{
		path: '*.graphql',
		module: 'graphql-schema',
	},
	{
		path: '*.js',
		module: 'js-resource',
	},
	{
		path: 'routes/*.js',
		module: 'fastify-routes',
	},
	/*{
		path: 'static',
		module: 'fastify_routes',
	},*/
];

/**
 * Load an application from the specified directory
 * @param app_folder
 * @param resources
 */
export async function loadApplication(app_folder: string, resources: Resources) {
	try {
		let config_path = join(app_folder, CONFIG_FILENAME);
		let config;
		if (existsSync(config_path)) {
			config = parseDocument(readFileSync(app_folder, 'utf8'), {simpleKeys: true}).toJSON();
		} else {
			config = {};
		}
		let handler_modules = [];
		// iterate through the app handlers so they can each do their own loading process
		for (let handler_config of config.handlers || DEFAULT_HANDLERS) {
			if (typeof handler_config === 'string') handler_config = {module: handler_config};
			// our own trusted modules can be directly retrieved from our map, otherwise use the (configurable) secure
			// module loader
			let module = TRUSTED_HANDLERS[handler_config.module] || await secureImport(handler_config.module);
			handler_modules.push(module);
			let start_resolution = loaded_plugins.get(module);
			// call the main start hook
			if (!start_resolution) {
				if (isMainThread)
					start_resolution = module.startOnMainThread?.({server, resources});
				else
					start_resolution = module.start?.({server, resources});
				loaded_plugins.set(module, start_resolution);
			}
			await start_resolution;
			// a loader is configured to specify a glob of files to be loaded, we pass each of those to the plugin
			// handling files ourselves allows us to pass files to sandboxed modules that might not otherwise have
			// access to the file system.
			if (module.handleFile && handler_config.path) {
				let path = join(app_folder, handler_config.path);
				for (let entry of await fg(path, {onlyFiles: false, objectMode: true})) {
					let {path, dirent} = entry;
					let relative_path = relative(app_folder, path);
					let app_name = basename(app_folder); // TODO: Can optionally use this to prefix resources
					if (dirent.isFile()) {
						let contents = await readFile(path);
						if (isMainThread)
							module.setupFile?.(contents, relative_path, path, resources);
						else
							module.handleFile?.(contents, relative_path, path, resources);
					} else {
						// some plugins may want to just handle whole directories
						if (isMainThread)
							module.setupDirectory?.(relative_path, path, resources);
						else
							module.handleDirectory?.(relative_path, path, resources);
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
		console.error(`Could not load application directory ${app_folder}`, error);
	}
}
