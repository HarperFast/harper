import { readdirSync, readFileSync, existsSync, symlinkSync, rmSync, mkdirSync, realpathSync } from 'node:fs';
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
import harperLogger from '../utility/logging/harper_logger.js';
import * as dataLoader from '../resources/dataLoader.ts';
import { watchDir, getWorkerIndex } from '../server/threads/manageThreads.js';
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
import { Scope } from './Scope.ts';
import { ComponentV1, processResourceExtensionComponent } from './ComponentV1.ts';
import * as httpComponent from '../server/http.ts';
import { Status } from '../server/status/index.ts';

const CF_ROUTES_DIR = resolvePath(env.get(CONFIG_PARAMS.COMPONENTSROOT));
let loadedComponents = new Map<any, any>();
let watchesSetup;
let resources;

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
	const cfsLoaded: Promise<any>[] = [];
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
		cfsLoaded.push(
			loadComponent(hdbAppFolder, resources, hdbAppFolder, false, undefined, Boolean(process.env.DEV_MODE))
		);
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
	http: httpComponent,
	clustering: natsReplicator,
	replication,
	authentication: auth,
	mqtt,
	loadEnv,
	logging: harperLogger,
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

function symlinkHarperModule(componentDirectory: string, harperModule: string) {
	return new Promise<void>((resolve, reject) => {
		const timeout = setTimeout(() => {
			Status.primaryStore.unlock(componentDirectory, 0);
			reject(new Error('symlinking harperdb module timed out'));
		}, 10_000);
		if (
			Status.primaryStore.attemptLock(componentDirectory, 0, () => {
				clearTimeout(timeout);
				resolve();
			})
		) {
			try {
				rmSync(harperModule, { recursive: true, force: true });
				if (!existsSync(join(componentDirectory, 'node_modules'))) {
					mkdirSync(join(componentDirectory, 'node_modules'));
				}
				symlinkSync(PACKAGE_ROOT, harperModule, 'dir');
				resolve();
			} finally {
				Status.primaryStore.unlock(componentDirectory, 0);
			}
		}
	});
}

/**
 * Load a component from the specified directory
 * @param componentPath
 * @param resources
 * @param origin
 * @param portsAllowed
 * @param providedLoadedComponents
 */
export async function loadComponent(
	componentDirectory: string,
	resources: Resources,
	origin: string,
	isRoot?: boolean,
	providedLoadedComponents?: Map<any, any>,
	autoReload?: boolean
) {
	const resolvedFolder = realpathSync(componentDirectory);
	if (loadedPaths.has(resolvedFolder)) return loadedPaths.get(resolvedFolder);
	loadedPaths.set(resolvedFolder, true);
	if (providedLoadedComponents) loadedComponents = providedLoadedComponents;
	try {
		let config;
		if (isRoot) componentErrors = new Map();
		let configPath = join(componentDirectory, 'harperdb-config.yaml'); // look for the specific harperdb-config.yaml first
		if (existsSync(configPath)) {
			config = isRoot ? getConfigObj() : parseDocument(readFileSync(configPath, 'utf8')).toJSON();
			// if not found, look for the generic config.yaml, the config filename we have historically used, but only if not the root
			// eslint-disable-next-line sonarjs/no-nested-assignment
		} else if (!isRoot && existsSync((configPath = join(componentDirectory, 'config.yaml')))) {
			config = parseDocument(readFileSync(configPath, 'utf8')).toJSON();
		} else {
			config = DEFAULT_CONFIG;
		}

		try {
			const harperModule = join(componentDirectory, 'node_modules', 'harperdb');
			if (
				isRoot ||
				((existsSync(harperModule) || !componentDirectory.startsWith(getHdbBasePath())) &&
					(!existsSync(harperModule) || realpathSync(PACKAGE_ROOT) !== realpathSync(harperModule)))
			) {
				await symlinkHarperModule(componentDirectory, harperModule);
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
			componentErrors.set(isRoot ? componentName : basename(componentDirectory), false);
			if (!componentConfig) continue;
			let extensionModule;
			const pkg = componentConfig.package;
			try {
				if (pkg) {
					let containerFolder = componentDirectory;
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

				if (
					'handleComponent' in extensionModule &&
					('start' in extensionModule || 'startOnMainThread' in extensionModule || 'handleFile' in extensionModule)
				) {
					throw new Error(
						`Component ${componentName} has both 'handleComponent' and 'start' or 'startOnMainThread' methods. Please use only one of them.`
					);
				}

				// New Extension API (`handleComponent`)
				if (resources.isWorker && extensionModule.handleComponent) {
					const scope = new Scope(componentName, componentDirectory, configPath, resources, server);

					await scope.ready();

					await extensionModule.handleComponent(scope);

					continue;
				}

				// Old Extension API (`start` or `startOnMainThread`)
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
					const component = new ComponentV1({
						config: componentConfig,
						name: componentName,
						directory: componentDirectory,
						module: extensionModule,
						resources,
					});

					componentFunctionality[componentName] = await processResourceExtensionComponent(component);
				}
			} catch (error) {
				error.message = `Could not load component '${componentName}' for application '${basename(componentDirectory)}' due to: ${
					error.message
				}`;
				errorReporter?.(error);
				(getWorkerIndex() === 0 ? console : harperLogger).error(error);
				resources.set(componentConfig.path || '/', new ErrorResource(error), null, true);
				componentErrors.set(isRoot ? componentName : basename(componentDirectory), error.message);
			}
		}

		compName = parentCompName;
		// Auto restart threads on changes to any app folder. TODO: Make this configurable
		if (isMainThread && !watchesSetup && autoReload) {
			watchDir(componentDirectory, async () => {
				return loadComponentDirectories(); // return the promise
			});
		}
		if (config.extensionModule) {
			const extensionModule = await secureImport(join(componentDirectory, config.extensionModule));
			loadedPaths.set(resolvedFolder, extensionModule);
			return extensionModule;
		}
		const componentFunctionalityValues = Object.values(componentFunctionality);
		if (
			componentFunctionalityValues.length > 0 &&
			componentFunctionalityValues.every((functionality) => !functionality) &&
			resources.isWorker
		) {
			const errorMessage = `${componentDirectory} did not load any modules, resources, or files, is this a valid component?`;
			errorReporter?.(new Error(errorMessage));
			(getWorkerIndex() === 0 ? console : harperLogger).error(errorMessage);
			componentErrors.set(basename(componentDirectory), errorMessage);
		}

		for (const [componentName, functionality] of Object.entries(componentFunctionality)) {
			if (!functionality)
				harperLogger.warn(
					`Component ${componentName} from (${basename(componentDirectory)}) did not load any functionality.`
				);
		}
	} catch (error) {
		console.error(`Could not load application directory ${componentDirectory}`, error);
		error.message = `Could not load application due to ${error.message}`;
		errorReporter?.(error);
		resources.set('', new ErrorResource(error));
	}
}
