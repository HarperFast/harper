import { pathToFileURL } from 'url';
import { secureImport } from './jsLoader';

export async function handleFile(js, relative_path, file_path, resources) {
	let handlers = new Map();
	let module_url = pathToFileURL(file_path).toString();
	// use our configurably secure JS import loader
	let exports = await secureImport(module_url);
	for (let name in exports) {
		// check each of the module exports to see if it implements a Resource handler
		let exported_class = exports[name];
		if (
			typeof exported_class === 'function' &&
			exported_class.prototype &&
			(exported_class.prototype.get ||
				exported_class.prototype.put ||
				exported_class.prototype.post ||
				exported_class.prototype.delete)
		) {
			// use the REST handler to expose the Resource as an endpoint
			/*let handler: any = restHandler(relative_path, exported_class);
			handler.init = () => {
				// TODO: Allow for an initialization routine?
			};*/
			resources.set('/' + name, exported_class);
		}
	}
	return handlers;
}
