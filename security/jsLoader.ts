import { Resource } from '../resources/Resource.ts';
import { tables, databases } from '../resources/databases.ts';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { extname, dirname, isAbsolute } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { SourceTextModule, SyntheticModule, createContext, runInContext } from 'node:vm';
import { Scope } from '../components/Scope.ts';
import logger from '../utility/logging/harper_logger.js';
import { createRequire } from 'node:module';
import * as env from '../utility/environment/environmentManager';
import { CONFIG_PARAMS } from '../utility/hdbTerms.ts';

let compartment;
const SECURE_JS = env.get(CONFIG_PARAMS.COMPONENTS_SECUREJS);
/**
 * This is the main entry point for loading plugin and application modules that may be executed in a
 * separate top level scope. The scope indicates if we use a different top level scope or a standard import.
 * @param moduleUrl
 * @param scope
 */
export async function scopedImport(filePath: string, scope?: Scope) {
	const moduleUrl = pathToFileURL(filePath).toString();
	try {
		if (scope) {
			if (SECURE_JS) {
				// note that we use a single compartment that is used by all the secure JS modules and we load it on-demand, only
				// loading if necessary (since it is actually very heavy)
				if (!compartment)
					compartment = getCompartment(() => {
						return {
							server: scope?.server ?? server,
							logger: scope?.logger ?? logger,
							config: scope?.options.getRoot() ?? {},
							...getGlobalVars(),
						};
					});
				const result = await (await compartment).import(moduleUrl);
				return result.namespace;
			}
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
 * Load a module using Node's vm.Module API with secure sandboxing
 */
async function loadModuleWithVM(moduleUrl: string, scope: Scope) {
	const moduleCache = new Map<string, SourceTextModule | SyntheticModule>();

	// Create a secure context with limited globals
	const contextObject = {
		server: scope?.server ?? server,
		logger: scope?.logger ?? logger,
		config: scope?.options.getRoot() ?? {},
		...getGlobalVars(),
	};
	const context = createContext(contextObject);

	/**
	 * Resolve module specifier to absolute URL
	 */
	function resolveModule(specifier: string, referrer: string): string {
		if (specifier === 'harperdb') return 'harperdb';
		if (specifier.startsWith('file://')) {
			return specifier;
		}
		const resolved = createRequire(referrer).resolve(specifier);
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
			if (spec.startsWith('.')) {
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
		return new SyntheticModule(
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

		// Load the module
		return await loadModule(resolvedUrl, specifier.startsWith('.'));
	}

	/**
	 * Load a module from URL and create appropriate vm.Module
	 */
	async function loadModule(url: string, usePrivateGlobal: boolean): Promise<SourceTextModule | SyntheticModule> {
		// Check cache
		if (moduleCache.has(url)) {
			return moduleCache.get(url)!;
		}

		let module: SourceTextModule | SyntheticModule;

		// Handle special built-in modules
		if (url === 'harperdb') {
			module = new SyntheticModule(
				['Resource', 'tables', 'databases'],
				function () {
					this.setExport('Resource', Resource);
					this.setExport('tables', tables);
					this.setExport('databases', databases);
				},
				{ identifier: url, context }
			);
		} else if (usePrivateGlobal && url.startsWith('file://')) {
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
						try {
							const dynamicModule = await loadModule(resolvedUrl, specifier.startsWith('.'));
							await dynamicModule.link(linker);
							await dynamicModule.evaluate();
							return dynamicModule;
						} catch (err) {
							// If loading as ESM fails, try CJS
							// If ESM parsing fails, try to load as CommonJS
							if (
								err.message?.includes('Cannot use import statement') ||
								err.message?.includes('Unexpected token') ||
								source.includes('module.exports') ||
								source.includes('exports.')
							) {
								const cjsSource = await readFile(new URL(resolvedUrl), { encoding: 'utf-8' });
								const cjsModule = loadCJSModule(resolvedUrl, cjsSource, specifier.startsWith('.'));
								await cjsModule.link(linker);
								await cjsModule.evaluate();
								return cjsModule;
							}
							throw err;
						}
					},
				});
			} catch (err) {
				// If ESM parsing fails, try to load as CommonJS
				if (
					err.message?.includes('Cannot use import statement') ||
					err.message?.includes('Unexpected token') ||
					source.includes('module.exports') ||
					source.includes('exports.')
				) {
					module = loadCJSModule(url, source, usePrivateGlobal);
				} else {
					throw err;
				}
			}
		} else {
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

		// Cache the module
		moduleCache.set(url, module);

		return module;
	}

	// Load the entry module
	const entryModule = await loadModule(moduleUrl, true);

	// Link the module (resolve all imports)
	await entryModule.link(linker);

	// Evaluate the module
	await entryModule.evaluate();

	// Return the module namespace (exports)
	return entryModule.namespace;
}

declare class Compartment extends CompartmentClass {}
async function getCompartment(getGlobalVars) {
	const { StaticModuleRecord } = await import('@endo/static-module-record');
	require('ses');
	lockdown({
		domainTaming: 'unsafe',
		consoleTaming: 'unsafe',
		errorTaming: 'unsafe',
		errorTrapping: 'none',
		stackFiltering: 'verbose',
	});

	compartment = new (Compartment as typeof CompartmentClass)(
		{
			console,
			Math,
			Date,
			fetch: secureOnlyFetch,
			...getGlobalVars(),
		},
		{
			//harperdb: { Resource, tables, databases }
		},
		{
			name: 'harper-app',
			resolveHook(moduleSpecifier, moduleReferrer) {
				if (moduleSpecifier === 'harperdb') return 'harperdb';
				const resolved = createRequire(moduleReferrer).resolve(moduleSpecifier);
				if (isAbsolute(resolved)) {
					const resolvedURL = pathToFileURL(resolved).toString();
					return resolvedURL;
				}
				return moduleSpecifier;
			},
			importHook: async (moduleSpecifier) => {
				console.log('importHook', moduleSpecifier);
				if (moduleSpecifier === 'harperdb') {
					return {
						imports: [],
						exports: ['Resource', 'tables', 'databases'],
						execute(exports) {
							exports.Resource = Resource;
							exports.tables = tables;
							exports.databases = databases;
						},
					};
				} else if (moduleSpecifier.startsWith('file:') && !moduleSpecifier.includes('node_modules')) {
					const moduleText = await readFile(new URL(moduleSpecifier), { encoding: 'utf-8' });
					return new StaticModuleRecord(moduleText, moduleSpecifier);
				} else {
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

/**
 * Get the set of global variables that should be available to the h-dapp modules
 */
function getGlobalVars() {
	return {
		Resource,
		tables,
		process,
		global,
		Request,
		Headers,
		TextEncoder,
		performance,
		Buffer,
		URLSearchParams,
		URL,
		AbortController,
		ReadableStream,
		TextDecoder,
		FormData,
		WritableStream,
		console,
		Math,
		setTimeout,
		setInterval,
		Date,
		fetch: secureOnlyFetch,
	};
}
