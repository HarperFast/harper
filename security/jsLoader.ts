import { Resource } from '../resources/Resource.ts';
import { contextStorage, transaction } from '../resources/transaction.ts';
import { RequestTarget } from '../resources/RequestTarget.ts';
import { tables, databases } from '../resources/databases.ts';
import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { SourceTextModule, SyntheticModule, createContext, runInContext } from 'node:vm';
import { ApplicationScope } from '../components/ApplicationScope.ts';
import logger from '../utility/logging/harper_logger.js';
import { createRequire } from 'node:module';
import * as env from '../utility/environment/environmentManager';
import * as child_process from 'node:child_process';
import { CONFIG_PARAMS } from '../utility/hdbTerms.ts';
import { contentTypes } from '../server/serverHelpers/contentTypes.ts';
import type { CompartmentOptions } from 'ses';
import { mkdirSync, readFileSync, writeFileSync, unlinkSync, openSync, closeSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';

type Lockdown = 'none' | 'freeze' | 'ses';
const APPLICATIONS_LOCKDOWN: Lockdown = env.get(CONFIG_PARAMS.APPLICATIONS_LOCKDOWN);
const HARPER_MODULE_IDS = new Set([
	'harper',
	'harperdb',
	'harperdb/v1',
	'harperdb/v2',
	'@harperfast/harper',
	'@harperfast/harper-pro',
]);

let lockedDown = false;
/**
 * This is the main entry point for loading plugin and application modules that may be executed in a
 * separate top level scope. The scope indicates if we use a different top level scope or a standard import.
 * @param moduleUrl
 * @param scope
 */
export async function scopedImport(filePath: string | URL, scope?: ApplicationScope) {
	if (!lockedDown && APPLICATIONS_LOCKDOWN && APPLICATIONS_LOCKDOWN !== 'none') {
		lockedDown = true;
		if (APPLICATIONS_LOCKDOWN === 'ses') {
			require('ses'); // load the lockdown function
			lockdown({
				domainTaming: 'unsafe',
				consoleTaming: 'unsafe',
				errorTaming: 'unsafe',
				errorTrapping: 'none',
				stackFiltering: 'verbose',
			});
		} else {
			preventFunctionConstructor();
			for (let name of Object.getOwnPropertyNames(Object.prototype)) {
				if (name === '__proto__') continue;
				overridableProperty(Object.prototype, name);
			}
			overridableProperty(Promise.prototype, 'then');
			overridableProperty(Date, 'now');
			for (let name of ['get', 'set', 'has', 'delete', 'clear', 'forEach', 'entries', 'keys', 'values']) {
				overridableProperty(Map.prototype, name);
			}
			for (let Intrinsic of [
				Object,
				Array,
				Promise,
				BigInt,
				String,
				Number,
				Boolean,
				Symbol,
				RegExp,
				Date,
				Map,
				Set,
				WeakMap,
				WeakSet,
				Math,
				JSON,
				Reflect,
				Atomics,
				SharedArrayBuffer,
				WeakRef,
				FinalizationRegistry,
			]) {
				Object.freeze(Intrinsic);
				Object.freeze(Intrinsic.prototype);
			}
			Object.freeze(Function);
		}
	}
	const moduleUrl = (filePath instanceof URL ? filePath : pathToFileURL(filePath)).toString();
	try {
		const containmentMode = scope?.mode;
		if (scope && containmentMode !== 'none') {
			if (containmentMode === 'compartment') {
				// use SES Compartments
				// note that we use a single compartment per scope and we load it on-demand, only
				// loading if necessary (since it is actually very heavy)
				const globals = getGlobalObject(scope);
				if (!scope.compartment) scope.compartment = getCompartment(scope, globals);
				const result = await (await scope.compartment).import(moduleUrl);
				return result.namespace;
			} else if (SourceTextModule) {
				// else use standard node:vm module to do containment (if it is available)
				return await loadModuleWithVM(moduleUrl, scope);
			}
		}
		// important! we need to await the import, otherwise the error will not be caught
		return await import(moduleUrl);
	} catch (err) {
		try {
			// the actual parse error (internally known as the "arrow message")
			// is hidden behind a private symbol (arrowMessagePrivateSymbol)
			// on the error object and the only way to access it is to use the
			// internal util.decorateErrorStack() function
			const util = await import('internal/util');
			util.default.decorateErrorStack(err);
		} catch {
			// maybe --expose-internals was not set?
		}
		throw err;
	}
}

let amaro: typeof import('amaro') | undefined;
/**
 * Strip TypeScript types synchronously using the amaro library (what Node.js uses internally)
 */
function stripTypeScriptTypes(source: string): string {
	// Use amaro - the library that Node.js uses internally for type stripping
	if (!amaro) {
		amaro = require('amaro');
	}
	return amaro.transformSync(source, { mode: 'strip-only' }).code;
}

/**
 * Parse a JSON string and return the resulting object. Wraps JSON.parse errors
 * with the module URL for easier debugging.
 */
function parseJsonModule(source: string, url: string): any {
	try {
		return JSON.parse(source);
	} catch (err) {
		throw new Error(`Failed to parse JSON module ${url}: ${err.message}`);
	}
}

/**
 * Load a module using Node's vm.Module API with (not really secure) sandboxing
 */
async function loadModuleWithVM(moduleUrl: string, scope: ApplicationScope) {
	// we want to retain the same module caches across any loading with the application scope
	let moduleCaches = scope.moduleCache as {
		moduleCache: Map<string, SourceTextModule | SyntheticModule | Promise<SourceTextModule | SyntheticModule>>;
		linkingPromises: Map<string, Promise<void>>;
		cjsCache: Map<string, { exports: any }>;
		contextObject: any;
		context: any;
	};
	if (!moduleCaches) {
		// if they haven't been initialized, do so now
		const contextObject = getGlobalObject(scope, true);
		moduleCaches = scope.moduleCache = {
			moduleCache: new Map(),
			linkingPromises: new Map(),
			cjsCache: new Map(),
			// Create a secure context with limited globals
			contextObject,
			context: createContext(contextObject),
		};
	}
	const { moduleCache, linkingPromises, cjsCache, contextObject, context } = moduleCaches;

	/**
	 * Resolve module specifier to absolute URL
	 */
	function resolveModule(specifier: string, referrer: string): string {
		if (HARPER_MODULE_IDS.has(specifier)) {
			return 'harper'; // resolve any harper package as an alias to a single synthetic module
		}
		const parts = specifier.split('/');
		if (parts[0] === 'harper') {
			// block harper/* for now (reserving for potential future use)
			throw new Error(`Module ${specifier} is not allowed, may only access the 'harper' module`);
		}
		if (parts[0] === 'file:') {
			return specifier;
		}
		const resolved = createRequire(referrer).resolve(specifier);
		if (isAbsolute(resolved)) {
			return pathToFileURL(resolved).toString();
		}
		return resolved;
	}

	/**
	 * Load a CommonJS module in our private context
	 */
	function loadCJS(url: string, source: string): { exports: any } {
		// Check cache first to handle circular dependencies
		if (cjsCache.has(url)) {
			return cjsCache.get(url)!;
		}

		// Create module object and cache it immediately (before execution)
		// This allows circular dependencies to get a reference to the incomplete module
		const cjsModule = { exports: {} };
		cjsCache.set(url, cjsModule);

		if (url.endsWith('.json')) {
			cjsModule.exports = parseJsonModule(source, url);
			return cjsModule;
		}
		const require = createRequire(url);

		const cjsRequire = (spec: string) => {
			const resolvedPath = require.resolve(spec);
			if (isAbsolute(resolvedPath)) {
				const source = readFileSync(resolvedPath, { encoding: 'utf-8' });
				return loadCJS(resolvedPath, source).exports;
			} else {
				return require(spec);
			}
		};
		cjsRequire.resolve = require.resolve;

		const cjsWrapper = `
			(function(module, exports, require, __filename, __dirname) {
				${source}
			})
		`;

		const wrappedFn = runInContext(cjsWrapper, contextObject, {
			filename: url,
			async importModuleDynamically(specifier: string, script) {
				const resolvedUrl = resolveModule(specifier, script.sourceURL);
				const useContainment = specifier.startsWith('.') || scope.dependencyContainment !== false;
				const dynamicModule = await loadModuleWithCache(resolvedUrl, useContainment);
				return dynamicModule;
			},
		});
		wrappedFn(
			cjsModule,
			cjsModule.exports,
			cjsRequire,
			url,
			dirname(url.startsWith('file://') ? fileURLToPath(url) : url)
		);

		return cjsModule;
	}
	function loadCJSModule(url: string, source: string, usePrivateGlobal: boolean): SyntheticModule {
		const cjsModule = usePrivateGlobal ? loadCJS(url, source) : { exports: require(url) };
		let exports = cjsModule.exports;
		if (exports.default === undefined) {
			// provide the default export for compatibility
			exports = { default: exports, ...exports };
		}
		const exportNames = Object.keys(exports);

		const synModule = new SyntheticModule(
			exportNames,
			function () {
				for (const key of exportNames) {
					this.setExport(key, exports[key]);
				}
			},
			{ identifier: url, context }
		);
		// Don't cache here - let getOrCreateModule handle caching
		return synModule;
	}

	/**
	 * Check if a package (or any of its dependencies) depends on harper
	 * Expects a file URL like: file:///path/to/node_modules/package-name/dist/index.js
	 */
	function packageDependsOnHarper(fileUrl: string): boolean {
		try {
			// Convert file:// URL to path
			const filePath = fileURLToPath(fileUrl);

			// Find the node_modules directory and package name
			// Example: /path/to/node_modules/package-name/dist/index.js
			// or: /path/to/node_modules/@scope/package-name/dist/index.js
			const nodeModulesMarker = '/node_modules/';
			const nodeModulesIndex = filePath.lastIndexOf(nodeModulesMarker);
			if (nodeModulesIndex === -1) return false;

			// Get the part after /node_modules/
			const afterNodeModules = filePath.substring(nodeModulesIndex + nodeModulesMarker.length);
			const parts = afterNodeModules.split('/');

			// Handle scoped packages (@scope/package-name) vs regular packages (package-name)
			const beforeNodeModules = filePath.substring(0, nodeModulesIndex);
			const packageRoot = parts[0].startsWith('@')
				? join(beforeNodeModules, 'node_modules', parts[0], parts[1])
				: join(beforeNodeModules, 'node_modules', parts[0]);

			// Read package.json from the package root
			const packageJsonPath = join(packageRoot, 'package.json');
			const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));

			const deps = {
				...packageJson.dependencies,
				...packageJson.devDependencies,
				...packageJson.peerDependencies,
			};

			// Check if harper is a direct dependency
			return Object.keys(deps).some((dep) => HARPER_MODULE_IDS.has(dep));
		} catch {
			return false;
		}
	}

	/**
	 * Linker function for module resolution during instantiation.
	 * This is synchronous because Node's module.link() requires the linker
	 * to return modules synchronously.
	 */
	function linker(specifier: string, referencingModule: SourceTextModule | SyntheticModule) {
		const resolvedUrl = resolveModule(specifier, referencingModule.identifier);

		// Determine if we should use VM containment for this module
		let useContainment = specifier.startsWith('.'); // Always contain relative imports

		if (!useContainment && scope.dependencyContainment !== false) {
			// For npm packages, check if they depend on harper
			if (resolvedUrl.startsWith('file://') && resolvedUrl.includes('node_modules')) {
				useContainment = packageDependsOnHarper(resolvedUrl);
			} else {
				// Non-file URLs (bare specifiers) - use default behavior
				useContainment = scope.dependencyContainment === true;
			}
		}

		// Return the module
		return getOrCreateModule(resolvedUrl, useContainment);
	}

	function getOrCreateModule(
		url: string,
		usePrivateGlobal: boolean
	): SourceTextModule | SyntheticModule | Promise<SourceTextModule | SyntheticModule> {
		// Check if module is already created
		if (moduleCache.has(url)) {
			return moduleCache.get(url)!;
		}

		// Create the module and cache it immediately (before linking)
		const module = createModule(url, usePrivateGlobal);
		moduleCache.set(url, module);

		return module;
	}

	async function loadModuleWithCache(
		url: string,
		usePrivateGlobal: boolean
	): Promise<SourceTextModule | SyntheticModule> {
		const module = await getOrCreateModule(url, usePrivateGlobal);

		// Only link/evaluate once per module
		if (!linkingPromises.has(url)) {
			const linkingPromise = (async () => {
				// Check module status - only link if it's 'unlinked'
				// Status can be: 'unlinked', 'linking', 'linked', 'evaluating', 'evaluated'
				if (module.status === 'unlinked') {
					await module.link(linker);
				}
				// Only evaluate if not already evaluated
				if (module.status === 'linked') {
					await module.evaluate();
				}
			})();
			linkingPromises.set(url, linkingPromise);
		}

		// Wait for linking to complete
		await linkingPromises.get(url);

		return module;
	}
	/**
	 * Create a SyntheticModule from exported object
	 */
	function createSyntheticModule(url: string, exportedObject: any): SyntheticModule {
		const exportNames = Object.keys(exportedObject);
		return new SyntheticModule(
			exportNames,
			function () {
				for (const key of exportNames) {
					this.setExport(key, exportedObject[key]);
				}
			},
			{ identifier: url, context }
		);
	}

	/**
	 * Normalize imported module to ensure it has proper exports including default
	 */
	function normalizeImportedModule(importedModule: any): any {
		const cjsModule = importedModule['module.exports'];
		if (cjsModule) {
			// back-compat import
			importedModule = importedModule.default ? { default: importedModule.default, ...cjsModule } : cjsModule;
		}
		// Ensure there's a default export for ESM imports that expect it
		if (!importedModule.default) {
			importedModule = { default: importedModule, ...importedModule };
		}
		return importedModule;
	}

	/**
	 * Create a SourceTextModule or SyntheticModule from source code
	 */
	function createModuleFromSource(
		url: string,
		source: string,
		usePrivateGlobal: boolean
	): SourceTextModule | SyntheticModule {
		// Handle JSON modules
		if (url.endsWith('.json')) {
			const jsonData = parseJsonModule(source, url);
			return new SyntheticModule(
				['default'],
				function () {
					this.setExport('default', jsonData);
				},
				{ identifier: url, context }
			);
		}

		// Strip TypeScript types if this is a .ts file
		if (url.endsWith('.ts') || url.endsWith('.tsx')) {
			source = stripTypeScriptTypes(source);
		}

		// Try CJS first since it will fail fast with clear syntax errors on ESM syntax
		try {
			return loadCJSModule(url, source, usePrivateGlobal);
		} catch {
			// If CJS loading fails (likely due to ESM syntax like import/export), try ESM
			return new SourceTextModule(source, {
				identifier: url,
				context,
				initializeImportMeta(meta) {
					meta.url = url;
				},
				importModuleDynamically(specifier: string) {
					const resolvedUrl = resolveModule(specifier, url);
					return loadModuleWithCache(resolvedUrl, true);
				},
			});
		}
	}

	/**
	 * Create a module from URL synchronously (for use in linker)
	 */
	function createModuleSync(url: string, usePrivateGlobal: boolean): SourceTextModule | SyntheticModule {
		// Handle special built-in modules
		if (url === 'harper') {
			return createSyntheticModule(url, getHarperExports(scope));
		}

		if (url.startsWith('file://') && usePrivateGlobal) {
			checkAllowedModulePath(url, scope.verifyPath);
			const source = readFileSync(new URL(url), { encoding: 'utf-8' });
			return createModuleFromSource(url, source, usePrivateGlobal);
		}

		// For Node.js built-in modules (node:) and npm packages without dependency containment
		const replacedModule = checkAllowedModulePath(url, scope.verifyPath);
		const requirePath = url.startsWith('file://') ? fileURLToPath(url) : url;
		const importedModule = replacedModule ?? require(requirePath);

		return createSyntheticModule(url, normalizeImportedModule(importedModule));
	}

	/**
	 * Create a module from URL without linking or evaluating (async version for initial load)
	 */
	function createModule(
		url: string,
		usePrivateGlobal: boolean
	): SourceTextModule | SyntheticModule | Promise<SourceTextModule | SyntheticModule> {
		// Handle special built-in modules
		if (url === 'harper') {
			return createSyntheticModule(url, getHarperExports(scope));
		}

		if (url.startsWith('file://') && usePrivateGlobal) {
			checkAllowedModulePath(url, scope.verifyPath);
			const source = readFileSync(new URL(url), { encoding: 'utf-8' });
			return createModuleFromSource(url, source, usePrivateGlobal);
		}

		// For Node.js built-in modules (node:) and npm packages without dependency containment
		const replacedModule = checkAllowedModulePath(url, scope.verifyPath);
		if (replacedModule) {
			return createSyntheticModule(url, normalizeImportedModule(replacedModule));
		}
		return import(url).then((importedModule) => createSyntheticModule(url, normalizeImportedModule(importedModule)));
	}
	// Load the entry module
	const entryModule = await loadModuleWithCache(moduleUrl, true);

	// Return the module namespace (exports)
	return entryModule.namespace;
}

async function getCompartment(scope: ApplicationScope, globals) {
	const { StaticModuleRecord } = await import('@endo/static-module-record');
	require('ses');
	const compartment: CompartmentOptions = new (Compartment as typeof CompartmentOptions)(
		globals,
		{
			//harperdb: { Resource, tables, databases }
		},
		{
			name: 'harper-app',
			resolveHook(moduleSpecifier, moduleReferrer) {
				if (HARPER_MODULE_IDS.has(moduleSpecifier)) {
					return 'harper'; // resolve any harper package as an alias to a single synthetic module
				}
				const parts = moduleSpecifier.split('/');
				if (parts[0] === 'harper') {
					// block harper/* for now (reserving for potential future use)
					throw new Error(`Module ${moduleSpecifier} is not allowed, may only access the 'harper' module`);
				}

				const resolved = createRequire(moduleReferrer).resolve(moduleSpecifier);
				if (isAbsolute(resolved)) {
					const resolvedURL = pathToFileURL(resolved).toString();
					return resolvedURL;
				}
				return moduleSpecifier;
			},
			importHook: async (moduleSpecifier) => {
				if (moduleSpecifier === 'harper') {
					const harperExports = getHarperExports(scope);
					return {
						imports: [],
						exports: Object.keys(harperExports),
						execute(exports) {
							Object.assign(exports, harperExports);
						},
					};
				} else if (moduleSpecifier.startsWith('file:') && !moduleSpecifier.includes('node_modules')) {
					let moduleText = await readFile(new URL(moduleSpecifier), { encoding: 'utf-8' });
					// Handle JSON files in compartment mode the same way as in VM mode
					if (moduleSpecifier.endsWith('.json')) {
						const jsonData = parseJsonModule(moduleText, moduleSpecifier);
						return {
							imports: [],
							exports: ['default'],
							execute(exports) {
								exports.default = jsonData;
							},
						};
					}
					// Strip TypeScript types if this is a .ts file
					if (moduleSpecifier.endsWith('.ts') || moduleSpecifier.endsWith('.tsx')) {
						moduleText = stripTypeScriptTypes(moduleText);
					}
					return new StaticModuleRecord(moduleText, moduleSpecifier);
				} else {
					checkAllowedModulePath(moduleSpecifier, scope.verifyPath);
					const moduleExports = await import(moduleSpecifier);
					return {
						imports: [],
						exports: Object.keys(moduleExports),
						execute(exports) {
							for (const key of Object.keys(moduleExports)) {
								exports[key] = moduleExports[key];
							}
						},
					};
				}
			},
		}
	);
	return compartment;
}

/**
 * This a constrained fetch. It certainly is not guaranteed to be safe, but requiring https may
 * be a good heuristic for preventing access to unsecured resources within a private network.
 * @param resource
 * @param options
 */
function secureOnlyFetch(resource, options) {
	// TODO: or maybe we should constrain by doing a DNS lookup and having disallow list of IP addresses that includes
	// this server
	const url = typeof resource === 'string' || resource.url;
	if (new URL(url).protocol != 'https') throw new Error('Only https is allowed in fetch');
	return fetch(resource, options);
}

// These globals need to match the literals produced in the VM context
const contextualizedJSGlobals = ['Object', 'Array', 'Function', 'globalThis'];

let defaultJSGlobalNames: string[];
// get the global variable names that are intrinsically present in a VM context (so we don't override them)
function getDefaultJSGlobalNames() {
	if (!defaultJSGlobalNames) {
		defaultJSGlobalNames = runInContext(
			'Object.getOwnPropertyNames((function() { return this })())',
			createContext({})
		);
	}
	return defaultJSGlobalNames;
}

/**
 * Get the set of global variables that should be available to modules that run in scoped compartments/contexts.
 */
function getGlobalObject(scope: ApplicationScope, copyIntrinsics = false) {
	const appGlobal = {};
	// create the new global object, assigning all the global variables from this global
	// except those that will be natural intrinsics of the new VM
	const globalsToExclude = copyIntrinsics ? contextualizedJSGlobals : getDefaultJSGlobalNames();
	for (let name of Object.getOwnPropertyNames(global)) {
		if (globalsToExclude.includes(name)) continue;
		appGlobal[name] = global[name];
	}
	// now assign Harper scope-specific variables
	Object.assign(appGlobal, {
		server: scope.server ?? server,
		logger: scope.logger ?? logger,
		resources: scope.resources,
		config: scope.config ?? {},
		fetch: APPLICATIONS_LOCKDOWN === 'ses' ? secureOnlyFetch : fetch,
		console,
		global: appGlobal,
		harper: getHarperExports(scope),
	});
	return appGlobal;
}
function getHarperExports(scope: ApplicationScope) {
	return {
		server: scope.server ?? server,
		logger: scope.logger ?? logger,
		resources: scope.resources,
		config: scope.config ?? {},
		Resource,
		tables,
		databases,
		createBlob,
		RequestTarget,
		getContext,
		transaction,
		getResponse,
		getUser,
		authenticateUser: server.authenticateUser,
		operation: server.operation,
		contentTypes,
		Attribute: undefined,
		Config: undefined,
		ConfigValue: undefined,
		Context: undefined,
		FileAndURLPathConfig: undefined,
		FilesOption: undefined,
		FilesOptionObject: undefined,
		IterableEventQueue: undefined,
		Logger: undefined,
		Query: undefined,
		RecordObject: undefined,
		RequestTargetOrId: undefined,
		ResourceInterface: undefined,
		Scope: undefined,
		Session: undefined,
		SourceContext: undefined,
		SubscriptionRequest: undefined,
		Table: undefined,
		User: undefined,
	};
}
const ALLOWED_NODE_BUILTIN_MODULES = env.get(CONFIG_PARAMS.APPLICATIONS_ALLOWEDBUILTINMODULES)
	? new Set(env.get(CONFIG_PARAMS.APPLICATIONS_ALLOWEDBUILTINMODULES))
	: {
			// if we don't have a list of allowed modules, allow everything
			has() {
				return true;
			},
		};
const ALLOWED_COMMANDS = new Set(env.get(CONFIG_PARAMS.APPLICATIONS_ALLOWEDSPAWNCOMMANDS) ?? []);
const child_processConstrained = {
	exec: createSpawn(child_process.exec),
	execFile: createSpawn(child_process.execFile),
	fork: createSpawn(child_process.fork, true), // this is launching node, so deemed safe
	spawn: createSpawn(child_process.spawn),
	execSync: function () {
		throw new Error('execSync is not allowed');
	},
};
child_processConstrained.default = child_processConstrained;
const REPLACED_BUILTIN_MODULES = {
	child_process: child_processConstrained,
};
/**
 * Creates a ChildProcess-like object for an existing process
 */
class ExistingProcessWrapper extends EventEmitter {
	pid: number;
	private checkInterval: NodeJS.Timeout;

	constructor(pid: number) {
		super();
		this.pid = pid;

		// Monitor process and emit exit event when it terminates
		this.checkInterval = setInterval(() => {
			try {
				// Signal 0 checks if process exists without actually killing it
				process.kill(pid, 0);
			} catch {
				// Process no longer exists
				clearInterval(this.checkInterval);
				this.emit('exit', null, null);
			}
		}, 1000);
	}

	// Kill the process
	kill(signal?: NodeJS.Signals | number) {
		try {
			process.kill(this.pid, signal);
			return true;
		} catch {
			return false;
		}
	}

	// Clean up interval when wrapper is no longer needed
	unref() {
		clearInterval(this.checkInterval);
		return this;
	}
}

/**
 * Checks if a process with the given PID is running
 */
function isProcessRunning(pid: number): boolean {
	try {
		// Signal 0 checks existence without killing
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/**
 * Acquires an exclusive lock using the PID file itself (synchronously with busy-wait)
 * Returns 0 if lock was acquired (need to spawn new process), or the existing PID if process is running
 */
function acquirePidFileLock(pidFilePath: string, maxRetries = 100, retryDelay = 5): number {
	for (let attempt = 0; attempt < maxRetries; attempt++) {
		try {
			// Try to open exclusively - 'wx' fails if file exists
			const fd = openSync(pidFilePath, 'wx');
			closeSync(fd);
			return 0; // Successfully acquired lock (file created), caller should spawn process
		} catch (err) {
			if (err.code === 'EEXIST') {
				// File exists - check if it contains a valid running process
				try {
					const pidContent = readFileSync(pidFilePath, 'utf-8');
					const existingPid = parseInt(pidContent.trim(), 10);

					if (!isNaN(existingPid) && isProcessRunning(existingPid)) {
						// Valid process is running, return its PID immediately
						return existingPid;
					}

					// Invalid/empty PID - check file age to determine if it's stale or being written
					const stats = statSync(pidFilePath);
					const fileAge = Date.now() - stats.mtimeMs;

					// If file is very new (less than 100ms) and empty/invalid, another thread is likely still writing to it
					if (fileAge < 100) {
						// Just wait and retry, don't try to remove
					} else {
						// Stale PID file (old and invalid), try to remove it
						try {
							unlinkSync(pidFilePath);
						} catch {
							// Another thread may have removed it, retry
						}
					}
				} catch {
					// Couldn't read/stat file, another thread might be modifying it, retry
				}

				// Wait a bit before retrying
				const start = Date.now();
				while (Date.now() - start < retryDelay) {
					// Busy wait
				}
			} else {
				throw err;
			}
		}
	}

	throw new Error(`Failed to acquire PID file lock after ${maxRetries} attempts`);
}

function createSpawn(spawnFunction: (...args: any) => child_process.ChildProcess, alwaysAllow?: boolean) {
	const basePath = env.getHdbBasePath();
	return function (command: string, args?: any, options?: any, callback?: (...args: any[]) => void) {
		if (!ALLOWED_COMMANDS.has(command.split(' ')[0]) && !alwaysAllow) {
			throw new Error(`Command ${command} is not allowed`);
		}
		const processName = options?.name;
		if (!processName)
			throw new Error(
				`Calling ${spawnFunction.name} in Harper must have a process "name" in the options to ensure that a single process is started and reused`
			);

		// Ensure PID directory exists
		const pidDir = join(basePath, 'pids');
		mkdirSync(pidDir, { recursive: true });

		const pidFilePath = join(pidDir, `${processName}.pid`);

		// Try to acquire lock - returns 0 if acquired, or existing PID
		const existingPid = acquirePidFileLock(pidFilePath);

		if (existingPid !== 0) {
			// Existing process is running, return wrapper
			return new ExistingProcessWrapper(existingPid);
		}

		// We acquired the lock (file was created), spawn new process
		const childProcess = spawnFunction(command, args, options, callback);

		// Write PID to the file we just created
		try {
			writeFileSync(pidFilePath, childProcess.pid.toString(), 'utf-8');
		} catch (err) {
			// Failed to write PID, clean up
			try {
				childProcess.kill();
				unlinkSync(pidFilePath);
			} catch {}
			throw err;
		}

		// Clean up PID file when process exits
		childProcess.on('exit', () => {
			try {
				unlinkSync(pidFilePath);
			} catch {
				// File may already be removed
			}
		});

		return childProcess;
	};
}

/**
 * Validates whether a module can be loaded based on security restrictions and returns the module path or replacement.
 * For file URLs, ensures the module is within the containing folder.
 * For node built-in modules, checks against an allowlist and returns any replacements.
 *
 * @param {string} moduleUrl - The URL or identifier of the module to be loaded, which may be a file: URL, node: URL, or bare module specifier.
 * @param {string} containingFolder - The absolute path of the folder that contains the application, used to validate file: URLs are within bounds.
 * @return {any} Returns undefined for allowed file paths, or a replacement module identifier for allowed node built-in modules.
 * @throws {Error} Throws an error if the module is outside the application folder or if the module is not in the allowed list.
 */
function checkAllowedModulePath(moduleUrl: string, containingFolder?: string): boolean {
	if (moduleUrl.startsWith('file:')) {
		const path = moduleUrl.slice(7);
		if (!containingFolder || path.startsWith(containingFolder)) {
			return;
		}
		throw new Error(`Can not load module outside of application folder ${containingFolder}`);
	}
	let simpleName = moduleUrl.startsWith('node:') ? moduleUrl.slice(5) : moduleUrl;
	simpleName = simpleName.split('/')[0];
	if (ALLOWED_NODE_BUILTIN_MODULES.has(simpleName)) return REPLACED_BUILTIN_MODULES[simpleName];
	throw new Error(`Module ${moduleUrl} is not allowed to be imported`);
}

function getContext() {
	return contextStorage.getStore() ?? {};
}
function getUser() {
	return contextStorage.getStore()?.user;
}
function getResponse() {
	return contextStorage.getStore()?.response;
}

export function preventFunctionConstructor() {
	Function.prototype.constructor = function () {}; // prevent this from being used to eval data in a parent context
}

/**
 * This can redefine a property into a getter/setter that will allow derivatives of a prototype to assign
 * a value to the property without incurring an error from the property being frozen and readonly.
 * @param target
 * @param name
 * @param value
 */
function overridableProperty(target, name, value = target[name]) {
	Object.defineProperty(target, name, {
		get() {
			return value;
		},
		set(value) {
			Object.defineProperty(this, name, {
				value,
				configurable: true,
				enumerable: true,
				writable: true,
			});
		},
	});
}
