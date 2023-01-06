import { Transaction } from './Transaction';
import { tables } from './database';
import { registerResourceType } from './resource-server';
import { Compartment as CompartmentClass } from 'ses';
import { smrModule, doLockdown } from './secure-js-helper';
import { readFile } from 'fs/promises';

export function registerJavaScript() {
	registerResourceType('js', createHandler);
	async function createHandler(js, file_path) {
		let handlers = new Map();
		let result = await getCompartment().import(file_path);
		let exports = result.namespace;
		for (let name in exports) {
			handlers.set(name, exports[name]);
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
			return new StaticModuleRecord(moduleText, ms);
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
	let url = typeof resource === 'string' || resource.url;
	if (new URL(url).protocol != 'https')
		throw new Error('Only https is allowed in fetch');
	return fetch(resource, options);
}