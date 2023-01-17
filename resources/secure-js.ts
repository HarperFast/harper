import { Resource } from './Resource';
import { tables } from './database';
import { registerResourceType } from './resource-server';
import { Compartment as CompartmentClass } from 'ses';
import { doLockdown } from './secure-js-helper';
import { readFile } from 'fs/promises';
import { restHandler } from './REST-handler';
import { pathToFileURL } from 'url';
import { extname } from 'path';

export function registerJavaScript() {
	registerResourceType('js', createHandler);
	async function createHandler(js, file_path) {
		let handlers = new Map();
		// note that we use a single compartment that is used by all the secure JS modules and we load it on-demand, only
		// loading if necessary (since it is actually very heavy)
		let compartment = await getCompartment();
		let result = await compartment.import(pathToFileURL(file_path).toString());
		let exports = result.namespace;
		for (let name in exports) {
			let exported_class = exports[name];
			if (typeof exported_class === 'function' && exported_class.prototype &&
					(exported_class.prototype.get || exported_class.prototype.put || exported_class.prototype.post || exported_class.prototype.delete)) {
				let handler: any = restHandler(exported_class);
				handler.init = () => {

				};
				handlers.set(name, handler);
			}
		}
		console.log({handlers});
		return handlers;
	}
}

declare class Compartment extends CompartmentClass {}
let compartment;
async function getCompartment() {
	if (compartment) return compartment;
	require('ses');
	lockdown({ domainTaming: 'unsafe', consoleTaming: 'unsafe', errorTaming: 'unsafe', errorTrapping: 'none', stackFiltering: 'verbose' });
	const { StaticModuleRecord } = await import('@endo/static-module-record');

	return compartment = new (Compartment as typeof CompartmentClass)({
		console,
		Math,
		Date,
		Resource,
		tables,
		fetch: secureOnlyFetch,
	}, {}, {
		name: 'h-dapp',
		resolveHook(module_specifier, module_referrer) {
			module_specifier = new URL(module_specifier, module_referrer).toString();
			console.log({module_specifier})
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
export const start = registerJavaScript;