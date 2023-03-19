import { pathToFileURL } from 'url';
import { secureImport } from '../security/jsLoader';
import { dirname } from 'path';

/**
 * This is the handler for JavaScript Resource modules. These are loaded through the standard app configuration, and loads
 * JS modules. The returned exports from modules are then scanned for any exported Resource classes, and if it exported
 * any, they are registered as resources. This provides a convenient file-path based routing mechanism for defining
 * Resources (in JavaScript). This goes through our secure JS loader, so modules are sandboxed if secure sandboxing
 * is enabled.
 * @param js
 * @param url_path
 * @param file_path
 * @param resources
 */
export async function handleFile(js, url_path, file_path, resources) {
	const handlers = new Map();
	const module_url = pathToFileURL(file_path).toString();
	// use our configurable secure JS import loader
	const exports = await secureImport(module_url);
	for (const name in exports) {
		// check each of the module exports to see if it implements a Resource handler
		const exported_class = exports[name];
		if (
			typeof exported_class === 'function' &&
			(exported_class.get || exported_class.put || exported_class.post || exported_class.delete)
		) {
			// use the REST handler to expose the Resource as an endpoint
			/*let handler: any = restHandler(relative_path, exported_class);
			handler.init = () => {
				// TODO: Allow for an initialization routine?
			};*/
			resources.set(dirname(url_path) + '/' + name, exported_class);
		}
	}
	return handlers;
}
