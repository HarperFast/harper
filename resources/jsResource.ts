import { secureImport } from '../security/jsLoader.ts';
import { dirname } from 'path';

/**
 * This is the handler for JavaScript Resource modules. These are loaded through the standard app configuration, and loads
 * JS modules. The returned exports from modules are then scanned for any exported Resource classes, and if it exported
 * any, they are registered as resources. This provides a convenient file-path based routing mechanism for defining
 * Resources (in JavaScript). This goes through our secure JS loader, so modules are sandboxed if secure sandboxing
 * is enabled.
 * @param js
 * @param urlPath
 * @param filePath
 * @param resources
 */
export async function handleFile(js, urlPath, filePath, resources) {
	const handlers = new Map();
	// use our configurable secure JS import loader
	const exports = await secureImport(filePath);
	// allow default to be used as root path handler
	if (isResource(exports.default)) resources.set(dirname(urlPath), exports.default);
	recurseForResources(exports, dirname(urlPath));
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
