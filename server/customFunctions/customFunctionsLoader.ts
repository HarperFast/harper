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
import { watchDir, restartWorkers } from '../../server/threads/manage-threads';
const { readFile } = promises;

const CONFIG_FILENAME = 'config.yaml';
let CF_ROUTES_DIR = env.get(HDB_SETTINGS_NAMES.CUSTOM_FUNCTIONS_DIRECTORY_KEY);
let loaded_plugins: Map<any, any>;
export function loadCustomFunctions(loaded_plugin_modules: Map<any, any>) {
	loaded_plugins = loaded_plugin_modules;
	const cf_folders = readdirSync(CF_ROUTES_DIR, { withFileTypes: true });
	let cfs_loaded = [];
	for (let app_entry of cf_folders) {
		if (!app_entry.isDirectory() && !app_entry.isSymbolicLink()) return;
		const app_name = app_entry.name;
		const app_folder = join(CF_ROUTES_DIR, app_name);
		cfs_loaded.push(loadCustomFunction(app_folder));
	}
	cfs_loaded.push(loadCustomFunction(process.cwd()));
	return Promise.all(cfs_loaded);
}

const TRUSTED_HANDLERS = {
	REST,
	'graphql-schema': graphql_handler,
	'js-resource': js_handler,
	'fastify_routes': fastify_routes_handler,
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
		module: 'fastify_routes',
	},
];

export async function loadCustomFunction(app_folder: string, no_watch?: boolean) {
	let config_path = join(app_folder, CONFIG_FILENAME);
	let resources = new Map();
	let config;
	if (existsSync(config_path)) {
		config = parseDocument(readFileSync(app_folder, 'utf8'), { simpleKeys: true }).toJSON();
	} else {
		config = {};
	}
	let handler_modules = [];
	for (let handler_config of config.handlers || DEFAULT_HANDLERS) {
		if (typeof handler_config === 'string') handler_config = { module: handler_config };
		let module = TRUSTED_HANDLERS[handler_config.module] || await import(handler_config.module);
		handler_modules.push(module);
		let start_resolution = loaded_plugins.get(module);
		if (!start_resolution) {
			if (isMainThread)
				start_resolution = module.startOnMainThread?.({});
			else
				start_resolution = module.start?.({});
			loaded_plugins.set(module, start_resolution);
		}
		await start_resolution;
		if (module.handleFile && handler_config.path) {
			let path = join(app_folder, handler_config.path);
			for (let filename of await fg(path)) {
				let contents = await readFile(filename);
				let relative_path = relative(app_folder, filename);
				if (isMainThread)
					module.setupFile?.(contents, relative_path, filename, resources);
				else
					module.handleFile?.(contents, relative_path, filename, resources);
			}
		}
	}
	let app_name = basename(app_folder);
	for (let module of handler_modules) {
		module.loadedResources?.(resources, app_name);
	}
	// Auto restart threads on changes to any app folder. TODO: Make this configurable
	if (isMainThread && !no_watch) {
		watchDir(app_folder, () => {
			loadCustomFunction(app_folder, true);
			restartWorkers();
		});
	}
}
