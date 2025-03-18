import { Resource } from '../resources/Resource';
import { tables, databases } from '../resources/databases';
import { Compartment as CompartmentClass } from 'ses';
import { readFile } from 'fs/promises';
import { extname } from 'path';
import { pathToFileURL } from 'url';

// TODO: Make this configurable
const SECURE_JS = false;

let compartment;

/**
 * This is the main entry point for loading plugin and application modules that may be sandboxed/constrained to a
 * secure JavaScript compartment. The configuration defines if these are loaded in a secure compartment or if they
 * are just loaded with a standard import.
 * @param module_url
 */
export async function secureImport(file_path) {
	const module_url = pathToFileURL(file_path).toString();
	if (SECURE_JS) {
		// note that we use a single compartment that is used by all the secure JS modules and we load it on-demand, only
		// loading if necessary (since it is actually very heavy)
		if (!compartment) compartment = getCompartment(getGlobalVars);
		const result = await (await compartment).import(module_url);
		return result.namespace;
	} else {
		try {
			// important! we need to await the import, otherwise the error will not be caught
			return await import(module_url);
		} catch (err) {
			try {
				// the actual parse error (internally known as the "arrow message")
				// is hidden behind a private symbol (arrow_message_private_symbol)
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
			name: 'h-dapp',
			resolveHook(module_specifier, module_referrer) {
				if (module_specifier === 'harperdb') return 'harperdb';
				module_specifier = new URL(module_specifier, module_referrer).toString();
				if (!extname(module_specifier)) module_specifier += '.js';
				return module_specifier;
			},
			importHook: async (module_specifier) => {
				if (module_specifier === 'harperdb') {
					return {
						imports: [],
						exports: ['Resource', 'tables', 'databases'],
						execute(exports) {
							Object.assign(exports, { Resource, tables: tables, databases });
						},
					};
				}
				const moduleText = await readFile(new URL(module_specifier), { encoding: 'utf-8' });
				return new StaticModuleRecord(moduleText, module_specifier);
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
		tables: tables,
	};
}
