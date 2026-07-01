import { Scope } from '../components/Scope.ts';
import { dirname } from 'path';

function isResource(value: any) {
	return (
		value &&
		(typeof value.get === 'function' ||
			typeof value.put === 'function' ||
			typeof value.post === 'function' ||
			typeof value.delete === 'function')
	);
}

/**
 * Resolve the URL path a resource should be registered at, given the directory it was discovered in (`prefix`) and a
 * declared path (either the resource's `static path` field or its export name).
 *
 * - A leading `/` makes the path root-relative (top-level), ignoring the component directory.
 * - A leading `./` (or no leading slash) resolves the path relative to the component directory.
 *
 * Parameterised segments (`:id`, `*rest`) are preserved verbatim and interpreted later by the route matcher.
 */
export function resolveResourcePath(prefix: string, declaredPath: string): string {
	let resolved: string;
	if (declaredPath.startsWith('/')) {
		// root-relative (top-level): strip the leading slash(es) so it is not joined to the component directory
		resolved = declaredPath.replace(/^\/+/, '');
	} else {
		// './x' is component-relative, same as a bare name; preserve the historical `${prefix}/${name}` join
		// (an empty prefix yields a leading slash, which Resources.set strips — but plain-Map consumers rely on it)
		const relative = declaredPath.startsWith('./') ? declaredPath.slice(2) : declaredPath;
		resolved = `${prefix}/${relative}`;
	}
	// a trailing slash would add an empty final segment that can never match (incoming URLs are normalized first)
	return resolved.endsWith('/') ? resolved.replace(/\/+$/, '') : resolved;
}

/**
 * The path a resource declares for itself via a `static path` field, if any.
 */
function declaredPath(exported: any): string | undefined {
	return typeof exported?.path === 'string' ? exported.path : undefined;
}

/**
 * Error thrown when a JavaScript resource module fails to load
 */
export class ResourceLoadError extends Error {
	public readonly filePath: string;
	public readonly cause?: Error;

	constructor(filePath: string, cause?: Error) {
		super(`Failed to load resource module ${filePath}${cause ? `: ${cause.message}` : ''}`);
		this.name = 'ResourceLoadError';
		this.filePath = filePath;
		this.cause = cause;
	}
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
	scope.handleEntry(async function handleResourceEntry(entryEvent) {
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

		try {
			const resourceModule: any = await scope.import(entryEvent.absolutePath);
			const root = dirname(entryEvent.urlPath).replace(/\\/g, '/').replace(/^\/$/, '');
			if (isResource(resourceModule.default)) {
				// register the resource, honoring a `static path` field if the resource declares one
				const declared = declaredPath(resourceModule.default);
				const path = declared ? resolveResourcePath(root, declared) : root;
				scope.resources.set(path, resourceModule.default);
				scope.logger.debug?.(`Registered root resource: ${path}`);
			}
			recurseForResources(scope, resourceModule, root);
		} catch (error) {
			// Rethrow with more context
			throw new ResourceLoadError(entryEvent.absolutePath, error);
		}
	});
}

function recurseForResources(scope: Scope, resourceModule: any, prefix: string) {
	for (const name in resourceModule) {
		// check each of the module exports to see if it implements a Resource handler
		const exported = resourceModule[name];
		if (isResource(exported)) {
			// A `static path` field overrides the export name; otherwise the export name itself is the declared path
			// (which may be a leading-slash root path, e.g. `export { Widget as '/widget/:id' }`).
			const resourcePath = resolveResourcePath(prefix, declaredPath(exported) ?? name);
			// expose as an endpoint
			scope.resources.set(resourcePath, exported);
			scope.logger.debug?.(`Registered resource: ${resourcePath}`);
		} else if (typeof exported === 'object') {
			recurseForResources(scope, exported, `${prefix}/${name}`);
		}
	}
}
