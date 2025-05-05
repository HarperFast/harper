import { readdirSync, promises, readFileSync, existsSync, symlinkSync, rmSync, mkdirSync, realpathSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { isMainThread } from 'node:worker_threads';
import { parseDocument } from 'yaml';
import * as env from '../utility/environment/environmentManager.js';
import { PACKAGE_ROOT } from '../utility/packageUtils.js';
import { CONFIG_PARAMS, HDB_ROOT_DIR_NAME } from '../utility/hdbTerms.ts';
import * as graphqlHandler from '../resources/graphql.ts';
import * as graphqlQueryHandler from '../server/graphqlQuerying.ts';
import * as roles from '../resources/roles.ts';
import * as jsHandler from '../resources/jsResource.ts';
import * as login from '../resources/login.ts';
import * as REST from '../server/REST.ts';
import * as fastifyRoutesHandler from '../server/fastifyRoutes.ts';
import * as staticFiles from '../server/static.ts';
import * as loadEnv from '../resources/loadEnv.ts';
import * as dataLoader from '../resources/dataLoader.ts';
import fg from 'fast-glob';
import { watchDir, getWorkerIndex } from '../server/threads/manageThreads.js';
import harperLogger from '../utility/logging/harper_logger.js';
import { secureImport } from '../security/jsLoader.ts';
import { server } from '../server/Server.ts';
import { Resources } from '../resources/Resources.ts';
import { table } from '../resources/databases.ts';
import { startSocketServer } from '../server/threads/socketRouter.ts';
import { getHdbBasePath } from '../utility/environment/environmentManager.js';
import * as operationsServer from '../server/operationsServer.ts';
import * as auth from '../security/auth.ts';
import * as natsReplicator from '../server/nats/natsReplicator.ts';
import * as replication from '../server/replication/replicator.ts';
import * as mqtt from '../server/mqtt.ts';
import { getConfigObj, resolvePath } from '../config/configUtils.js';
import { createReuseportFd } from '../server/serverHelpers/Request.ts';
import { ErrorResource } from '../resources/ErrorResource.ts';

const { readFile } = promises;

const CF_ROUTES_DIR = resolvePath(env.get(CONFIG_PARAMS.COMPONENTSROOT));
let loadedComponents = new Map<any, any>();
let watchesSetup;
let resources;
// eslint-disable-next-line radar/no-unused-collection -- This is not used within this file, but is used within `./operations.js`
export let componentErrors = new Map();

/**
 * Load all the applications registered in HarperDB, those in the components directory as well as any directly
 * specified to run
 * @param loadedPluginModules
 * @param loadedResources
 */
export function loadComponentDirectories(loadedPluginModules?: Map<any, any>, loadedResources?: Resources) {
	if (loadedResources) resources = loadedResources;
	if (loadedPluginModules) loadedComponents = loadedPluginModules;
	const cfsLoaded = [];
	if (existsSync(CF_ROUTES_DIR)) {
		const cfFolders = readdirSync(CF_ROUTES_DIR, { withFileTypes: true });
		for (const appEntry of cfFolders) {
			if (!appEntry.isDirectory() && !appEntry.isSymbolicLink()) continue;
			const appName = appEntry.name;
			const appFolder = join(CF_ROUTES_DIR, appName);
			cfsLoaded.push(loadComponent(appFolder, resources, HDB_ROOT_DIR_NAME, false));
		}
	}
	const hdbAppFolder = process.env.RUN_HDB_APP;
	if (hdbAppFolder) {
		cfsLoaded.push(loadComponent(hdbAppFolder, resources, hdbAppFolder, false, null, Boolean(process.env.DEV_MODE)));
	}
	return Promise.all(cfsLoaded).then(() => {
		watchesSetup = true;
	});
}

const TRUSTED_RESOURCE_LOADERS = {
	REST, // for backwards compatibility with older configs
	rest: REST,
	graphql: graphqlQueryHandler,
	graphqlSchema: graphqlHandler,
	roles,
	jsResource: jsHandler,
	fastifyRoutes: fastifyRoutesHandler,
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
	dataLoader,
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
	// dataLoader: {
	// 	files: 'data/*.{json,yaml,yml}',
	// },
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

const portsStarted = [];
const loadedPaths = new Map();
let errorReporter;
export function setErrorReporter(reporter) {
	errorReporter = reporter;
}

let compName: string;
export const getComponentName = () => compName;

/**
 * Load a component from the specified directory
 * @param componentPath
 * @param resources
 * @param origin
 * @param portsAllowed
 * @param providedLoadedComponents
 */
export async function loadComponent(
	folder: string,
	resources: Resources,
	origin: string,
	isRoot?: boolean,
	providedLoadedComponents?: Map<any, any>,
	autoReload?: boolean
) {
	const resolvedFolder = realpathSync(folder);
	if (loadedPaths.has(resolvedFolder)) return loadedPaths.get(resolvedFolder);
	loadedPaths.set(resolvedFolder, true);
	if (providedLoadedComponents) loadedComponents = providedLoadedComponents;
	try {
		let config;
		if (isRoot) componentErrors = new Map();
		let configPath = join(folder, 'harperdb-config.yaml'); // look for the specific harperdb-config.yaml first
		if (existsSync(configPath)) {
			config = isRoot ? getConfigObj() : parseDocument(readFileSync(configPath, 'utf8')).toJSON();
			// if not found, look for the generic config.yaml, the config filename we have historically used, but only if not the root
		} else if (!isRoot && existsSync((configPath = join(folder, 'config.yaml')))) {
			config = parseDocument(readFileSync(configPath, 'utf8')).toJSON();
		} else {
			config = DEFAULT_CONFIG;
		}

		const harperdbModule = join(folder, 'node_modules', 'harperdb');
		try {
			if (
				isMainThread &&
				(isRoot ||
					((existsSync(harperdbModule) || !folder.startsWith(getHdbBasePath())) &&
						(!existsSync(harperdbModule) || realpathSync(PACKAGE_ROOT) !== realpathSync(harperdbModule))))
			) {
				// if the app has a harperdb module, we symlink it to the main app so it can be used in the main app (with the running modules)
				rmSync(harperdbModule, { recursive: true, force: true });
				if (!existsSync(join(folder, 'node_modules'))) {
					mkdirSync(join(folder, 'node_modules'));
				}
				symlinkSync(PACKAGE_ROOT, harperdbModule, 'dir');
			}
		} catch (error) {
			harperLogger.error('Error symlinking harperdb module', error);
			if (error.code == 'EPERM' && process.platform === 'win32') {
				harperLogger.error(
					'You may need to enable developer mode in "Settings" / "System" (or "Update & Security") / "For developers", in order to enable symlinks so components can use `import from "harperdb"`'
				);
			}
		}

		const parentCompName: string = compName;
		const componentFunctionality = {};
		// iterate through the app handlers so they can each do their own loading process
		for (const componentName in config) {
			compName = componentName;
			const componentConfig = config[componentName];
			componentErrors.set(isRoot ? componentName : basename(folder), false);
			if (!componentConfig) continue;
			let extensionModule;
			const pkg = componentConfig.package;
			try {
				if (pkg) {
					let containerFolder = folder;
					let componentPath;
					while (!existsSync((componentPath = join(containerFolder, 'node_modules', componentName)))) {
						containerFolder = dirname(containerFolder);
						if (containerFolder.length < getHdbBasePath().length) {
							componentPath = null;
							break;
						}
					}
					if (componentPath) {
						extensionModule = await loadComponent(componentPath, resources, origin, false);
						componentFunctionality[componentName] = true;
					} else {
						throw new Error(`Unable to find package ${componentName}:${pkg}`);
					}
				} else extensionModule = TRUSTED_RESOURCE_LOADERS[componentName];
				if (!extensionModule) continue;
				// our own trusted modules can be directly retrieved from our map, otherwise use the (configurable) secure module loader
				const ensureTable = (options) => {
					options.origin = origin;
					return table(options);
				};
				// call the main start hook
				const network =
					componentConfig.network || ((componentConfig.port || componentConfig.securePort) && componentConfig);
				const securePort =
					network?.securePort ||
					// legacy support for switching to securePort
					(network?.https && network.port);
				const port = !network?.https && network?.port;
				if (isMainThread) {
					extensionModule =
						(await extensionModule.startOnMainThread?.({
							server,
							ensureTable,
							port,
							securePort,
							resources,
							...componentConfig,
						})) || extensionModule;
					if (isRoot && network) {
						for (const possiblePort of [port, securePort]) {
							try {
								if (+possiblePort && !portsStarted.includes(possiblePort)) {
									const sessionAffinity = env.get(CONFIG_PARAMS.HTTP_SESSIONAFFINITY);
									if (sessionAffinity)
										harperLogger.warn('Session affinity is not recommended and may cause memory leaks');
									if (sessionAffinity || !createReuseportFd) {
										// if there is a TCP port associated with the plugin, we set up the routing on the main thread for it
										portsStarted.push(possiblePort);
										startSocketServer(possiblePort, sessionAffinity);
									}
								}
							} catch (error) {
								console.error('Error listening on socket', possiblePort, error, componentName);
							}
						}
					}
				}
				if (resources.isWorker)
					extensionModule =
						(await extensionModule.start?.({
							server,
							ensureTable,
							port,
							securePort,
							resources,
							...componentConfig,
						})) || extensionModule;
				loadedComponents.set(extensionModule, true);

				if (
					(extensionModule.handleFile ||
						extensionModule.handleDirectory ||
						extensionModule.setupFile ||
						extensionModule.setupDirectory) &&
					componentConfig.files != undefined
				) {
					const component = new Component({
						config: componentConfig,
						name: componentName,
						directory: folder,
						module: extensionModule,
						resources,
					});

					componentFunctionality[componentName] = await processResourceExtensionComponent(component);
				}
			} catch (error) {
				error.message = `Could not load component '${componentName}' for application '${basename(folder)}' due to: ${
					error.message
				}`;
				errorReporter?.(error);
				(getWorkerIndex() === 0 ? console : harperLogger).error(error);
				resources.set(componentConfig.path || '/', new ErrorResource(error), null, true);
				componentErrors.set(isRoot ? componentName : basename(folder), error.message);
			}
		}

		compName = parentCompName;
		// Auto restart threads on changes to any app folder. TODO: Make this configurable
		if (isMainThread && !watchesSetup && autoReload) {
			watchDir(folder, async () => {
				return loadComponentDirectories(); // return the promise
			});
		}
		if (config.extensionModule) {
			const extensionModule = await secureImport(join(folder, config.extensionModule));
			loadedPaths.set(resolvedFolder, extensionModule);
			return extensionModule;
		}
		const componentFunctionalityValues = Object.values(componentFunctionality);
		if (componentFunctionalityValues.length > 0 && componentFunctionalityValues.every((functionality) => !functionality) && resources.isWorker) {
			const errorMessage = `${folder} did not load any modules, resources, or files, is this a valid component?`;
			errorReporter?.(new Error(errorMessage));
			(getWorkerIndex() === 0 ? console : harperLogger).error(errorMessage);
			componentErrors.set(basename(folder), errorMessage);
		}

		for (const [componentName, functionality] of Object.entries(componentFunctionality)) {
			if (!functionality)
				harperLogger.warn(`Component ${componentName} from (${basename(folder)}) did not load any functionality.`);
		}
	} catch (error) {
		console.error(`Could not load application directory ${folder}`, error);
		error.message = `Could not load application due to ${error.message}`;
		errorReporter?.(error);
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
			harperLogger.warn(`Resource extension 'path' option is deprecated. Please replace with 'urlPath'.`);
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
				harperLogger.warn(
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
		harperLogger.warn(
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
			harperLogger.error(
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
