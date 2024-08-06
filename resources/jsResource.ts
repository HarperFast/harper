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
	// use our configurable secure JS import loader
	const exports = await secureImport(file_path);
	// allow default to be used as root path handler
	if (isResource(exports.default)) resources.set(dirname(url_path), exports.default);
	recurseForResources(exports, dirname(url_path));
	function recurseForResources(exports, prefix) {
		for (const name in exports) {
			// check each of the module exports to see if it implements a Resource handler
			const exported = exports[name];
			if (isResource(exported)) {
				// expose as an endpoint
				resources.set(prefix + '/' + name, exported);
			} else if (typeof exported === 'object') {
				recurseForResources(exported, prefix + '/' + name);
			}
		}
	}
	function isResource(value) {
		return typeof value === 'function' && (value.get || value.put || value.post || value.delete);
	}
	return handlers;
}
