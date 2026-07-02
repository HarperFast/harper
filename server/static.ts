import { realpathSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { Scope } from '../components/Scope';
import { resolveBaseURLPath } from '../components/resolveBaseURLPath.ts';
import send from 'send';

/**
 * The static plugin handles serving static files from the respective application directory.
 * It uses the default `EntryHandler` configured via `files` and `urlPath` to watch for file changes and updates the in-memory map of static files.
 *
 * Additionally, it supports additional options:
 * - `index`: If enabled, it will serve `index.html` files from directories.
 * - `extensions`: An array of file extensions to try when serving files. If a file is not found, it will try appending each extension in order. For example, if set to `['html'], and the request is `/page`, it will try `/page.html` if `/page` is not found.
 * - `fallthrough`: If true, it will fall through to the next handler if the file is not found. If false, it will return a 404 error.
 * - `notFound`: Can be specified as a string to serve a custom 404 page, or an object with `file` and `statusCode` properties to serve a custom file with a specific status code. This is useful for hosting SPAs that use client-side routing. Make sure to set `fallthrough` to `false`!
 * - `before` / `after`: Position this handler in the HTTP middleware chain relative to another named
 *   handler. By default the handler runs `before: 'authentication'` — and therefore before the REST
 *   handler — so plain file requests skip credential parsing. That default means a `fallthrough: false`
 *   catch-all answers GETs for exported REST resources too; an SPA with history-mode routing should set
 *   `after: 'rest'` so the API is matched first and only unmatched URLs receive the `notFound` fallback.
 *   `before: false` clears the default without adding a new constraint (registration order applies).
 *   Ordering is applied when the component loads; changing it requires a restart.
 *
 * This plugin dynamically updates its behavior based on the current configuration file. Users can make updates and immediately see the changes reflect in the next request.
 *
 * Updates to the `files` option will clear the in-memory maps and allow them to regenerate based on the new configuration (since the default EntryHandler will regenerate anyways).
 * Updates to `urlPath` request a restart: the HTTP route mount is registered once at load and cannot be re-registered on a live server (#1583).
 */
export function handleApplication(scope: Scope) {
	// in-memory map of static files
	// keys are the URL paths relative to the mount base, values are the absolute paths to the files
	const staticFiles = new Map<string, string>();
	const indexEntries = new Map<string, string>();

	// The HTTP route below is registered once, with the urlPath in effect at load time; the mount
	// cannot be re-registered at runtime. Capture the matching base once so map keys always agree
	// with the registered route (#1583).
	const baseURLPath = resolveBaseURLPath(scope.pluginName, (scope.options.getAll() as any)?.urlPath);

	const before = scope.options.get(['before']);
	const after = scope.options.get(['after']);
	validateOrderingOption('before', before, true);
	validateOrderingOption('after', after, false);

	// With the default ordering this handler answers unmatched GETs ahead of the REST handler, so a
	// `fallthrough: false` catch-all makes any exported REST resources unreachable over GET.
	const warnIfBlockingRest = () => {
		if (before === undefined && after === undefined && scope.options.get(['fallthrough']) === false) {
			scope.logger.warn(
				`The static handler runs before authentication and REST by default, so \`fallthrough: false\` answers every unmatched GET itself — including GETs for any exported REST resources. If this application serves an API, add \`after: 'rest'\` to the static options so API requests are matched first, or remove \`fallthrough: false\`.`
			);
		}
	};
	warnIfBlockingRest();

	scope.options.on('change', (key) => {
		if (key[0] === 'files') {
			// If the files option changes, clear the maps and let the entry handler regenerate them
			staticFiles.clear();
			indexEntries.clear();
			scope.logger.info(`Static files reinitialized due to change in ${key.join('.')}`);
			return;
		}
		if (key[0] === 'urlPath') {
			// The route mount cannot be changed on a live server registration — restart to apply
			scope.requestRestart();
			return;
		}
		if (key[0] === 'fallthrough') {
			warnIfBlockingRest();
		}
	});

	// Handle entry events for the default entry handler based on the `files` and `urlPath` options
	scope.handleEntry((entry) => {
		// entry.urlPath includes the component's base URL path, but when a `urlPath` is configured
		// the routing chain strips that mount prefix from req.pathname before this plugin's handler
		// runs — so key the maps relative to the base (#1583)
		const urlPath =
			baseURLPath !== '/' && entry.urlPath.startsWith(baseURLPath)
				? entry.urlPath.slice(baseURLPath.length - 1)
				: entry.urlPath;
		switch (entry.eventType) {
			// Directories only matter for the `index` files
			case 'addDir':
			case 'unlinkDir':
				// Handle `index.html` for directories for if/when the user enables the `index` option
				const indexPath = join(entry.absolutePath, 'index.html');
				if (existsSync(indexPath)) {
					indexEntries[entry.eventType === 'addDir' ? 'set' : 'delete'](urlPath, indexPath);
				}
				break;
			// Otherwise, user must specify pattern to match individual files
			case 'add':
				// Store the file in memory for serving
				staticFiles.set(urlPath, entry.absolutePath);
				// If the file is an index.html, also store it in the index entries
				if (urlPath.endsWith('index.html')) {
					// Without trailing slash; null -> 301 redirect to trailing slash
					let lastSlashIndex = urlPath.lastIndexOf('/');
					indexEntries.set(urlPath.slice(0, lastSlashIndex), null);
					// With trailing slash; serves the index.html file
					indexEntries.set(urlPath.slice(0, lastSlashIndex + 1), entry.absolutePath);
				}
				break;
			case 'unlink':
				// Remove the file from memory when it is deleted
				staticFiles.delete(urlPath);
				// If the file is an index.html, remove it from the index entries as well
				if (urlPath.endsWith('index.html')) {
					let lastSlashIndex = urlPath.lastIndexOf('/');
					indexEntries.delete(urlPath.slice(0, lastSlashIndex));
					indexEntries.delete(urlPath.slice(0, lastSlashIndex + 1));
				}
				break;
		}
	});

	scope.server.http(
		(req, next) => {
			// TODO: Not sure if the isWebSocket check is still necessary
			if (req.method !== 'GET' || req.isWebSocket) return next(req);

			// Default fallthrough to `true`
			const fallthrough = scope.options.get(['fallthrough']) ?? true;

			if (typeof fallthrough !== 'boolean') {
				throw new Error(`Invalid fallthrough option: ${fallthrough}. Must be a boolean.`);
			}

			// Attempt to retrieve the requested static file from memory
			let staticFile = staticFiles.get(req.pathname);

			// If the file is not found, try matching index
			if (!staticFile) {
				const index = scope.options.get(['index']) ?? true;

				if (typeof index !== 'boolean') {
					throw new Error(`Invalid index option: ${index}. Must be a boolean.`);
				}

				if (index) {
					// Retrieve index entry
					staticFile = indexEntries.get(req.pathname);

					// The router strips both '/assets' and '/assets/' down to '/', so the mount root
					// must be disambiguated via the unstripped pathname (exposed by stripPrefix):
					// redirect the no-slash form so relative links on the index page resolve under
					// the mount (#1583). Query string is preserved across both redirects; compute it
					// lazily inside each branch so the common (non-redirect) index serve stays allocation-free.
					if (staticFile && req.pathname === '/' && baseURLPath !== '/') {
						const originalPathname: string | undefined = (req as any).originalPathname;
						if (originalPathname && !originalPathname.endsWith('/')) {
							const queryIndex = (req.url as string).indexOf('?');
							const query = queryIndex === -1 ? '' : (req.url as string).slice(queryIndex);
							return {
								status: 301,
								headers: {
									Location: baseURLPath + query,
								},
							};
						}
					}

					// If `null`, redirect to trailing slash. req.pathname arrives with the mount
					// prefix stripped, so rebuild the external path for the Location header (#1583)
					if (staticFile === null) {
						const externalPath = baseURLPath === '/' ? req.pathname : baseURLPath.slice(0, -1) + req.pathname;
						const queryIndex = (req.url as string).indexOf('?');
						const query = queryIndex === -1 ? '' : (req.url as string).slice(queryIndex);
						return {
							status: 301,
							headers: {
								Location: externalPath + '/' + query,
							},
						};
					}
				}
			}

			// If the file is still not found, try matching extensions
			if (!staticFile) {
				const extensions = scope.options.get(['extensions']) ?? [];
				if (!Array.isArray(extensions) || extensions.some((ext) => typeof ext !== 'string')) {
					throw new Error(`Invalid extensions option: ${extensions}. Must be an array of strings.`);
				}

				for (const ext of extensions) {
					staticFile = staticFiles.get(`${req.pathname}.${ext}`);
					// break on first match
					if (staticFile) break;
				}
			}

			// If an entry matched, serve it
			if (staticFile) {
				// The benefit to using `send` is that it handles a lot of edge cases and headers for us.
				return {
					handlesHeaders: true,
					body: send(req, realpathSync(staticFile)),
				};
			}

			// If fallthrough is true pass along the request to the next handler
			if (fallthrough) {
				return next(req);
			}

			// Otherwise, handle not found

			const notFound = scope.options.get(['notFound']);

			validateNotFoundOption(notFound);

			if (!notFound) {
				return {
					status: 404,
					body: 'File not found',
				};
			}

			const notFoundPath = join(scope.directory, typeof notFound === 'string' ? notFound : notFound.file);
			const statusCode = typeof notFound === 'object' ? notFound.statusCode : 404;

			if (!existsSync(notFoundPath)) {
				throw new Error(`Not found file does not exist: ${notFoundPath}`);
			}

			return {
				status: statusCode,
				handlesHeaders: true,
				body: send(req, realpathSync(notFoundPath)),
			};
		},
		{
			// `after` (e.g. `after: 'rest'`) must suppress the default pre-authentication hoist —
			// combining the two constraints would be a cycle, which falls back to registration order.
			before:
				before === false ? undefined : ((before as string) ?? (after === undefined ? 'authentication' : undefined)),
			after: after as string | undefined,
		}
	);
}

function validateOrderingOption(
	name: string,
	value: any,
	allowFalse: boolean
): asserts value is undefined | string | false {
	if (value === undefined || (typeof value === 'string' && value.length > 0)) return;
	if (allowFalse && value === false) return;
	throw new Error(
		`Invalid \`${name}\` option: ${value}. Must be the name of another handler${allowFalse ? ', or false to clear the default ordering' : ''}.`
	);
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
