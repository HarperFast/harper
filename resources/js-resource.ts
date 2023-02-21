import { registerResourceType } from './resource-server';
import { restHandler } from './REST-handler';
import { pathToFileURL } from 'url';
import { secureImport} from './secure-js';
import { Resource } from './Resource';
import { tables } from './database';

// TODO: Make this configurable
const SECURE_JS = true;
export function registerJavaScript() {
	registerResourceType('js', createHandler);
}
export async function handleFile(js, relative_path, file_path) {
	let handlers = new Map();
	let exports;
	let module_url = pathToFileURL(file_path).toString();
	if (SECURE_JS) {
		// use our secure JS import loader
		exports = await secureImport(module_url, getGlobalVars);
	} else {
		if (!global.Resource)
			Object.assign(global, getGlobalVars());
		exports = await import(module_url);
	}
	for (let name in exports) {
		// check each of the module exports to see if it implements a Resource handler
		let exported_class = exports[name];
		if (typeof exported_class === 'function' && exported_class.prototype &&
			(exported_class.prototype.get || exported_class.prototype.put || exported_class.prototype.post || exported_class.prototype.delete)) {
			// use the REST handler to expose the Resource as an endpoint
			let handler: any = restHandler(relative_path, exported_class);
			handler.init = () => {
				// TODO: Allow for an initialization routine?
			};
			handlers.set(name, handler);
		}
	}
	return handlers;
}

/**
 * Get the set of global variables that should be available to the h-dapp modules
 */
function getGlobalVars() {
	return {
		Resource,
		tables,
	}
}
