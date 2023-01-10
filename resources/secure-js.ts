import { Transaction } from './Transaction';
import { tables } from './database';
import { registerResourceType } from './resource-server';
import { Compartment as CompartmentClass } from 'ses';
import { smrModule, doLockdown } from './secure-js-helper';
import { readFile } from 'fs/promises';
import { restHandler } from './REST-handler';

export function registerJavaScript() {
	registerResourceType('js', createHandler);
	async function createHandler(js, file_path) {
		let handlers = new Map();
		let compartment = getCompartment();
		let result = await compartment.import(file_path);
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
function getCompartment() {
	if (compartment) return compartment;
	const { harden } = doLockdown();

	return compartment = new (Compartment as typeof CompartmentClass)({
		console,
		Math,
		Transaction,
		tables,
		fetch: secureOnlyFetch,
	}, {}, {
		name: 'h-dapp',
		resolveHook(ms, mr) {
			console.log({ms,mr})
		},
		importHook: async (ms) => {
			const { StaticModuleRecord } = await smrModule;
			let moduleText = await readFile(ms, { encoding: 'utf-8'});
			let smr = new StaticModuleRecord(moduleText, ms);
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