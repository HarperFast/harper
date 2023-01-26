import { registerResourceType } from './resource-server';
import { restHandler } from './REST-handler';
import { pathToFileURL } from 'url';
import { secureImport} from './secure-js';
import { Resource } from './Resource';
import { tables } from './database';

const SECURE_JS = true;
export function registerJavaScript() {
	registerResourceType('js', createHandler);
	async function createHandler(js, file_path) {
		let handlers = new Map();

		// note that we use a single compartment that is used by all the secure JS modules and we load it on-demand, only
		// loading if necessary (since it is actually very heavy)
		let exports;
		let js_url = pathToFileURL(file_path).toString();
		if (SECURE_JS) {
			exports = await secureImport(js_url, getGlobalVars);
		} else {
			if (!global.Resource)
				Object.assign(global, getGlobalVars());
			exports = await import(js_url);
		}
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
function getGlobalVars() {
	return {
		Resource,
		tables,
	}
}
export const start = registerJavaScript;