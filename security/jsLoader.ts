import { Resource, contextStorage } from '../resources/Resource.ts';
import { tables, databases } from '../resources/databases.ts';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { SourceTextModule, SyntheticModule, createContext, runInContext } from 'node:vm';
import { Scope } from '../components/Scope.ts';
import logger from '../utility/logging/harper_logger.js';
import { createRequire } from 'node:module';
import * as env from '../utility/environment/environmentManager';
import { CONFIG_PARAMS } from '../utility/hdbTerms.ts';
import type { CompartmentOptions } from 'ses';

type ContainmentMode = 'none' | 'vm' | 'compartment';
const APPLICATIONS_CONTAINMENT: ContainmentMode = env.get(CONFIG_PARAMS.APPLICATIONS_CONTAINMENT);
const APPLICATIONS_DEPENDENCYCONTAINMENT: boolean = env.get(CONFIG_PARAMS.APPLICATIONS_DEPENDENCYCONTAINMENT);
const APPLICATIONS_LOCKDOWN: boolean = env.get(CONFIG_PARAMS.APPLICATIONS_LOCKDOWN);

let lockedDown = false;
/**
 * This is the main entry point for loading plugin and application modules that may be executed in a
 * separate top level scope. The scope indicates if we use a different top level scope or a standard import.
 * @param moduleUrl
 * @param scope
 */
export async function scopedImport(filePath: string | URL, scope?: Scope) {
	preventFunctionConstructor();
	if (APPLICATIONS_LOCKDOWN && !lockedDown) {
		require('ses');
		lockedDown = true;
		lockdown({
			domainTaming: 'unsafe',
			consoleTaming: 'unsafe',
			errorTaming: 'unsafe',
			errorTrapping: 'none',
			stackFiltering: 'verbose',
		});
	}
	const moduleUrl = (filePath instanceof URL ? filePath : pathToFileURL(filePath)).toString();
	try {
		const containmentMode = scope?.applicationContainment?.mode ?? APPLICATIONS_CONTAINMENT;
		if (scope && containmentMode !== 'none') {
			if (containmentMode === 'compartment') {
				// use SES Compartments
				// note that we use a single compartment per scope and we load it on-demand, only
				// loading if necessary (since it is actually very heavy)
				const globals = getGlobalObject(scope);
				if (!scope.compartment) scope.compartment = getCompartment(scope, globals);
				const result = await (await scope.compartment).import(moduleUrl);
				return result.namespace;
			} // else use standard node:vm module to do containment
			return await loadModuleWithVM(moduleUrl, scope);
		} else {
			// important! we need to await the import, otherwise the error will not be caught
			return await import(moduleUrl);
		}
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

/**
 * Load a module using Node's vm.Module API with (not really secure) sandboxing
 */
async function loadModuleWithVM(moduleUrl: string, scope: Scope) {
	const moduleCache = new Map<string, Promise<SourceTextModule | SyntheticModule>>();

	// Create a secure context with limited globals
	const contextObject = getGlobalObject(scope);
	const context = createContext(contextObject);

	/**
	 * Resolve module specifier to absolute URL
	 */
	function resolveModule(specifier: string, referrer: string): string {
		if (specifier === 'harperdb' || specifier === 'harper') return 'harper';
		if (specifier.startsWith('file://')) {
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
		const cjsModule = { exports: {} };
		if (url.endsWith('.json')) {
			cjsModule.exports = JSON.parse(source);
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
				const useContainment =
					specifier.startsWith('.') ||
					(scope.applicationContainment?.dependencyContainment ?? APPLICATIONS_DEPENDENCYCONTAINMENT);
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
		moduleCache.set(url, synModule);
		return synModule;
	}

	/**
	 * Linker function for module resolution during instantiation
	 */
	async function linker(specifier: string, referencingModule: SourceTextModule | SyntheticModule) {
		const resolvedUrl = resolveModule(specifier, referencingModule.identifier);

		// Check cache first
		if (moduleCache.has(resolvedUrl)) {
			return moduleCache.get(resolvedUrl)!;
		}

		const useContainment =
			specifier.startsWith('.') ||
			(scope.applicationContainment?.dependencyContainment ?? APPLICATIONS_DEPENDENCYCONTAINMENT);
		// Load the module
		return await loadModuleWithCache(resolvedUrl, useContainment);
	}

	function loadModuleWithCache(url: string, usePrivateGlobal: boolean): Promise<SourceTextModule | SyntheticModule> {
		// Check cache
		if (moduleCache.has(url)) {
			return moduleCache.get(url)!;
		}
		const loadingModule = loadModule(url, usePrivateGlobal);
		moduleCache.set(url, loadingModule);
		return loadingModule;
	}
	/**
	 * Load a module from URL and create appropriate vm.Module
	 */
	async function loadModule(url: string, usePrivateGlobal: boolean): Promise<SourceTextModule | SyntheticModule> {
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
		} else if (usePrivateGlobal && url.startsWith('file://')) {
			checkAllowedModulePath(url, scope.applicationContainment?.verifyPath ?? scope.directory);
			// Load source text from file
			const source = await readFile(new URL(url), { encoding: 'utf-8' });

			// Try to parse as ESM first
			try {
				module = new SourceTextModule(source, {
					identifier: url,
					context,
					initializeImportMeta(meta) {
						meta.url = url;
					},
					async importModuleDynamically(specifier: string, script) {
						const resolvedUrl = resolveModule(specifier, url);
						const dynamicModule = await loadModuleWithCache(resolvedUrl, true);
						return dynamicModule;
					},
				});
				// Cache the module
				moduleCache.set(url, module);
				// Link the module (resolve all imports)
				await module.link(linker);

				// Evaluate the module
				await module.evaluate();
				return module;
			} catch (err) {
				// If ESM parsing fails, try to load as CommonJS
				// but first try the cache again
				if (
					err.message?.includes('require is not defined') ||
					source.includes('module.exports') ||
					source.includes('exports.')
				) {
					module = loadCJSModule(url, source, usePrivateGlobal);
				} else {
					throw err;
				}
			}
		} else {
			checkAllowedModulePath(url, scope.applicationContainment?.verifyPath ?? scope.directory);
			// For Node.js built-in modules (node:) and npm packages, use dynamic import
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

		// Link the module (resolve all imports)
		await module.link(linker);

		// Evaluate the module
		await module.evaluate();

		return module;
	}

	// Load the entry module
	const entryModule = await loadModuleWithCache(moduleUrl, true);

	// Return the module namespace (exports)
	return entryModule.namespace;
}

declare class Compartment extends CompartmentClass {}
async function getCompartment(scope: Scope, globals) {
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
				if (moduleSpecifier === 'harperdb' || moduleSpecifier === 'harper') return 'harper';
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
					return new StaticModuleRecord(moduleText, moduleSpecifier);
				} else {
					checkAllowedModulePath(moduleSpecifier, scope.applicationContainment?.verifyPath ?? scope.directory);
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
	if (new URL(url).protocol != 'https') throw new Error(`Only https is allowed in fetch`);
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
function getGlobalObject(scope: Scope) {
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
		config: scope.options.getRoot() ?? {},
		fetch: secureOnlyFetch,
		console,
		global: appGlobal,
	});
	return appGlobal;
}
function getHarperExports(scope: Scope) {
	return {
		server: scope.server ?? server,
		logger: scope.logger ?? logger,
		resources: scope.resources,
		config: scope.options.getRoot() ?? {},
		Resource,
		tables,
		databases,
		createBlob,
		getContext,
	};
}
const ALLOWED_NODE_BUILTIN_MODULES = new Set([
	'assert',
	'http',
	'https',
	'path',
	'url',
	'util',
	'stream',
	'crypto',
	'buffer',
	'string_decoder',
	'querystring',
	'punycode',
	'zlib',
	'events',
	'timers',
	'async_hooks',
	'console',
	'perf_hooks',
	'diagnostics_channel',
]);
function checkAllowedModulePath(moduleUrl: string, containingFolder: string): boolean {
	if (moduleUrl.startsWith('file:')) {
		const path = moduleUrl.slice(7);
		if (path.startsWith(containingFolder)) {
			return true;
		}
		throw new Error(`Can not load module outside of application folder`);
	}
	let simpleName = moduleUrl.startsWith('node:') ? moduleUrl.slice(5) : moduleUrl;
	simpleName = simpleName.split('/')[0];
	if (ALLOWED_NODE_BUILTIN_MODULES.has(simpleName)) return true;
	throw new Error(`Module ${moduleUrl} is not allowed to be imported`);
}

function getContext() {
	return contextStorage.getStore() ?? {};
}

export function preventFunctionConstructor() {
	Function.prototype.constructor = function () {}; // prevent this from being used to eval data in a parent context
}
