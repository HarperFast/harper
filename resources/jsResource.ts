import { Scope } from '../components/Scope.ts';
import { dirname } from 'path';
import { signalResourcesRegistered } from '../utility/signalling.ts';

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
 * A redeploy tears down and reinstalls the component's files while this scope's watcher is paused
 * (see `Scope`/`EntryHandler` deploy lifecycle); on resume the fresh chokidar scan re-emits every
 * existing file as `'add'` — including ones whose contents just changed. Treating those as plain
 * adds would silently re-run against the stale module cache and never flag a restart (harper#1817).
 * So we track which files this scope has already loaded: a re-`add` of a known file is a redeploy of
 * loaded code we cannot hot-swap, and is handled like a `change` — request a restart. A first-time
 * `add` (initial load, or a genuinely new file added at runtime) still loads without a restart.
 *
 * A redeploy that *deletes* a loaded file is a different shape of the same problem: the fresh
 * chokidar scan only reports what's currently on disk, so a file that's gone produces no event at
 * all — no re-`add`, no `unlink` — and the modified-file handling above never sees it. Left
 * unhandled, the deleted resource stays registered and active in memory (harper#1817 follow-up). So
 * we also track which files the post-redeploy scan pass reports, and once that scan's `ready` fires,
 * diff it against everything this scope has ever loaded: anything missing was deleted, and is
 * handled the same way as a modified file — request a restart.
 *
 * That diff must only run for an actual redeploy rescan, not every time `EntryHandler` emits
 * `ready` — it also refires after each ordinary runtime add/change once that file's read settles
 * (its initial-scan-complete latch never resets outside a full rescan), and diffing against that
 * would falsely treat every other already-loaded file as deleted. So the diff window is gated by
 * the scope's own `deploy:start`/`deploy:end` bracket (see `Scope`): `deploy:start` pauses the
 * watcher and opens the window (and is where we reset the scan-file tracking, since no file events
 * can land while paused), and the first `ready` afterward — the resumed watcher's fresh scan
 * completing — closes it and runs the diff.
 */
export async function handleApplication(scope: Scope) {
	const loadedResourceFiles = new Set<string>();
	// Files reported as `add` since the most recent `deploy:start`, populated only while
	// `awaitingPostRedeployScan` is true — see the gating note above.
	let currentScanFiles = new Set<string>();
	let awaitingPostRedeployScan = false;

	const entryHandler = scope.handleEntry(async function handleResourceEntry(entryEvent) {
		if (entryEvent.entryType !== 'file') {
			scope.logger.warn(
				`jsResource plugin cannot handle entry type ${entryEvent.entryType}. Modify the 'files' option in ${scope.configFilePath} to only include files.`
			);
			return;
		}

		if (awaitingPostRedeployScan && entryEvent.eventType === 'add') {
			// Recorded unconditionally — before the loaded/re-add branch below — so the post-scan
			// deletion diff sees every file this scan reported, whether newly loaded or already known.
			currentScanFiles.add(entryEvent.absolutePath);
		}

		if (entryEvent.eventType !== 'add' || loadedResourceFiles.has(entryEvent.absolutePath)) {
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
			// Record the load so a later re-`add` of this same file (a redeploy re-scan) is treated
			// as a change and requests a restart rather than silently re-serving stale cached code.
			loadedResourceFiles.add(entryEvent.absolutePath);
			// A JS resource that extends an exported @table is the one carrying author opt-ins
			// (`static mcpTools`/`mcpPrompts`), and it registers here — after the schema-derived
			// table class and after the MCP component's boot scan. Signal so listing surfaces
			// (MCP application tools) rebuild against the now-settled registry (#1448).
			signalResourcesRegistered();
		} catch (error) {
			// Rethrow with more context
			throw new ResourceLoadError(entryEvent.absolutePath, error);
		}
	});

	// Optional chaining: a mock/test scope may not implement EventEmitter, and Scope#handleEntry
	// itself can return undefined (e.g. MissingDefaultFilesOptionError). In real use `scope` is
	// always an EventEmitter and `entryHandler` is always the EntryHandler backing this watcher.
	scope.on?.('deploy:start', () => {
		awaitingPostRedeployScan = true;
		currentScanFiles = new Set();
	});

	entryHandler?.on?.('ready', () => {
		if (!awaitingPostRedeployScan) return;
		awaitingPostRedeployScan = false;
		for (const loadedFile of loadedResourceFiles) {
			if (!currentScanFiles.has(loadedFile)) {
				// Known file that the just-completed scan never reported — deleted during the redeploy.
				loadedResourceFiles.delete(loadedFile);
				scope.requestRestart();
			}
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
