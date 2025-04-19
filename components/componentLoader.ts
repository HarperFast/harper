import { readdirSync, promises, readFileSync, existsSync, symlinkSync, rmSync, mkdirSync, realpathSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { isMainThread } from 'node:worker_threads';
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
			if (error.code == 'EPERM' && process.platform === 'win32') {
				harper_logger.error(
					'You may need to enable developer mode in "Settings" / "System" (or "Update & Security") / "For developers", in order to enable symlinks so components can use `import from "harperdb"`'
				);
			}
		}

		const parent_comp_name: string = comp_name;
		const componentFunctionality = {};
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
						componentFunctionality[component_name] = true;
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

				if (
					(extension_module.handleFile ||
						extension_module.handleDirectory ||
						extension_module.setupFile ||
						extension_module.setupDirectory) &&
					component_config.files != undefined
				) {
					const component = new Component({
						config: component_config,
						name: component_name,
						directory: folder,
						module: extension_module,
						resources,
					});

					componentFunctionality[component_name] = await processResourceExtensionComponent(component);
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
		if (Object.values(componentFunctionality).every((functionality) => !functionality) && resources.isWorker) {
			const error_message = `${folder} did not load any modules, resources, or files, is this a valid component?`;
			error_reporter?.(new Error(error_message));
			(getWorkerIndex() === 0 ? console : harper_logger).error(error_message);
			component_errors.set(basename(folder), error_message);
		}

		for (const [componentName, functionality] of Object.entries(componentFunctionality)) {
			if (!functionality)
				harper_logger.warn(`Component ${componentName} from (${basename(folder)}) did not load any functionality.`);
		}
	} catch (error) {
		console.error(`Could not load application directory ${folder}`, error);
		error.message = `Could not load application due to ${error.message}`;
		error_reporter?.(error);
		resources.set('', new ErrorResource(error));
	}
}

interface ComponentConfig {
	files: string | string[] | Readonly<{ source: string; only: 'all' | 'files' | 'directories'; ignore?: string[] }>;
	/** @deprecated */ path?: string;
	urlPath?: string;
	/** @deprecated */ root?: string;
	[key: string]: any;
}

interface ComponentModule {
	setupDirectory?: (urlPath: string, absolutePath: string, resources: Resources) => Promise<undefined | boolean>;
	handleDirectory?: (urlPath: string, absolutePath: string, resources: Resources) => Promise<undefined | boolean>;
	setupFile?: (contents: Buffer, urlPath: string, absolutePath: string, resources: Resources) => Promise<void>;
	handleFile?: (contents: Buffer, urlPath: string, absolutePath: string, resources: Resources) => Promise<void>;
}

interface ComponentDetails {
	config: ComponentConfig;
	name: string;
	directory: string;
	module: ComponentModule;
	resources: Resources;
}

export class Component {
	readonly config: Readonly<ComponentConfig>;
	readonly name: string;
	readonly directory: string;
	readonly module: Readonly<ComponentModule>;
	readonly resources: Resources;
	readonly globOptions: { source: string[]; onlyFiles: boolean; onlyDirectories: boolean; ignore: string[] };
	readonly patternRoots: string[];
	readonly baseURLPath: string;

	constructor(options: ComponentDetails) {
		// TO DO: Unfortunately `readonly` is a TS only thing and doesn't actually enforce that these properties can't be modified.
		// Freeze these things so they can't be changed. likely do this at the end of the constructor
		this.config = options.config;
		this.name = options.name;
		this.directory = options.directory;
		this.module = options.module;
		this.resources = options.resources;

		// Config option basic validation
		if (
			!isNonEmptyString(this.config.files) &&
			!isArrayOfNonEmptyStrings(this.config.files) &&
			!isObject(this.config.files)
		) {
			throw new InvalidFilesOptionError(this);
		}

		// Validating the `files` object
		if (typeof this.config.files === 'object' && !Array.isArray(this.config.files)) {
			if (
				this.config.files.source === undefined ||
				(!isArrayOfNonEmptyStrings(this.config.files.source) && !isNonEmptyString(this.config.files.source))
			) {
				throw new InvalidFilesSourceOptionError(this);
			}

			if (
				this.config.files.only !== undefined &&
				(typeof this.config.files.only !== 'string' ||
					!['all', 'files', 'directories'].includes(this.config.files.only))
			) {
				throw new InvalidFilesOnlyOptionError(this);
			}

			if (
				this.config.files.ignore !== undefined &&
				!isArrayOfNonEmptyStrings(this.config.files.ignore) &&
				!isNonEmptyString(this.config.files.ignore)
			) {
				throw new InvalidFileIgnoreOptionError(this);
			}
		}

		// Validate the deprecated options too
		if (this.config.root !== undefined && !isNonEmptyString(this.config.root)) {
			throw new InvalidRootOptionError(this);
		}

		if (this.config.path !== undefined && !isNonEmptyString(this.config.path)) {
			throw new InvalidPathOptionError(this);
		}

		// Handle deprecated `path` option
		if (this.config.path) {
			harper_logger.warn(`Resource extension 'path' option is deprecated. Please replace with 'urlPath'.`);
			this.config.urlPath = this.config.path;
		}

		// Validate the `urlPath`
		if (
			this.config.urlPath !== undefined &&
			(!isNonEmptyString(this.config.urlPath) ||
				(typeof this.config.urlPath === 'string' && this.config.urlPath.includes('..')))
		) {
			throw new InvalidURLPathOptionError(this);
		}

		this.globOptions = this.deriveGlobOptions();
		this.patternRoots = derivePatternRoots(this.globOptions.source);
		this.baseURLPath = resolveBaseURLPath(this.name, this.config.urlPath);
	}

	private deriveGlobOptions() {
		const globOptions = { source: [], onlyFiles: false, onlyDirectories: false, ignore: [] };

		if (typeof this.config.files === 'object' && !Array.isArray(this.config.files)) {
			globOptions.source = [].concat(this.config.files.source);
			globOptions.ignore = this.config.files.ignore || [];
			switch (this.config.files.only) {
				case 'all':
					globOptions.onlyFiles = false;
					globOptions.onlyDirectories = false;
					break;
				case 'files':
					globOptions.onlyFiles = true;
					globOptions.onlyDirectories = false;
					break;
				case 'directories':
					globOptions.onlyFiles = false;
					globOptions.onlyDirectories = true;
					break;
			}
		} else {
			globOptions.source = [].concat(this.config.files);
		}

		// Validate and transform glob patterns
		globOptions.source = globOptions.source.map((pattern) => {
			if (pattern.includes('..')) {
				throw new InvalidGlobPattern(this, pattern);
			}

			if (pattern.startsWith('/')) {
				harper_logger.warn(
					`Leading '/' in 'files' glob pattern is deprecated. For backwards compatibility purposes, it is currently transformed to the relative path of the component, but in the future will result in an error. Please replace with a relative path such as './' or removing the leading path separator all together ('./static/*' -> 'static/*').`
				);

				pattern = pattern === '/' ? './' : pattern.slice(1);
			}

			return pattern;
		});

		return globOptions;
	}
}

export class ComponentProcessingError extends Error {
	constructor(message: string, component: ComponentDetails) {
		super(`Component ${component.name} (from ${basename(component.directory)}) ${message}`);
	}
}

export class InvalidFilesOptionError extends ComponentProcessingError {
	constructor(component: ComponentDetails) {
		super(`'files' option must be a non-empty string, an array of non-empty strings, or an object.`, component);
	}
}

export class InvalidFilesSourceOptionError extends ComponentProcessingError {
	constructor(component: ComponentDetails) {
		super(`'files' object must have a non-empty 'source' property.`, component);
	}
}

export class InvalidFilesOnlyOptionError extends ComponentProcessingError {
	constructor(component: ComponentDetails) {
		super(`'files.only' option must be one of 'all', 'files', or 'directories'.`, component);
	}
}

export class InvalidFileIgnoreOptionError extends ComponentProcessingError {
	constructor(component: ComponentDetails) {
		super(`'files.ignore' option must be a non-empty string or an array of non-empty strings.`, component);
	}
}

export class InvalidGlobPattern extends ComponentProcessingError {
	constructor(component: ComponentDetails, pattern: string) {
		super(`'files' glob pattern must not contain '..'. Received: '${pattern}'`, component);
	}
}

export class InvalidRootOptionError extends ComponentProcessingError {
	constructor(component: ComponentDetails) {
		super(
			`deprecated 'root' option must be a non-empty string. Consider removing and updating 'files' glob pattern instead.`,
			component
		);
	}
}

export class InvalidRootOptionUseError extends ComponentProcessingError {
	constructor(component: ComponentDetails) {
		super(
			`the 'root' option is deprecated and only supported if 'files' is a singular, non-empty string. Please remove the 'root' option and modify the 'files' glob pattern instead.`,
			component
		);
	}
}

export class InvalidPathOptionError extends ComponentProcessingError {
	constructor(component: ComponentDetails) {
		super(`deprecated 'path' option must be a non-empty string. Consider replacing with 'urlPath'.`, component);
	}
}

export class InvalidURLPathOptionError extends ComponentProcessingError {
	constructor(component: ComponentDetails) {
		super(`'urlPath' option must be a non-empty string that must not contain '..'.`, component);
	}
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === 'string' && value.trim() !== '';
}

function isArrayOfNonEmptyStrings(value: unknown): value is string[] {
	return Array.isArray(value) && value.length !== 0 && value.every((item) => isNonEmptyString(item));
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function handleRoots(component: Component) {
	if (component.config.root) {
		harper_logger.warn(
			`Resource extension 'root' option is deprecated. Due to backwards compatibility reasons it does not act as assumed. The glob pattern will always be evaluated from the component directory root. The option is only used for the initial root directory handling. Please remove and modify the 'files' glob pattern instead.`
		);
	}

	// For backwards compatibility, we need to evaluate the root path via the existing logic. This is only valid if `root` is defined, and `files` is a strings that doesn't contain `**/*`,
	// And if that existing logic does not produce a reasonable root path to evaluate, we can consider the configure "new" and evaluate it based on a new process

	let rootPaths = [];

	if (component.config.root && typeof component.config.files !== 'string') {
		throw new InvalidRootOptionUseError(component);
	}

	// This starts old root handling
	let rootPath = component.config.root;

	if (rootPath) {
		// trim any leading slashes
		if (rootPath.startsWith('/')) {
			rootPath = rootPath.slice(1);
		}
		// add a trailing slash if it doesn't exist
		if (!rootPath.endsWith('/')) {
			rootPath += '/';
		}
	}

	const pattern = component.config.files;

	// This is still old root handling logic - operate only a singular pattern
	if (typeof pattern === 'string' && !pattern.includes('**/*')) {
		if (pattern.indexOf('/*') > -1) {
			rootPath = pattern.slice(0, pattern.indexOf('/*') + 1);
		} else if (pattern.indexOf('/') > -1) {
			rootPath = pattern.slice(0, pattern.lastIndexOf('/') + 1);
		}
	}

	if (rootPath) rootPaths.push(rootPath);

	// If old handling did not result in a root path, now use the patternRoots derived from the processed glob patterns
	if (rootPaths.length === 0) {
		// Return early if we are only processing files
		if (isObject(component.config.files) && component.config.files.only === 'files') {
			return false;
		}

		rootPaths = component.patternRoots;
	}

	let hasFunctionality = false;

	for (const rootPath of rootPaths) {
		if (!rootPath) continue;
		const rootPathAbsolute = join(component.directory, rootPath);

		if (isMainThread && component.module.setupDirectory) {
			hasFunctionality = await component.module.setupDirectory(
				component.baseURLPath,
				rootPathAbsolute,
				component.resources
			);
		}
		if (component.resources.isWorker && component.module.handleDirectory) {
			hasFunctionality = await component.module.handleDirectory(
				component.baseURLPath,
				rootPathAbsolute,
				component.resources
			);
		}
	}

	return hasFunctionality;
}

/**
 * Process a Resource Extension component by evaluating the files glob pattern
 * and then calling the appropriate setup/handle functions.
 */
export async function processResourceExtensionComponent(component: Component) {
	let hasFunctionality = false;

	hasFunctionality = await handleRoots(component);

	// Return early if roots were functional
	if (hasFunctionality) return hasFunctionality;

	const matches = await fg(component.globOptions.source, {
		cwd: component.directory,
		objectMode: true,
		onlyFiles: component.globOptions.onlyFiles,
		onlyDirectories: component.globOptions.onlyDirectories,
		ignore: component.globOptions.ignore,
	});

	for (const entry of matches) {
		let entryPathPart = entry.path;

		if (entryPathPart !== '/') {
			for (const root of component.patternRoots) {
				if (entry.path.startsWith(root)) {
					entryPathPart = entry.path.slice(root.length);
					break;
				}
			}
		}

		const urlPath = join(component.baseURLPath, entryPathPart);
		const absolutePath = join(component.directory, entry.path);

		if (entry.dirent.isDirectory()) {
			if (isMainThread && component.module.setupDirectory) {
				await component.module.setupDirectory(urlPath, absolutePath, component.resources);
				hasFunctionality = true;
			}
			if (component.resources.isWorker && component.module.handleDirectory) {
				await component.module.handleDirectory(urlPath, absolutePath, component.resources);
				hasFunctionality = true;
			}
		} else if (entry.dirent.isFile()) {
			const contents = await readFile(absolutePath);
			if (isMainThread && component.module.setupFile) {
				await component.module.setupFile(contents, urlPath, absolutePath, component.resources);
				hasFunctionality = true;
			} else if (component.resources.isWorker && component.module.handleFile) {
				await component.module.handleFile(contents, urlPath, absolutePath, component.resources);
				hasFunctionality = true;
			}
		} else {
			harper_logger.error(
				`Entry received from glob pattern match for component ${component.name} is neither a file nor a directory:`,
				entry
			);
		}
	}

	return hasFunctionality;
}

// Note: It may make sense to put these function into the Component class, but for now they are kept separate for testing and reusability.

/**
 * Resolve the base URL path based on the component name and `urlPath` configuration option.
 *
 * For example, resolving the component config `urlPath` value for component `test-component`:
 * - `undefined`, `''`, `'/'` -> `'/'`
 * - `'static'`, `'/static/'`, `'/static'`, `'static/'` -> `'/static/'`
 * - `'v1/static'`, `'/v1/static/'`, `'/v1/static'`, `'v1/static/'` -> `'/v1/static/'`
 * - `'./static'`, `'./static/'` -> `'/test-component/static/'`
 * - `'.'`, `'./'` -> `'/test-component/'`
 * - `'..'`, `'../'`, `'../static'`, `'./..'` -> Error
 */
export function resolveBaseURLPath(name: string, urlPath?: string) {
	if (urlPath?.includes('..')) {
		throw new Error(`urlPath must not contain '..'. Received: '${urlPath}'`);
	}

	let baseURLPath = urlPath || '/';

	if (baseURLPath === '.' || baseURLPath.startsWith('./')) {
		baseURLPath = `/${name}${baseURLPath.slice(1)}`;
	}

	if (!baseURLPath.startsWith('/')) {
		baseURLPath = `/${baseURLPath}`;
	}

	if (!baseURLPath.endsWith('/')) {
		baseURLPath = `${baseURLPath}/`;
	}

	return baseURLPath;
}

/**
 * Derive the pattern roots from the list of patterns.
 *
 * @param patterns
 * @returns
 */
export function derivePatternRoots(patterns: string[]): Array<string | null> {
	const patternRoots = new Set<string | null>();

	for (const pattern of patterns) {
		patternRoots.add(derivePatternRoot(pattern));
	}

	return Array.from(patternRoots);
}

/**
 * Derives non-ambiguous root paths from a pattern.
 *
 * The pattern should not have leading `/` or contain `..`
 *
 * @param pattern
 * @returns
 */
export function derivePatternRoot(pattern: string): string | null {
	if (pattern.startsWith('/')) {
		throw new Error(`Pattern must not start with '/'. Received: '${pattern}'`);
	} else if (pattern.includes('..')) {
		throw new Error(`Pattern must not contain '..'. Received: '${pattern}'`);
	}

	if (['*', `./*`, '**', `./**`, `**/*`, `./**/*`].includes(pattern)) {
		return '/';
	}

	const ambiguousCharacters = ['\\', '[', ']', '(', ')', '{', '}', '@', '!', '+', '?', '|', '^', '$'];
	let root = '';

	for (const c of pattern) {
		if (ambiguousCharacters.includes(c)) {
			if (root.includes('/')) {
				root = root.slice(0, root.lastIndexOf('/') + 1);
			} else {
				root = null;
			}
			break;
		}

		if (c === '*') {
			if (!root.includes('/')) root = null;
			break;
		}

		root += c;
	}

	// static pattern of a file or directory
	if (root === pattern) {
		root = '/';
	}

	return root;
}
