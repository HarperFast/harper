import { Scope } from '../components/Scope.ts';
import { secureImport } from '../security/jsLoader.ts';
import { dirname } from 'path';

function isResource(value: unknown) {
	return typeof value === 'function' && ('get' in value || 'put' in value || 'post' in value || 'delete' in value);
}

/**
 * This plugin loads JavaScript files and registers their exports as resources.
 * 
 * The export can be the default export and will be assigned to the root URL path.
 * 
 * Otherwise, the name of the export will be used.
 * 
 * After loading the JavaScript code using the secure import, it adds it to the global `resources` map.
 * 
 * Once a file has been loaded it cannot be unloaded without a restart. 
 * 
 * Thus, this plugin only handle files as they are added (`add` event). All other events result in a restart request.
 *
 */
export async function handleApplication(scope: Scope) {
	scope.handleEntry((entryEvent) => {
		if (entryEvent.entryType !== 'file') {
			scope.logger.warn(
				`jsResource plugin cannot handle entry type ${entryEvent.entryType}. Modify the 'files' option in ${scope.configFilePath} to only include files.`
			);
			return;
		}

		if (entryEvent.eventType !== 'add') {
			scope.requestRestart();
			return;
		}

		secureImport(entryEvent.absolutePath)
			.then((resourceModule) => {
				const root = dirname(entryEvent.urlPath).replace(/\\/g, '/').replace(/^\/$/, '');
				if (isResource(resourceModule.default)) {
					// register the resource
					scope.resources.set(root, resourceModule.default);
					scope.logger.debug(`Registered root resource: ${root}`);
				}
				recurseForResources(scope, resourceModule, root);
			})
			.catch((error) => {
				scope.logger.error(`Failed to load resource module ${entryEvent.absolutePath}: ${error}`);
				scope.requestRestart();
			});
	});
}

function recurseForResources(scope: Scope, resourceModule: any, prefix: string) {
	for (const name in resourceModule) {
		// check each of the module exports to see if it implements a Resource handler
		const exported = resourceModule[name];
		const resourcePath = `${prefix}/${name}`;
		if (isResource(exported)) {
			// expose as an endpoint
			scope.resources.set(resourcePath, exported);
			scope.logger.debug(`Registered resource: ${resourcePath}`);
		} else if (typeof exported === 'object') {
			recurseForResources(scope, exported, resourcePath);
		}
	}
}

export const suppressHandleApplicationWarning = true;
