import { readdirSync, readFileSync, existsSync, realpathSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
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
import * as mqtt from '../server/mqtt.ts';
import { getConfigObj, resolvePath } from '../config/configUtils.js';
import { createReuseportFd } from '../server/serverHelpers/Request.ts';
import { ErrorResource } from '../resources/ErrorResource.ts';
import { Scope } from './Scope.ts';
import { ComponentV1, processResourceExtensionComponent } from './ComponentV1.ts';
import * as httpComponent from '../server/http.ts';
import { Status } from '../server/status/index.ts';
import { lifecycle as componentLifecycle } from './status/index.ts';
import { DEFAULT_CONFIG } from './DEFAULT_CONFIG.ts';
import { PluginModule } from './PluginModule.ts';
import { platform } from 'node:os';
import { getEnvBuiltInComponents } from './Application.ts';

const CF_ROUTES_DIR = resolvePath(env.get(CONFIG_PARAMS.COMPONENTSROOT));
let loadedComponents = new Map<any, any>();
let watchesSetup;
let resources;

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

const TRUSTED_RESOURCE_PLUGINS = {
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

for (const { name, packageIdentifier } of getEnvBuiltInComponents()) {
	TRUSTED_RESOURCE_PLUGINS[name] = packageIdentifier;
}

const portsStarted = [];
const loadedPaths = new Map();
let errorReporter;
export function setErrorReporter(reporter) {
	errorReporter = reporter;
}

let compName: string;
export const getComponentName = () => compName;

function symlinkHarperModule(componentDirectory: string) {
	return new Promise<void>((resolve, reject) => {
		// Create timeout to avoid deadlocks
		const timeout = setTimeout(() => {
			Status.primaryStore.unlock(componentDirectory, 0);
			reject(new Error('symlinking harperdb module timed out'));
		}, 10_000);
		if (
			// Get lock for this component
			Status.primaryStore.attemptLock(componentDirectory, 0, () => {
				clearTimeout(timeout);
				resolve();
			})
		) {
			try {
				// validate node_modules directory exists
				const nodeModulesDir = join(componentDirectory, 'node_modules');
				if (!existsSync(nodeModulesDir)) {
					// create it if not
					mkdirSync(nodeModulesDir);
				}

				// validate harperdb module
				const harperModule = join(nodeModulesDir, 'harperdb');
				if (existsSync(harperModule)) {
					if (realpathSync(harperModule) === realpathSync(PACKAGE_ROOT)) {
						// if it exists and correctly linked, resolve
						return resolve();
					}

					// Otherwise remove it then link
					rmSync(harperModule, { recursive: true, force: true });
				}

				// create link to harperdb module
				symlinkSync(PACKAGE_ROOT, harperModule, 'dir');
				resolve();
			} finally {
				// finally release the lock
				Status.primaryStore.unlock(componentDirectory, 0);
			}
		}
	});
}

/**
 * This function handles the `handleApplication` call for a plugin in a sequential manner.
 * It ensures the execution of `handleApplication` happens on one thread at a time for a given scope.
 * If the lock cannot be acquired, it waits for the lock to be released and retries.
 * If the lock is not acquired within the specified timeout, it rejects with a timeout error.
 *
 * @param scope
 * @param plugin
 * @returns
 */
function sequentiallyHandleApplication(scope: Scope, plugin: PluginModule) {
	return scope.ready.then(() => {
		// Timeout priority is user config, plugin default, finally 30 seconds
		const timeout = scope.options.get(['timeout']) || plugin.defaultTimeout || 30_000; // default 30 second timeout
		if (typeof timeout !== 'number') {
			throw new Error(`Invalid timeout value for ${scope.name}. Expected a number, received: ${typeof timeout}`);
		}
		let whenResolved, timer;
		if (
			!Status.primaryStore.attemptLock(scope.name, 0, () => {
				clearTimeout(timer);
				whenResolved(sequentiallyHandleApplication(scope, plugin));
			})
		) {
			return new Promise((resolve, reject) => {
				whenResolved = resolve;
				timer = setTimeout(() => {
					reject(new Error(`Timeout waiting for lock on ${scope.name}`));
				}, timeout + 5_000); // extra time for lock acquisition
			});
		}

		return Promise.race([
			plugin.handleApplication(scope),
			new Promise((_, reject) =>
				setTimeout(() => reject(new Error(`handleApplication timed out after ${timeout}ms for ${scope.name}`)), timeout)
			),
		]).finally(() => {
			Status.primaryStore.unlock(scope.name, 0);
		});
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

		if (!isRoot) {
			try {
				await symlinkHarperModule(componentDirectory);
			} catch (error) {
				harperLogger.error('Error symlinking harperdb module', error);
				if (error.code == 'EPERM' && process.platform === 'win32') {
					harperLogger.error(
						'You may need to enable developer mode in "Settings" / "System" (or "Update & Security") / "For developers", in order to enable symlinks so components can use `import from "harperdb"`'
					);
				}
			}
		}

		const parentCompName: string = compName;
		const componentFunctionality = {};
		// iterate through the app handlers so they can each do their own loading process
		for (const componentName in config) {
			// For root components, use just the component name
			// For application components, use applicationName.componentName format (directoryName.componentName)
			const componentStatusName = isRoot ? componentName : `${basename(componentDirectory)}.${componentName}`;

			compName = componentName;
			const componentConfig = config[componentName];
			if (!componentConfig) continue;

			// Initialize loading status for all components (applications and extensions)
			componentLifecycle.loading(componentStatusName);

			let extensionModule: any;
			const pkg = componentConfig.package;
			try {
				if (pkg) {
					let componentPath: string | null = null;
					if (isRoot) {
						componentPath = join(componentDirectory, 'components', componentName);
					} else {
						let containerFolder = componentDirectory;
						componentPath = join(containerFolder, 'node_modules', componentName);
						while (!existsSync(componentPath)) {
							containerFolder = dirname(containerFolder);
							if (containerFolder.length < getHdbBasePath().length) {
								componentPath = null;
								break;
							}
							componentPath = join(containerFolder, 'node_modules', componentName);
						}
					}
					if (componentPath) {
						extensionModule = await loadComponent(componentPath, resources, origin, false);
						componentFunctionality[componentName] = true;
					} else {
						throw new Error(`Unable to find package ${componentName}:${pkg}`);
					}
				} else {
					const plugin = TRUSTED_RESOURCE_PLUGINS[componentName];
					extensionModule =
						typeof plugin === 'string'
							? await secureImport(plugin.startsWith('@/') ? join(PACKAGE_ROOT, plugin.slice(1)) : plugin)
							: plugin;
				}

				if (!extensionModule) {
					// This is an application-only component (no extension module)
					// Mark it as loaded since it exists in the config
					componentLifecycle.loaded(componentStatusName, `Application component '${componentStatusName}' processed`);
					continue;
				}

				// our own trusted modules can be directly retrieved from our map, otherwise use the (configurable) secure module loader
				const ensureTable = (options: any) => {
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
					'handleApplication' in extensionModule &&
					('start' in extensionModule ||
						'startOnMainThread' in extensionModule ||
						'handleFile' in extensionModule ||
						'handleDirectory' in extensionModule ||
						'setupFile' in extensionModule ||
						'setupDirectory' in extensionModule)
				) {
					const error = new Error(`Plugin ${componentName} is exporting old extension APIs. Remove them.`);
					componentLifecycle.failed(componentStatusName, error, `Component '${componentStatusName}' failed to load`);
					throw error;
				}

				// New Plugin API (`handleApplication`)
				if (resources.isWorker && extensionModule.handleApplication) {
					if (extensionModule.suppressHandleApplicationWarning !== true) {
						harperLogger.warn(`Plugin ${componentName} is using the experimental handleApplication API`);
					}

					const scope = new Scope(componentName, componentDirectory, configPath, resources, server);

					await sequentiallyHandleApplication(scope, extensionModule);

					// Mark component as loaded after successful handleApplication call
					componentLifecycle.loaded(componentStatusName, `Component '${componentStatusName}' loaded successfully`);

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

				// Mark component as healthy after successful loading
				componentLifecycle.loaded(componentStatusName, `Component '${componentStatusName}' loaded successfully`);
			} catch (error) {
				error.message = `Could not load component '${componentName}' for application '${basename(componentDirectory)}' due to: ${
					error.message
				}`;
				errorReporter?.(error);
				(getWorkerIndex() === 0 ? console : harperLogger).error(error);
				resources.set(componentConfig.path || '/', new ErrorResource(error), null, true);
				componentLifecycle.failed(componentStatusName, error, `Could not load component '${componentStatusName}'`);
			}
		}

		compName = parentCompName;
		// Auto restart threads on changes to any app folder. TODO: Make this configurable
		if (isMainThread && !watchesSetup && autoReload) {
			watchDir(componentDirectory, async () => {
				return loadComponentDirectories(); // return the promise
			});
		}
		if (config.extensionModule || config.pluginModule) {
			const extensionModule = await secureImport(
				join(componentDirectory, config.extensionModule || config.pluginModule)
			);
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
			componentLifecycle.failed(basename(componentDirectory), errorMessage);
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
