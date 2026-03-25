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
 * Strip TypeScript types using the amaro library (what Node.js uses internally)
 * Falls back to regex-based stripping if amaro is not available
 */
async function stripTypeScriptTypes(source: string): Promise<string> {
	// Use amaro - the library that Node.js uses internally for type stripping
	amaro = await import('amaro');
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
	const moduleCache = new Map<string, SourceTextModule | SyntheticModule>();
	const linkingPromises = new Map<string, Promise<void>>();

	// Create a secure context with limited globals
	const contextObject = getGlobalObject(scope);
	const context = createContext(contextObject);

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
		const cjsModule = { exports: {} };
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
				const useContainment = specifier.startsWith('.') || scope.dependencyContainment;
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
		const exportNames = Object.keys(cjsModule.exports);
		const synModule = new SyntheticModule(
			exportNames.length > 0 ? exportNames : ['default'],
			function () {
				if (exportNames.length > 0) {
					for (const key of exportNames) {
						this.setExport(key, cjsModule.exports[key]);
					}
				} else {
					this.setExport('default', cjsModule.exports);
				}
			},
			{ identifier: url, context }
		);
		// Don't cache here - let getOrCreateModule handle caching
		return synModule;
	}

	/**
	 * Linker function for module resolution during instantiation
	 */
	async function linker(specifier: string, referencingModule: SourceTextModule | SyntheticModule) {
		const resolvedUrl = resolveModule(specifier, referencingModule.identifier);

		const useContainment = specifier.startsWith('.') || scope.dependencyContainment;
		// Return the module immediately (even if not yet linked) to support circular dependencies
		return await getOrCreateModule(resolvedUrl, useContainment);
	}

	async function getOrCreateModule(
		url: string,
		usePrivateGlobal: boolean
	): Promise<SourceTextModule | SyntheticModule> {
		// Check cache first - return cached module immediately (even if not linked yet)
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
				await module.link(linker);
				await module.evaluate();
			})();
			linkingPromises.set(url, linkingPromise);
		}

		// Wait for linking to complete
		await linkingPromises.get(url);

		return module;
	}
	/**
	 * Create a module from URL without linking or evaluating
	 */
	async function createModule(url: string, usePrivateGlobal: boolean): Promise<SourceTextModule | SyntheticModule> {
		let module: SourceTextModule | SyntheticModule;

		// Handle special built-in modules
		if (url === 'harper') {
			let harperExports = getHarperExports(scope);
			module = new SyntheticModule(
				Object.keys(harperExports),
				function () {
					for (let key in harperExports) {
						this.setExport(key, harperExports[key]);
					}
				},
				{ identifier: url, context }
			);
		} else if (url.startsWith('file://') && usePrivateGlobal) {
			checkAllowedModulePath(url, scope.verifyPath);
			let source = await readFile(new URL(url), { encoding: 'utf-8' });

			// Handle JSON modules as a SyntheticModule with a default export.
			// JSON imports only support default exports per the ESM spec.
			if (url.endsWith('.json')) {
				const jsonData = parseJsonModule(source, url);
				module = new SyntheticModule(
					['default'],
					function () {
						this.setExport('default', jsonData);
					},
					{ identifier: url, context }
				);
			} else {
				// Strip TypeScript types if this is a .ts file
				if (url.endsWith('.ts') || url.endsWith('.tsx')) {
					source = await stripTypeScriptTypes(source);
				}

				// Try CJS first since it will fail fast with clear syntax errors on ESM syntax
				try {
					module = loadCJSModule(url, source, usePrivateGlobal);
				} catch {
					// If CJS loading fails (likely due to ESM syntax like import/export), try ESM
					try {
						module = new SourceTextModule(source, {
							identifier: url,
							context,
							initializeImportMeta(meta) {
								meta.url = url;
							},
							async importModuleDynamically(specifier: string) {
								const resolvedUrl = resolveModule(specifier, url);
								const dynamicModule = await loadModuleWithCache(resolvedUrl, true);
								return dynamicModule;
							},
						});
					} catch (esmErr) {
						// Both failed - throw the ESM error as it's likely more relevant
						throw esmErr;
					}
				}
			}
		} else {
			const replacedModule = checkAllowedModulePath(url, scope.verifyPath);
			// For Node.js built-in modules (node:) and npm packages
			// Always try require first to properly handle CJS modules with named exports
			try {
				const cjsExports = replacedModule ?? require(url);
				// It's a CJS module - expose all properties as named exports
				const exportNames = Object.keys(cjsExports);
				module = new SyntheticModule(
					exportNames.length > 0 ? [...exportNames, 'default'] : ['default'],
					function () {
						if (exportNames.length > 0) {
							for (const key of exportNames) {
								this.setExport(key, cjsExports[key]);
							}
						}
						this.setExport('default', cjsExports);
					},
					{ identifier: url, context }
				);
			} catch {
				// Fall back to dynamic import for ESM packages
				const importedModule = await import(url);
				const exportNames = Object.keys(importedModule);
				module = new SyntheticModule(
					exportNames,
					function () {
						for (const key of exportNames) {
							this.setExport(key, importedModule[key]);
						}
					},
					{ identifier: url, context }
				);
			}
		}

		return module;
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
					const moduleText = await readFile(new URL(moduleSpecifier), { encoding: 'utf-8' });
					// Handle JSON files in comparttment mode the same way as in VM mode
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
function getGlobalObject(scope: ApplicationScope) {
	const appGlobal = {};
	// create the new global object, assigning all the global variables from this global
	// except those that will be natural intrinsics of the new VM
	for (let name of Object.getOwnPropertyNames(global)) {
		if (getDefaultJSGlobalNames().includes(name)) continue;
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
const REPLACED_BUILTIN_MODULES = {
	child_process: {
		exec: createSpawn(child_process.exec),
		execFile: createSpawn(child_process.execFile),
		fork: createSpawn(child_process.fork, true), // this is launching node, so deemed safe
		spawn: createSpawn(child_process.spawn),
	},
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
