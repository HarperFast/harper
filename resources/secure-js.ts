import { Resource } from './Resource';
import { tables } from './database';
import { Compartment as CompartmentClass } from 'ses';
import { readFile } from 'fs/promises';
import { extname } from 'path';

export async function secureImport(url, getGlobalVars) {
	// note that we use a single compartment that is used by all the secure JS modules and we load it on-demand, only
	// loading if necessary (since it is actually very heavy)
	let compartment = await getCompartment(getGlobalVars);
	let result = await compartment.import(url);
	return result.namespace;
}

declare class Compartment extends CompartmentClass {}
let compartment;
async function getCompartment(getGlobalVars) {
	if (compartment) return compartment;
	require('ses');
	lockdown({ domainTaming: 'unsafe', consoleTaming: 'unsafe', errorTaming: 'unsafe', errorTrapping: 'none', stackFiltering: 'verbose' });
	const { StaticModuleRecord } = await import('@endo/static-module-record');

	return compartment = new (Compartment as typeof CompartmentClass)(Object.assign({
		console,
		Math,
		Date,
		fetch: secureOnlyFetch,
	}, getGlobalVars()), {}, {
		name: 'h-dapp',
		resolveHook(module_specifier, module_referrer) {
			module_specifier = new URL(module_specifier, module_referrer).toString();
			if (!extname(module_specifier))
				module_specifier += '.js';
			return module_specifier;
		},
		importHook: async (module_specifier) => {
			let moduleText = await readFile(new URL(module_specifier), { encoding: 'utf-8'});
			let smr = new StaticModuleRecord(moduleText, module_specifier);
			return smr;
		}
	});
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
	let url = typeof resource === 'string' || resource.url;
	if (new URL(url).protocol != 'https')
		throw new Error('Only https is allowed in fetch');
	return fetch(resource, options);
}
