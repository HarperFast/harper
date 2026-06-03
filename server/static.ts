import { realpathSync, existsSync, type Stats } from 'node:fs';
import { join } from 'node:path';
import type { ServerResponse } from 'node:http';
import { Scope } from '../components/Scope';
import { EntryHandler, type FileEntryEvent, type DirectoryEntryEvent } from '../components/EntryHandler';
import type { FilesOption } from '../components/deriveGlobOptions';
import send from 'send';

/**
 * Cache / response-header options shared by the config-driven plugin and the programmatic
 * `serveStatic` helper.
 *
 * - `maxAge` and `immutable` are forwarded directly to `send`.
 * - `cacheControl` is a full `Cache-Control` header value that takes precedence over `send`'s
 *   default (`send` only sets `Cache-Control` when one isn't already present).
 * - `setHeaders` is a per-file callback (like `express.static`/`sirv`) invoked just before the
 *   response headers are sent; it runs last and can override `cacheControl`.
 */
export interface StaticCacheOptions {
	maxAge?: number | string;
	immutable?: boolean;
	cacheControl?: string;
	setHeaders?: (res: ServerResponse, pathname: string, stat: Stats) => void;
}

/**
 * Options for the programmatic {@link serveStatic} helper. All options are independent of the
 * component's own `files`/`urlPath` config, so an extension can serve any directory without
 * synthesizing a Scope.
 */
export interface ServeStaticOptions extends StaticCacheOptions {
	/** Absolute directory to serve from. Defaults to `scope.directory`. */
	directory?: string;
	/** Base URL path to serve under, e.g. `'/'`. */
	urlPath?: string;
	/** Glob (or `FilesOptionObject`) to watch, relative to `directory`. Defaults to `'**'`. */
	files?: FilesOption;
	/** If enabled, serve `index.html` files from directories. Defaults to `true`. */
	index?: boolean;
	/** File extensions to try when a file is not found (e.g. `['html']`). Defaults to `[]`. */
	extensions?: string[];
	/** If `true`, fall through to the next handler when a file is not found. Defaults to `true`. */
	fallthrough?: boolean;
	/** Custom 404 handling: a file path, or `{ file, statusCode }`. */
	notFound?: string | { file: string; statusCode: number };
	/** Named middleware ordering for `scope.server.http`. Defaults to `'authentication'`. */
	before?: string;
}

type NotFoundOption = undefined | string | { file: string; statusCode: number };

/**
 * Resolved, per-request configuration used by the shared static responder.
 */
interface StaticConfig {
	index: boolean;
	extensions: string[];
	fallthrough: boolean;
	notFound: NotFoundOption;
	cache: StaticCacheOptions;
}

/**
 * The static plugin handles serving static files from the respective application directory.
 * It uses the default `EntryHandler` configured via `files` and `urlPath` to watch for file changes and updates the in-memory map of static files.
 *
 * Additionally, it supports additional options:
 * - `index`: If enabled, it will serve `index.html` files from directories.
 * - `extensions`: An array of file extensions to try when serving files. If a file is not found, it will try appending each extension in order. For example, if set to `['html'], and the request is `/page`, it will try `/page.html` if `/page` is not found.
 * - `fallthrough`: If true, it will fall through to the next handler if the file is not found. If false, it will return a 404 error.
 * - `notFound`: Can be specified as a string to serve a custom 404 page, or an object with `file` and `statusCode` properties to serve a custom file with a specific status code. This is useful for hosting SPAs that use client-side routing. Make sure to set `fallthrough` to `false`!
 * - `maxAge`, `immutable`, `cacheControl`: Control the `Cache-Control` header of served files. See {@link StaticCacheOptions}.
 *
 * This plugin dynamically updates its behavior based on the current configuration file. Users can make updates and immediately see the changes reflect in the next request.
 *
 * Updates to the `files` or `urlPath` options will clear the in-memory maps and allow them to regenerate based on the new configuration (since the default EntryHandler will regenerate anyways).
 */
export function handleApplication(scope: Scope) {
	// in-memory map of static files
	// keys are the URL paths, values are the absolute paths to the files
	const staticFiles = new Map<string, string>();
	const indexEntries = new Map<string, string>();

	// If the `files` or `urlPath` options change, clear the maps and let them regenerate
	scope.options.on('change', (key) => {
		if (key[0] === 'files' || key[0] === 'urlPath') {
			// If the files or urlPath options change, we need to reinitialize the static files map
			staticFiles.clear();
			indexEntries.clear();
			scope.logger.info(`Static files reinitialized due to change in ${key.join('.')}`);
			return;
		}
	});

	// Handle entry events for the default entry handler based on the `files` and `urlPath` options
	scope.handleEntry((entry) => updateStaticMaps(entry, staticFiles, indexEntries));

	// The config-driven plugin reads its options live from `scope.options` on each request so
	// that edits to the config file take effect on the next request without a restart.
	scope.server.http(
		createStaticResponder({
			staticFiles,
			indexEntries,
			directory: scope.directory,
			getConfig: () => {
				const fallthrough = scope.options.get(['fallthrough']) ?? true;
				if (typeof fallthrough !== 'boolean') {
					throw new Error(`Invalid fallthrough option: ${fallthrough}. Must be a boolean.`);
				}

				const index = scope.options.get(['index']) ?? true;
				if (typeof index !== 'boolean') {
					throw new Error(`Invalid index option: ${index}. Must be a boolean.`);
				}

				const extensions = scope.options.get(['extensions']) ?? [];
				if (!Array.isArray(extensions) || extensions.some((ext) => typeof ext !== 'string')) {
					throw new Error(`Invalid extensions option: ${extensions}. Must be an array of strings.`);
				}

				return {
					index,
					extensions: extensions as string[],
					fallthrough,
					// `notFound` is validated lazily in the responder (only on the not-found path)
					// to preserve the original behavior.
					notFound: scope.options.get(['notFound']) as NotFoundOption,
					cache: {
						maxAge: scope.options.get(['maxAge']) as number | string | undefined,
						immutable: scope.options.get(['immutable']) as boolean | undefined,
						cacheControl: scope.options.get(['cacheControl']) as string | undefined,
					},
				};
			},
		}),
		{ before: (scope.options.get(['before']) as string) ?? 'authentication' }
	);
}

/**
 * Programmatically serve static files from a directory, independent of the component's own
 * `files`/`urlPath` config. This is the public entry point for extensions (exported from the
 * `harper` package) that want to reuse Harper's static serving without synthesizing a Scope.
 *
 * It registers its own file watcher (rooted at `options.directory`) and an HTTP responder. The
 * returned `EntryHandler` can be awaited via its `ready` promise and is automatically closed
 * when the scope closes.
 *
 * @example
 * serveStatic(scope, {
 *   directory: buildDir,
 *   urlPath: '/',
 *   setHeaders(res, pathname) {
 *     if (pathname.includes('/assets/')) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
 *     else if (pathname.endsWith('index.html')) res.setHeader('Cache-Control', 'no-cache');
 *   },
 * });
 */
export function serveStatic(scope: Scope, options: ServeStaticOptions = {}): EntryHandler {
	const directory = options.directory ?? scope.directory;

	// in-memory map of static files; keys are URL paths, values are absolute file paths
	const staticFiles = new Map<string, string>();
	const indexEntries = new Map<string, string>();

	// Watch the target directory directly. Unlike `scope.handleEntry`, this is rooted at an
	// arbitrary `directory` rather than `scope.directory`, and is independent of the
	// component's own `files`/`urlPath` config.
	const entryHandler = new EntryHandler(
		scope.pluginName,
		directory,
		{ files: options.files ?? '**', urlPath: options.urlPath },
		scope.logger
	);
	entryHandler.on('error', (error) => scope.logger.error?.('serveStatic watcher error:', error));
	entryHandler.on('all', (entry) => updateStaticMaps(entry, staticFiles, indexEntries));
	// Tie the watcher to the scope lifecycle so it's torn down with the component.
	scope.on('close', () => void entryHandler.close());

	validateNotFoundOption(options.notFound);

	// Programmatic options are a captured snapshot (not live config reads).
	const config: StaticConfig = {
		index: options.index ?? true,
		extensions: options.extensions ?? [],
		fallthrough: options.fallthrough ?? true,
		notFound: options.notFound,
		cache: {
			maxAge: options.maxAge,
			immutable: options.immutable,
			cacheControl: options.cacheControl,
			setHeaders: options.setHeaders,
		},
	};

	scope.server.http(createStaticResponder({ staticFiles, indexEntries, directory, getConfig: () => config }), {
		before: options.before ?? 'authentication',
		// Pass urlPath explicitly so it overrides the value the Scope proxy injects from
		// `scope.options` — routing should match the directory we're actually serving.
		urlPath: options.urlPath,
	});

	return entryHandler;
}

/**
 * Maintain the in-memory `staticFiles` and `indexEntries` maps in response to entry events.
 */
function updateStaticMaps(
	entry: FileEntryEvent | DirectoryEntryEvent,
	staticFiles: Map<string, string>,
	indexEntries: Map<string, string>
): void {
	switch (entry.eventType) {
		// Directories only matter for the `index` files
		case 'addDir':
		case 'unlinkDir': {
			// Handle `index.html` for directories for if/when the user enables the `index` option
			const indexPath = join(entry.absolutePath, 'index.html');
			if (existsSync(indexPath)) {
				indexEntries[entry.eventType === 'addDir' ? 'set' : 'delete'](entry.urlPath, indexPath);
			}
			break;
		}
		// Otherwise, user must specify pattern to match individual files
		case 'add':
			// Store the file in memory for serving
			staticFiles.set(entry.urlPath, entry.absolutePath);
			// If the file is an index.html, also store it in the index entries
			if (entry.urlPath.endsWith('index.html')) {
				// Without trailing slash; null -> 301 redirect to trailing slash
				let lastSlashIndex = entry.urlPath.lastIndexOf('/');
				indexEntries.set(entry.urlPath.slice(0, lastSlashIndex), null);
				// With trailing slash; serves the index.html file
				indexEntries.set(entry.urlPath.slice(0, lastSlashIndex + 1), entry.absolutePath);
			}
			break;
		case 'unlink':
			// Remove the file from memory when it is deleted
			staticFiles.delete(entry.urlPath);
			// If the file is an index.html, remove it from the index entries as well
			if (entry.urlPath.endsWith('index.html')) {
				let lastSlashIndex = entry.urlPath.lastIndexOf('/');
				indexEntries.delete(entry.urlPath.slice(0, lastSlashIndex));
				indexEntries.delete(entry.urlPath.slice(0, lastSlashIndex + 1));
			}
			break;
	}
}

type MatchResult = { kind: 'file'; absolutePath: string } | { kind: 'redirect'; location: string } | { kind: 'none' };

/**
 * Resolve a request pathname against the in-memory maps, honoring `index` and `extensions`.
 */
function matchStaticFile(
	pathname: string,
	{
		staticFiles,
		indexEntries,
		index,
		extensions,
	}: { staticFiles: Map<string, string>; indexEntries: Map<string, string>; index: boolean; extensions: string[] }
): MatchResult {
	// Attempt to retrieve the requested static file from memory
	let staticFile = staticFiles.get(pathname);

	// If the file is not found, try matching index
	if (!staticFile && index) {
		// Retrieve index entry
		staticFile = indexEntries.get(pathname);

		// If `null`, redirect to trailing slash
		if (staticFile === null) {
			return { kind: 'redirect', location: pathname + '/' };
		}
	}

	// If the file is still not found, try matching extensions
	if (!staticFile) {
		for (const ext of extensions) {
			staticFile = staticFiles.get(`${pathname}.${ext}`);
			// break on first match
			if (staticFile) break;
		}
	}

	return staticFile ? { kind: 'file', absolutePath: staticFile } : { kind: 'none' };
}

/**
 * Serve a single file with `send`, applying cache/header options.
 *
 * The benefit to using `send` is that it handles a lot of edge cases and headers for us.
 */
function respondWithFile(req: any, absolutePath: string, cache: StaticCacheOptions) {
	const sendOptions: { maxAge?: number | string; immutable?: boolean } = {};
	if (cache.maxAge !== undefined) sendOptions.maxAge = cache.maxAge;
	if (cache.immutable !== undefined) sendOptions.immutable = cache.immutable;

	const body = send(req, realpathSync(absolutePath), sendOptions);

	if (cache.cacheControl || cache.setHeaders) {
		// `send` emits 'headers' before applying its own Cache-Control, and only sets
		// Cache-Control if one isn't already present — so values set here take precedence.
		body.on('headers', (res: ServerResponse, pathname: string, stat: Stats) => {
			if (cache.cacheControl) res.setHeader('Cache-Control', cache.cacheControl);
			// setHeaders runs last so it can override cacheControl for per-file control.
			if (cache.setHeaders) cache.setHeaders(res, pathname, stat);
		});
	}

	return { handlesHeaders: true, body };
}

/**
 * Build the `(req, next)` HTTP handler shared by the config-driven plugin and `serveStatic`.
 * `getConfig` resolves the current configuration (live from `scope.options` for the plugin, or
 * a captured snapshot for `serveStatic`).
 */
function createStaticResponder({
	staticFiles,
	indexEntries,
	directory,
	getConfig,
}: {
	staticFiles: Map<string, string>;
	indexEntries: Map<string, string>;
	directory: string;
	getConfig: () => StaticConfig;
}) {
	return (req: any, next: (req: any) => any) => {
		// TODO: Not sure if the isWebSocket check is still necessary
		if (req.method !== 'GET' || req.isWebSocket) return next(req);

		const { index, extensions, fallthrough, notFound, cache } = getConfig();

		const match = matchStaticFile(req.pathname, { staticFiles, indexEntries, index, extensions });

		if (match.kind === 'redirect') {
			return {
				status: 301,
				headers: {
					Location: match.location,
				},
			};
		}

		// If an entry matched, serve it
		if (match.kind === 'file') {
			return respondWithFile(req, match.absolutePath, cache);
		}

		// If fallthrough is true pass along the request to the next handler
		if (fallthrough) {
			return next(req);
		}

		// Otherwise, handle not found
		validateNotFoundOption(notFound);

		if (!notFound) {
			return {
				status: 404,
				body: 'File not found',
			};
		}

		const notFoundPath = join(directory, typeof notFound === 'string' ? notFound : notFound.file);
		const statusCode = typeof notFound === 'object' ? notFound.statusCode : 404;

		if (!existsSync(notFoundPath)) {
			throw new Error(`Not found file does not exist: ${notFoundPath}`);
		}

		return {
			status: statusCode,
			...respondWithFile(req, notFoundPath, cache),
		};
	};
}

function validateNotFoundOption(
	notFound: any
): asserts notFound is undefined | string | { file: string; statusCode: number } {
	if (notFound === undefined || typeof notFound === 'string') return;

	if (typeof notFound === 'object' && notFound !== null && !Array.isArray(notFound)) {
		if (!('file' in notFound) || typeof notFound.file !== 'string') {
			throw new Error(`Invalid \`notFound.file\` option: ${notFound.file}. Must be a string.`);
		}
		if (!('statusCode' in notFound) || typeof notFound.statusCode !== 'number') {
			throw new Error(`Invalid \`notFound.statusCode\` option: ${notFound.statusCode}. Must be a number.`);
		}
		return;
	}

	throw new Error(
		`Invalid notFound option: ${notFound}. Must be a string or an object with file and statusCode properties.`
	);
}
