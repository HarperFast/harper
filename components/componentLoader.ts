import { onMessageByType } from '../server/threads/manageThreads.js';
import {
	readdirSync,
	readFileSync,
	existsSync,
	lstatSync,
	realpathSync,
	mkdirSync,
	rmSync,
	symlinkSync,
} from 'node:fs';
import { join, basename, dirname, sep } from 'node:path';
import { isMainThread } from 'node:worker_threads';
import { parseDocument } from 'yaml';
import * as env from '../utility/environment/environmentManager.ts';
import { PACKAGE_ROOT } from '../utility/packageUtils.js';
import { CONFIG_PARAMS, HDB_ROOT_DIR_NAME, ITC_EVENT_TYPES } from '../utility/hdbTerms.ts';
import * as graphqlHandler from '../resources/graphql.ts';
import * as graphqlQueryHandler from '../server/graphqlQuerying.ts';
import * as roles from '../resources/roles.ts';
import * as jsHandler from '../resources/jsResource.ts';
import * as login from '../resources/login.ts';
import * as REST from '../server/REST.ts';
import * as staticFiles from '../server/static.ts';
import * as loadEnv from '../resources/loadEnv.ts';
import harperLogger, { errorForLog } from '../utility/logging/harper_logger.ts';
import * as dataLoader from '../resources/dataLoader.ts';
import * as scheduler from '../resources/scheduler/scheduler.ts';
import { restartWorkers, getWorkerIndex } from '../server/threads/manageThreads.js';
import { resetRestartNeeded, subscribeToRestartRequests } from './requestRestart.ts';
import { trackScopeClose } from './scopeShutdown.ts';
import { deployLifecycle } from './deployLifecycle.ts';
import { toScopeMount, nestScopeMount, type ScopeMount } from './scopeMount.ts';
import { scopedImport } from '../security/jsLoader.ts';
import { server } from '../server/Server.ts';
import { Resources } from '../resources/Resources.ts';
import { table } from '../resources/databases.ts';
import { getHdbBasePath } from '../utility/environment/environmentManager.ts';
import * as auth from '../security/auth.ts';
import * as mqtt from '../server/mqtt.ts';
import { getConfigObj, getConfigPath } from '../config/configUtils.ts';
import { bootstrapModels } from '../resources/models/bootstrap.ts';
import { ErrorResource } from '../resources/ErrorResource.ts';
import { Scope } from './Scope.ts';
import { ApplicationScope } from './ApplicationScope.ts';
import { ComponentV1, processResourceExtensionComponent } from './ComponentV1.ts';
import * as httpComponent from '../server/http.ts';
import * as mcpComponent from './mcp/index.ts';
import { Status } from '../server/status/index.ts';
import { lifecycle as componentLifecycle, statusForComponent } from './status/index.ts';
import { DEFAULT_CONFIG } from './DEFAULT_CONFIG.ts';
import { materializeGlobalSecrets, processComponentEnv } from './componentSecrets.ts';
import { PluginModule } from './PluginModule.ts';
import {
	getEnvBuiltInComponents,
	recoverInterruptedComponentExtraction,
	recoverInterruptedComponentExtractions,
	unsettleableComponentsFromDisk,
} from './Application.ts';
import { ComponentPreparationLockTimeoutError } from './componentPreparationLock.ts';
import { pathToFileURL } from 'node:url';

const CF_ROUTES_DIR = getConfigPath(CONFIG_PARAMS.COMPONENTSROOT);

let loadedComponents = new Map<any, any>();
let watchesSetup;
let resources;
const componentLoadTails = new Map<string, Promise<void>>();
type ComponentReadyPromises = WeakMap<object, Promise<void>>;

function serializeComponentLoad<T>(appName: string, load: () => Promise<T>): Promise<T> {
	const previousLoad = componentLoadTails.get(appName);
	const currentLoad = previousLoad ? previousLoad.then(load) : load();
	const loadTail = currentLoad.then(
		() => undefined,
		() => undefined
	);
	componentLoadTails.set(appName, loadTail);
	void loadTail.then(() => {
		if (componentLoadTails.get(appName) === loadTail) componentLoadTails.delete(appName);
	});
	return currentLoad;
}

export async function readyComponentModules(
	serverModules: Iterable<any>,
	readyComponentPromises: ComponentReadyPromises = new WeakMap()
): Promise<void> {
	const readyPromises: Promise<void>[] = [];
	for (const serverModule of serverModules) {
		if (
			(typeof serverModule !== 'object' && typeof serverModule !== 'function') ||
			serverModule === null ||
			typeof serverModule.ready !== 'function'
		) {
			continue;
		}
		let readyPromise = readyComponentPromises.get(serverModule);
		if (!readyPromise) {
			readyPromise = Promise.resolve().then(() => serverModule.ready());
			readyComponentPromises.set(serverModule, readyPromise);
			void readyPromise.catch(() => readyComponentPromises.delete(serverModule));
		}
		readyPromises.push(readyPromise);
	}
	await Promise.all(readyPromises);
}

/**
 * Load all the applications registered in Harper, those in the components directory as well as any directly
 * specified to run
 * @param loadedPluginModules
 * @param loadedResources
 */
/**
 * The application mount an operator declared for `appName` in the root config.
 *
 * Applications in the components root are loaded by directory scan, not from a root-config
 * entry, so this is what makes a root-config entry authoritative for where an app is served:
 *
 * ```yaml
 * my-app:
 *   host: api.example.com
 *   urlPath: /v1
 * ```
 *
 * Works whether or not the entry also carries `package` — a payload-deployed app is mounted the
 * same way as an installed one. A built-in plugin's config block is never an application mount;
 * those keys (`http`, `mqtt`, …) configure the plugin itself.
 */
function rootConfigMount(appName: string): ScopeMount | undefined {
	if (Object.hasOwn(TRUSTED_RESOURCE_PLUGINS, appName)) return undefined;
	return toScopeMount(getConfigObj()?.[appName]);
}

/**
 * Resolves the mount for `appName`, or reports the failure and returns `undefined` if the
 * configured `host`/`urlPath` is invalid. The caller must skip loading the application in that
 * case rather than loading it anyway: an invalid mount is a request to CONSTRAIN where the app is
 * served, so loading it unconstrained would silently drop the isolation the operator configured
 * (review finding) — worse than not loading it at all. Isolated per-app so one bad mount doesn't
 * take down every other application's load.
 */
function tryRootConfigMount(appName: string): { ok: true; mount: ScopeMount | undefined } | { ok: false } {
	try {
		return { ok: true, mount: rootConfigMount(appName) };
	} catch (error) {
		(error as Error).message = `Not loading '${appName}': invalid routing configured: ${(error as Error).message}`;
		errorReporter?.(error);
		(getWorkerIndex() === 0 ? console : harperLogger).error(errorForLog(error as Error));
		componentLifecycle.failed(
			appName,
			error as Error,
			`Component '${appName}' failed to load due to invalid routing configuration`
		);
		return { ok: false };
	}
}

export async function loadComponentDirectories(
	loadedPluginModules?: Map<any, any>,
	loadedResources?: Resources,
	readyComponentPromises: ComponentReadyPromises = new WeakMap(),
	// Settled by boot BEFORE installApplications(), because that installs from the root config and would
	// otherwise reinstall the previous release over an already-live candidate. `undefined` on a worker,
	// which never runs that pass — distinct from an empty map, which would claim nothing is unreconciled.
	interruptedActivationFailures?: Map<string, Error>
) {
	if (loadedResources) resources = loadedResources;
	if (loadedPluginModules) loadedComponents = loadedPluginModules;
	const cycleResources = resources;
	const failedRecoveries = new Map<string, Error>(interruptedActivationFailures ?? []);
	if (!interruptedActivationFailures) {
		// No verdict from boot means this is a worker, which never runs the recovery pass. It reads the same
		// evidence instead: a component whose activation could not be settled must not load here either,
		// since workers are what actually serve it.
		try {
			for (const [component, error] of await unsettleableComponentsFromDisk(CF_ROUTES_DIR)) {
				if (!failedRecoveries.has(component)) failedRecoveries.set(component, error);
			}
		} catch (error) {
			harperLogger.warn(
				'Could not check for unsettled component activations:',
				errorForLog(error instanceof Error ? error : new Error(String(error)))
			);
		}
	}
	try {
		for (const [component, error] of await recoverInterruptedComponentExtractions(CF_ROUTES_DIR)) {
			if (!failedRecoveries.has(component)) failedRecoveries.set(component, error);
		}
	} catch (error) {
		const recoveryError = error instanceof Error ? error : new Error(String(error));
		harperLogger.warn(
			'Loading existing filesystem components without deploy recovery because staging could not be inspected:',
			errorForLog(recoveryError)
		);
	}
	// Materialize hdb_secret global-tier rows into process.env and snapshot the scoped tier before
	// any application loads (root components — including the Pro custody registration — have
	// already loaded by this point). Re-runs on each reload cycle, which is how changed/late-custody
	// secrets heal. Never throws.
	await materializeGlobalSecrets();
	const cfsLoaded: Promise<any>[] = [];
	const deferredRecoveries = new Map(
		[...failedRecoveries].filter(([, error]) => error instanceof ComponentPreparationLockTimeoutError)
	);
	const unreportedFailedRecoveries = new Map(
		[...failedRecoveries].filter(([, error]) => !(error instanceof ComponentPreparationLockTimeoutError))
	);
	const deferComponentLoad = (appName: string) => {
		const appFolder = join(CF_ROUTES_DIR, appName);
		const appWasVisible = existsSync(appFolder);
		if (appWasVisible) {
			componentLifecycle.loading(appName, `Component '${appName}' is waiting for in-progress preparation to finish`);
		}
		void serializeComponentLoad(appName, () =>
			recoverInterruptedComponentExtraction(CF_ROUTES_DIR, appName)
				.then(async () => {
					if (!existsSync(appFolder)) {
						if (appWasVisible) {
							statusForComponent(appName).unknown('Component directory no longer exists after preparation settled');
						}
						return;
					}
					const mountResult = tryRootConfigMount(appName);
					if (!mountResult.ok) return;
					const loadedModules = new Set<any>();
					await loadComponent(appFolder, cycleResources, HDB_ROOT_DIR_NAME, {
						isRoot: false,
						autoReload: false,
						appName,
						mount: mountResult.mount,
						collectLoadedModules: loadedModules,
					});
					await readyComponentModules(loadedModules, readyComponentPromises);
				})
				.catch((error) => {
					const recoveryError = error instanceof Error ? error : new Error(String(error));
					if (appWasVisible) {
						componentLifecycle.failed(
							appName,
							recoveryError,
							`Component '${appName}' failed to load after waiting for in-progress preparation`
						);
					}
				})
		);
	};
	if (existsSync(CF_ROUTES_DIR)) {
		const cfFolders = readdirSync(CF_ROUTES_DIR, { withFileTypes: true });
		for (const appEntry of cfFolders) {
			if (!appEntry.isDirectory() && !appEntry.isSymbolicLink()) continue;
			// Skip hidden entries: component names are never dot-prefixed, and this keeps
			// Harper's own staging dirs (e.g. deploy aside copies) from loading as components.
			if (appEntry.name.startsWith('.')) continue;
			const appName = appEntry.name;
			const recoveryError = failedRecoveries.get(appName);
			if (recoveryError) {
				if (recoveryError instanceof ComponentPreparationLockTimeoutError) {
					deferredRecoveries.delete(appName);
					deferComponentLoad(appName);
					continue;
				}
				unreportedFailedRecoveries.delete(appName);
				componentLifecycle.failed(
					appName,
					recoveryError,
					`Component '${appName}' failed to load because its interrupted deployment could not be recovered`
				);
				continue;
			}
			const appFolder = join(CF_ROUTES_DIR, appName);
			const mountResult = tryRootConfigMount(appName);
			if (!mountResult.ok) continue;
			cfsLoaded.push(
				serializeComponentLoad(appName, () =>
					loadComponent(appFolder, cycleResources, HDB_ROOT_DIR_NAME, {
						isRoot: false,
						autoReload: false,
						appName,
						mount: mountResult.mount,
					})
				).catch((error) => {
					const loadError = error instanceof Error ? error : new Error(String(error));
					componentLifecycle.failed(appName, loadError, `Component '${appName}' failed to load`);
				})
			);
		}
	}
	for (const [appName, recoveryError] of unreportedFailedRecoveries) {
		componentLifecycle.failed(
			appName,
			recoveryError,
			`Component '${appName}' failed to load because its interrupted deployment could not be recovered`
		);
	}
	for (const appName of deferredRecoveries.keys()) deferComponentLoad(appName);
	const hdbAppFolder = process.env.RUN_HDB_APP;
	if (hdbAppFolder) {
		if (getWorkerIndex() === 0) harperLogger.info?.('Loading application from ' + hdbAppFolder);
		const mountResult = tryRootConfigMount(basename(hdbAppFolder));
		if (mountResult.ok) {
			cfsLoaded.push(
				serializeComponentLoad(hdbAppFolder, () =>
					loadComponent(hdbAppFolder, cycleResources, hdbAppFolder, {
						isRoot: false,
						autoReload: Boolean(process.env.DEV_MODE),
						appName: hdbAppFolder,
						mount: mountResult.mount,
					})
				)
			);
		}
	}
	return await Promise.all(cfsLoaded).then(() => {
		watchesSetup = true;
	});
}

export const TRUSTED_RESOURCE_PLUGINS: any = {
	REST, // for backwards compatibility with older configs
	rest: REST,
	graphql: graphqlQueryHandler,
	graphqlSchema: graphqlHandler,
	roles,
	jsResource: jsHandler,
	get fastifyRoutes() {
		return require('../server/fastifyRoutes');
	},
	login,
	// String entry: the loader `await import()`s these lazily when the component is actually
	// processed, so the gateway's module graph is not pulled into componentLoader's own
	// evaluation. `#src/*` is used rather than a relative path because it resolves under both
	// conditions (source under --conditions=typestrip, dist otherwise); a relative extensionless
	// require would only resolve against dist.
	//
	// The component is only *processed* when a `modelsGateway` key exists in the config, since
	// the root loop skips absent keys (`if (!componentConfig) continue`). `defaultConfig.yaml`
	// ships no such key, so an instance that never opts in pays nothing for this entry.
	modelsGateway: '#src/resources/models/v1/index',
	static: staticFiles,
	customFunctions: {},
	http: httpComponent,
	authentication: auth,
	mqtt,
	loadEnv,
	logging: harperLogger,
	dataLoader,
	mcp: mcpComponent,
	scheduler,
	/*
	static: ...
	login: ...
	 */
};
if (isMainThread) {
	TRUSTED_RESOURCE_PLUGINS.operationsApi = require('../server/operationsServer');
	// Built-in agent component (#626). Only loads if the root config carries an `agent:` block;
	// the block's `enabled: false` default keeps it inert even when the key is present.
	TRUSTED_RESOURCE_PLUGINS.agent = require('../agent/agent');
} else {
	// The HTTP operations API itself only binds in the main thread, but worker threads still
	// dispatch operations — most notably, the replication WebSocket handler in workers receives
	// inter-node operations like `add_node_back` and calls `server.operation(...)`. That requires
	// `server.operation` / `server.registerOperation` to be wired up here too, and the operation
	// function map to be initialized, BEFORE component plugins (replication, etc.) load and call
	// `server.registerOperation?.({...})` at their module top level. Requiring serverUtilities
	// directly (rather than the full operationsServer) avoids binding the fastify HTTP layer in
	// workers while still installing the dispatch machinery.
	require('../server/serverHelpers/serverUtilities');
}

for (const { name, packageIdentifier } of getEnvBuiltInComponents()) {
	TRUSTED_RESOURCE_PLUGINS[name] = packageIdentifier;
}

const BUILT_INS = Object.keys(TRUSTED_RESOURCE_PLUGINS);

export const loadedPaths = new Map();

// Tracks which components have already had `startOnMainThread` invoked, so it runs at most once
// per component for the life of the process (the documented one-time main-thread init contract).
// Keyed by stable component identity (name + resolved directory) rather than the module instance
// (`loadedComponents`) or the per-pass `loadedPaths` map — a reload re-imports the module (new
// instance) and `loadedPaths` is cleared on the reload path, so neither dedupes across reloads.
// The stored value is the post-`startOnMainThread` module so a reload reuses the same wiring
// (handleFile/handleDirectory, loadedComponents) without re-running main-thread init. See #460:
// re-invoking `startOnMainThread` on every reload accumulated watchers/routes and re-ran
// destructive one-time scans (e.g. the replicator's hdb_nodes subscription scan).
export const mainThreadInitialized = new Map<string, any>();

let errorReporter;
/**
 * Forget that a directory was loaded, so a throwaway load does not retain it forever. `loadedPaths` is
 * keyed by realpath and never pruned, and every deploy validates a candidate under a fresh
 * `.deploy-staging/<uuid>/` path — so without this the map grows by one dead entry per deploy for the life
 * of the process.
 */
export function forgetLoadedPath(componentDirectory: string): void {
	let resolved: string | undefined;
	try {
		resolved = realpathSync(componentDirectory);
	} catch {
		// Already renamed live or discarded; fall through and prune by prefix anyway.
	}
	if (resolved) loadedPaths.delete(resolved);
	// Nested `loadComponent()` calls register plugin and dependency realpaths UNDER the candidate, so
	// deleting only the root leaves those behind — one dead entry per nested load, per deploy, forever.
	const prefixes = [componentDirectory, resolved].filter(Boolean) as string[];
	for (const key of loadedPaths.keys()) {
		if (typeof key === 'string' && prefixes.some((prefix) => key === prefix || key.startsWith(prefix + sep))) {
			loadedPaths.delete(key);
		}
	}
}

/** So a caller that installs a reporter can put the previous one back when it is done with it. */
export function getErrorReporter() {
	return errorReporter;
}
export function setErrorReporter(reporter) {
	errorReporter = reporter;
}

let compName: string;
export const getComponentName = () => compName;

/**
 * Symlink a component's `node_modules/harper` (and `harperdb`) to this running Harper install,
 * rather than letting it resolve a separately-installed npm copy.
 *
 * This is what makes `import { tables } from 'harper'` (or `import 'harperdb'`) inside component
 * code — including bundler-loaded code such as a Vite SSR entry — resolve to the SAME module
 * instance Harper is running. That instance carries the live, process-wide exports
 * (`tables`/`databases`/`Resource`/…) populated via `_assignPackageExport` (see ../globals.js and
 * ../index.ts), so the import yields live data, not an empty separate copy. The link is verified on
 * every non-root component load and repaired if missing or pointing elsewhere.
 */
function symlinkHarperModule(componentDirectory: string) {
	return new Promise<void>((resolve) => {
		const store = Status.primaryStore;
		let timeout: NodeJS.Timeout;
		const onUnlocked = () => {
			clearTimeout(timeout);
			resolve();
		};
		const lockAcquired = store.tryLock(componentDirectory, onUnlocked);

		if (!lockAcquired) {
			// The lock holder performs the fixup; wait for its unlock. The timer bounds the wait if
			// the holder dies without unlocking, and must stay ref'd: the unlock wake arrives via an
			// unref'd threadsafe function (see the invariant comment in threadServer.startServers).
			// Timing out resolves rather than rejects: the fixup is idempotent maintenance, never
			// worth failing the component load over.
			timeout = setTimeout(() => {
				harperLogger.warn(
					`Timed out waiting for another thread to verify the harper module link in ${componentDirectory}; continuing with the link in its current state`
				);
				resolve();
			}, 10_000);
		} else {
			try {
				// validate node_modules directory exists
				const nodeModulesDir = join(componentDirectory, 'node_modules');
				if (!existsSync(nodeModulesDir)) {
					// create it if not
					mkdirSync(nodeModulesDir);
				}

				// validate harper module
				const harperModule = join(nodeModulesDir, 'harper');
				let harperModuleLinked = false;
				try {
					lstatSync(harperModule); // throws ENOENT if absent; succeeds even for dangling symlinks
					harperModuleLinked = realpathSync(harperModule) === realpathSync(PACKAGE_ROOT);
				} catch {}
				if (!harperModuleLinked) {
					rmSync(harperModule, { recursive: true, force: true });
					symlinkSync(PACKAGE_ROOT, harperModule, 'dir');
				}
				// if there is a harperdb module, fix that too
				const harperdbModule = join(nodeModulesDir, 'harperdb');
				let harperdbModulePresent = false;
				let harperdbModuleLinked = false;
				try {
					lstatSync(harperdbModule);
					harperdbModulePresent = true;
					harperdbModuleLinked = realpathSync(harperdbModule) === realpathSync(PACKAGE_ROOT);
				} catch {}
				if (harperdbModulePresent && !harperdbModuleLinked) {
					rmSync(harperdbModule, { recursive: true, force: true });
					symlinkSync(PACKAGE_ROOT, harperdbModule, 'dir');
				}

				resolve();
			} finally {
				// finally release the lock
				store.unlock(componentDirectory);
			}
		}
	});
}

// Direct access keeps lock timing deterministic without exposing a broader component-load seam.
export const _symlinkHarperModuleForTests = symlinkHarperModule;

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
	return scope.ready.then(async () => {
		await scope.waitForDeployCompletion();
		// Timeout priority is user config, plugin default, finally 30 seconds
		const timeout = scope.options.get(['timeout']) || plugin.defaultTimeout || 30_000; // default 30 second timeout
		if (typeof timeout !== 'number') {
			throw new Error(`Invalid timeout value for ${scope.pluginName}. Expected a number, received: ${typeof timeout}`);
		}
		let whenResolved, timer;
		const callback = () => {
			clearTimeout(timer);
			whenResolved(sequentiallyHandleApplication(scope, plugin));
		};
		const store = Status.primaryStore;
		const lockAcquired = store.tryLock(scope.pluginName, callback);

		if (!lockAcquired) {
			return new Promise((resolve, reject) => {
				whenResolved = resolve;
				timer = setTimeout(() => {
					reject(new Error(`Timeout waiting for lock on ${scope.pluginName}`));
				}, timeout + 5_000); // extra time for lock acquisition
			});
		}
		try {
			// note that handleApplication can throw sync or async errors, need to run finally block for both
			await withDeployAwareTimeout(
				Promise.resolve(plugin.handleApplication(scope)).then(async () => {
					// Wait for any initial entry handler loads to complete
					// This ensures all async operations (like secureImport) finish before the component is marked as loaded
					await scope.waitForInitialLoads();
				}),
				scope,
				timeout
			);
		} finally {
			Status.primaryStore.unlock(scope.pluginName);
		}
	});
}

function withDeployAwareTimeout<T>(operation: Promise<T>, scope: Scope, timeout: number): Promise<T> {
	return new Promise((resolve, reject) => {
		const absoluteTimeout = timeout + 6 * 60 * 60 * 1000;
		let remaining = timeout;
		let activeSince = 0;
		let timer: NodeJS.Timeout | undefined;
		let absoluteTimer: NodeJS.Timeout;
		const cleanup = () => {
			if (timer) clearTimeout(timer);
			clearTimeout(absoluteTimer);
			deployLifecycle.off('deploy:start', handleDeployStart);
			deployLifecycle.off('deploy:end', handleDeployEnd);
		};
		const rejectTimeout = (limit = timeout) => {
			cleanup();
			reject(
				new Error(`handleApplication timed out after ${limit}ms for ${scope.pluginName} on behalf of ${scope.appName}`)
			);
		};
		absoluteTimer = setTimeout(() => rejectTimeout(absoluteTimeout), absoluteTimeout);
		absoluteTimer.unref?.();
		const arm = () => {
			if (deployLifecycle.isDeployInFlight(scope.appName)) return;
			if (remaining <= 0) return rejectTimeout();
			activeSince = Date.now();
			timer = setTimeout(rejectTimeout, remaining);
		};
		function handleDeployStart(componentName: string) {
			if (componentName !== scope.appName || !timer) return;
			remaining -= Date.now() - activeSince;
			clearTimeout(timer);
			timer = undefined;
		}
		function handleDeployEnd(componentName: string) {
			if (componentName === scope.appName) arm();
		}

		deployLifecycle.on('deploy:start', handleDeployStart);
		deployLifecycle.on('deploy:end', handleDeployEnd);
		operation.then(
			(value) => {
				cleanup();
				resolve(value);
			},
			(error) => {
				cleanup();
				reject(error);
			}
		);
		arm();
	});
}

export interface LoadComponentOptions {
	isRoot?: boolean;
	applicationScope?: ApplicationScope;
	autoReload?: boolean;
	providedLoadedComponents?: Map<any, any>;
	appName?: string;
	// When provided, every Scope created during this load is added to this set instead of being
	// auto-closed on worker shutdown. The caller then owns closing them. Used by transient loads
	// (e.g. the deploy pre-flight validation) so their deploy-lifecycle listeners don't accumulate
	// across deploys (#1462).
	collectScopes?: Set<Scope>;
	collectLoadedModules?: Set<any>;
	// Routing the operator declared for this application in the root config (`host`/`urlPath` on
	// the application's entry). Applied to every plugin scope this load creates, and inherited by
	// components the application itself declares, so the whole subtree moves together.
	mount?: ScopeMount;
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
	options: LoadComponentOptions = {}
) {
	const resolvedFolder = realpathSync(componentDirectory);
	if (loadedPaths.has(resolvedFolder)) return loadedPaths.get(resolvedFolder);
	loadedPaths.set(resolvedFolder, true);

	const {
		providedLoadedComponents,
		applicationScope = new ApplicationScope(basename(componentDirectory), resources, server, options.isRoot),
		isRoot,
		autoReload,
		appName,
		mount,
		collectLoadedModules,
	} = options;
	applicationScope.runtimeRoot ??= resolvedFolder;
	applicationScope.allowedPath ??= realpathSync(componentDirectory);
	if (providedLoadedComponents) loadedComponents = providedLoadedComponents;
	try {
		let config;
		let configPath = join(componentDirectory, 'harper-config.yaml'); // look for the specific harperdb-config.yaml first
		if (!existsSync(configPath) && join(componentDirectory, 'harperdb-config.yaml')) {
			configPath = join(componentDirectory, 'harperdb-config.yaml');
		}
		if (existsSync(configPath)) {
			config = isRoot ? getConfigObj() : parseDocument(readFileSync(configPath, 'utf8')).toJSON();
			// if not found, look for the generic config.yaml, the config filename we have historically used, but only if not the root
		} else if (!isRoot && existsSync((configPath = join(componentDirectory, 'config.yaml')))) {
			config = parseDocument(readFileSync(configPath, 'utf8')).toJSON();
		} else {
			config = DEFAULT_CONFIG;
		}
		applicationScope.config ??= config;

		// For non-root components with empty/null config (e.g., comment-only YAML),
		// don't synthesize DEFAULT_CONFIG. Empty config means the component has nothing
		// to load; falling back to DEFAULT_CONFIG would cause OptionsWatcher to wait
		// forever for plugins that the file doesn't actually declare.
		if (isRoot) config ??= DEFAULT_CONFIG;
		if (!config) {
			// Empty/comment-only config file on a non-root component: nothing to load.
			return undefined;
		}

		// #629 (Phase 2 of #510): populate the model-backend registry from the root
		// config's `models:` block before any user `handleApplication(scope)` runs,
		// so `scope.models.embed(...)` works from app-init code as well as Resource
		// methods. Per-entry errors are logged and skipped by `bootstrapModels`.
		// Awaited so module-backed entries (#1471) finish importing before the
		// per-component iteration below; built-in entries register synchronously.
		if (isRoot) await bootstrapModels(config);

		// The `env:` block declares the component's environment expectations (string literal →
		// process.env; object → declaration satisfied from the hdb_secret store / process.env).
		// Processed before any of the component's plugins load, so literals and the load-gate apply
		// to everything below. A failed gate contains to this component — nothing of this
		// component's is registered (its URL space is simply absent) and the instance keeps running.
		if (config.env !== undefined) {
			if (isRoot) {
				harperLogger.warn(
					`The 'env' config block is not supported in the root config; declare env expectations in each component's config`
				);
			} else {
				const componentStatusName = basename(componentDirectory);
				try {
					// Refresh the store snapshot so out-of-cycle loads (e.g. deploy validation in a
					// long-lived worker, after a set_secret/grant_secret since boot) gate against
					// current data. Cheap (one small system-table scan per env-declaring component).
					await materializeGlobalSecrets();
					processComponentEnv(componentStatusName, config.env);
				} catch (error) {
					error.message = `Could not load component '${componentStatusName}' due to: ${error.message}`;
					errorReporter?.(error);
					(getWorkerIndex() === 0 ? console : harperLogger).error(error);
					componentLifecycle.failed(componentStatusName, error, `Could not load component '${componentStatusName}'`);
					return undefined;
				}
			}
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
			if (componentName === 'env') continue; // handled above — not a plugin
			// For root components, use just the component name
			// For application components, use applicationName.componentName format (directoryName.componentName)
			const componentStatusName = isRoot ? componentName : `${basename(componentDirectory)}.${componentName}`;

			compName = componentName;
			const componentConfig = config[componentName];
			if (!componentConfig) continue;

			// Initialize loading status for all components (applications and extensions)
			componentLifecycle.loading(componentStatusName);

			const subApplicationScope = isRoot
				? new ApplicationScope(componentName, resources, server, TRUSTED_RESOURCE_PLUGINS.hasOwnProperty(componentName))
				: applicationScope;

			let extensionModule: any;
			const pkg = componentConfig.package;
			const loadComponentOption = componentConfig.loadComponent ?? 'always';
			try {
				if (pkg) {
					if (loadComponentOption === 'dev-only' && !process.env.DEV_MODE) {
						componentLifecycle.loaded(componentStatusName, `Component '${componentStatusName}' skipped (dev-only)`);
						continue;
					}
					let componentPath: string | null = null;
					if (isRoot) {
						componentPath = join(componentDirectory, 'components', componentName);
					} else {
						let containerFolder = componentDirectory;
						const hdbBasePath = getHdbBasePath();
						const componentInsideHdb =
							componentDirectory === hdbBasePath || componentDirectory.startsWith(hdbBasePath + sep);
						componentPath = join(containerFolder, 'node_modules', componentName);
						while (!existsSync(componentPath)) {
							const parentFolder = dirname(containerFolder);
							if (parentFolder === containerFolder) {
								componentPath = null;
								break;
							}
							containerFolder = parentFolder;
							if (
								componentInsideHdb &&
								containerFolder !== hdbBasePath &&
								!containerFolder.startsWith(hdbBasePath + sep)
							) {
								componentPath = null;
								break;
							}
							componentPath = join(containerFolder, 'node_modules', componentName);
						}
					}
					if (componentPath) {
						subApplicationScope.allowedPath ??= realpathSync(componentPath);
						if (!process.env.HARPER_SAFE_MODE) {
							extensionModule = await loadComponent(componentPath, resources, origin, {
								isRoot: false,
								applicationScope: subApplicationScope,
								autoReload: false,
								appName: appName || componentName,
								collectScopes: options.collectScopes,
								collectLoadedModules,
								// `host`/`urlPath` on this entry route the component being loaded. For an
								// application (no plugin module of its own) that entry is the only place an
								// operator can say where the app is served — its own config.yaml declares the
								// plugins, not the deployment. A nested component's own mount nests inside
								// the parent's rather than replacing it, and the parent keeps hostname
								// authority, so a child can't escape the host it is served on.
								mount: nestScopeMount(mount, toScopeMount(componentConfig)),
							});
							componentFunctionality[componentName] = true;
						}
					} else if (loadComponentOption === 'if-installed') {
						componentLifecycle.loaded(
							componentStatusName,
							`Component '${componentStatusName}' skipped (not installed)`
						);
						continue;
					} else {
						throw new Error(`Unable to find package ${componentName}:${pkg}`);
					}
				} else {
					const plugin = TRUSTED_RESOURCE_PLUGINS[componentName];
					extensionModule =
						typeof plugin === 'string'
							? await import(
									plugin.startsWith('@/') ? pathToFileURL(join(PACKAGE_ROOT, plugin.slice(1))).toString() : plugin
								)
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
					const scope = new Scope(
						appName || 'harper',
						componentName,
						componentDirectory,
						configPath,
						applicationScope,
						origin,
						// authoritative root-ness: only root-load scopes watch THE root config and
						// get the runtime env-config overlay (#1618) — an app component that happens
						// to ship a root-named config file does not
						isRoot,
						// A root-declared plugin reads its own `host`/`urlPath` straight from this
						// config, so only an inherited application mount applies here.
						mount
					);

					if (options.collectScopes) {
						// A transient/validation load owns these scopes and closes them itself once the
						// load is validated (see operations.js deploy pre-flight). Skip the worker-shutdown
						// auto-close so their deploy-lifecycle listeners — and this SHUTDOWN handler — don't
						// accumulate across deploys (#1462).
						// Mark it so plugins with process-global side effects (e.g. the scheduler
						// registering jobs into its engine) can validate without activating —
						// validation scopes may reuse a live component's identity, so activating
						// from one can displace the real component's registrations.
						scope.isTransientValidation = true;
						options.collectScopes.add(scope);
					} else {
						// Track the close so the worker's shutdown path waits for it (and thus for any async
						// native-runtime disposal, e.g. @harperfast/vite's dev server) before calling realExit.
						onMessageByType(ITC_EVENT_TYPES.SHUTDOWN, () => trackScopeClose(scope.close()));
					}

					await sequentiallyHandleApplication(scope, extensionModule);

					// Mark component as loaded after successful handleApplication call
					componentLifecycle.loaded(componentStatusName, `Component '${componentStatusName}' loaded successfully`);

					continue;
				}

				// Old Extension API (`start` or `startOnMainThread`)
				if (
					!BUILT_INS.includes(componentName) &&
					('startOnMainThread' in extensionModule ||
						'start' in extensionModule ||
						'handleFile' in extensionModule ||
						'handleDirectory' in extensionModule ||
						'setupFile' in extensionModule ||
						'setupDirectory' in extensionModule)
				) {
					harperLogger.warn?.(
						`Component ${componentName} is using deprecated extension API. Upgrade to the new Plugin API. For more information: https://docs.harperdb.io/docs/reference/components/plugins`
					);
				}

				// `start`/`startOnMainThread` hand the plugin the raw, unmounted `server` directly —
				// unlike the new Plugin API's `handleApplication(scope)`, which receives the mount-aware
				// scope — so routes registered there would silently escape a configured host/urlPath
				// mount and stay reachable unconstrained (review finding). Same isolation gap
				// fastifyRoutes.ts already closes for its own legacy fallback (host-only there, since
				// urlPath composes into its route prefix; here neither composes, so both are rejected).
				// Refuse rather than imply an isolation the hook can't honor; contained to this
				// component by the loader's per-component try/catch.
				if (
					mount &&
					(typeof extensionModule.start === 'function' || typeof extensionModule.startOnMainThread === 'function')
				) {
					const error = new Error(
						`Component '${componentName}' is mounted (${[
							mount.host && `host '${mount.host}'`,
							mount.urlPath && `urlPath '${mount.urlPath}'`,
						]
							.filter(Boolean)
							.join(
								', '
							)}), but its deprecated 'start'/'startOnMainThread' extension API receives the bare, unmounted server — routes registered there would stay reachable unconstrained. Upgrade to the new Plugin API (handleApplication(scope)) or drop the mount.`
					);
					componentLifecycle.failed(componentStatusName, error, `Component '${componentStatusName}' failed to load`);
					throw error;
				}

				if (isMainThread) {
					// `startOnMainThread` is one-time main-thread init: run it at most once per component
					// for the life of the process (first load / first deploy). On a reload of an
					// already-initialized component, skip the call and reuse the previously-initialized
					// module so downstream wiring (handleFile/handleDirectory, loadedComponents) is
					// preserved without re-running main-thread setup. Only components that actually
					// export `startOnMainThread` are gated — a component with only setup handlers has no
					// one-time hook to dedupe and must keep picking up its freshly loaded module on
					// reload. See #460.
					if (typeof extensionModule.startOnMainThread === 'function') {
						// Reuse the already-resolved realpath (line 308) instead of a second realpathSync —
						// same value, avoids a redundant sync FS call (PR #1464 review).
						const mainThreadKey = `${isRoot ? '' : basename(resolvedFolder)}/${componentName}@${resolvedFolder}`;
						if (mainThreadInitialized.has(mainThreadKey)) {
							extensionModule = mainThreadInitialized.get(mainThreadKey);
						} else {
							extensionModule =
								(await extensionModule.startOnMainThread({
									server,
									ensureTable,
									port,
									securePort,
									resources,
									...componentConfig,
								})) || extensionModule;
							mainThreadInitialized.set(mainThreadKey, extensionModule);
						}
					}
					if (isRoot && network) {
						if (env.get(CONFIG_PARAMS.HTTP_SESSIONAFFINITY))
							harperLogger.warn('Session affinity is not supported and will be ignored');
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
				collectLoadedModules?.add(extensionModule);

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
				(getWorkerIndex() === 0 ? console : harperLogger).error(errorForLog(error));
				resources.set(componentConfig.path || '/', new ErrorResource(error), null, true);
				componentLifecycle.failed(componentStatusName, error, `Could not load component '${componentStatusName}'`);
			}
		}

		compName = parentCompName;
		if (isMainThread && !watchesSetup && autoReload) {
			let debounceTimer: ReturnType<typeof setTimeout> | null = null;
			let restarting = false; // a reload cycle (loadComponentDirectories + restartWorkers) is in flight
			let pending = false; // a request arrived while a cycle was running — run exactly one more afterward

			// Run reload cycles strictly one at a time. Requests that arrive while a cycle is in flight are
			// collapsed into a single follow-up cycle (not one per request), so a burst of changes — or a
			// regenerate-on-reload loop — can't stack overlapping restarts. Overlapping restarts pile worker
			// threads up and push them past the forced-termination grace, which crashes a worker that is
			// mid-teardown of a native runtime (e.g. @harperfast/vite's rolldown dev server).
			const runRestartCycle = async () => {
				if (restarting) {
					pending = true;
					return;
				}
				restarting = true;
				try {
					do {
						pending = false;
						resetRestartNeeded();
						// Per-cycle try/catch: a failed reload (e.g. a saved syntax error) must log and move on
						// — not abort the loop and discard a pending follow-up, like the save that fixes it.
						try {
							await loadComponentDirectories();
							await restartWorkers();
						} catch (error) {
							harperLogger.error('Error during component reload', error);
						}
					} while (pending); // a request landed mid-cycle → run once more, coalescing the rest
				} finally {
					restarting = false;
				}
			};

			subscribeToRestartRequests(() => {
				if (debounceTimer) clearTimeout(debounceTimer);
				debounceTimer = setTimeout(() => {
					debounceTimer = null;
					void runRestartCycle();
				}, 500);
			});
		}
		if ((config.extensionModule || config.pluginModule) && (!isMainThread || config.runOnMainThread)) {
			const extensionModule = await scopedImport(
				join(componentDirectory, config.extensionModule || config.pluginModule),
				applicationScope
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
		console.error(`Could not load application directory ${componentDirectory}`, errorForLog(error));
		error.message = `Could not load application due to ${error.message}`;
		errorReporter?.(error);
		resources.set('', new ErrorResource(error));
	}
}
