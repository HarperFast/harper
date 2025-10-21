import { realpathSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Scope } from '../components/Scope';
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
	scope.options.on('change', (key, value) => {
		if (key[0] === 'files' || key[0] === 'urlPath') {
			// If the files or urlPath options change, we need to reinitialize the static files map
			staticFiles.clear();
			indexEntries.clear();
			scope.logger.info(`Static files reinitialized due to change in ${key.join('.')}`);
			return;
		}
	});

	// Handle entry events for the default entry handler based on the `files` and `urlPath` options
	scope.handleEntry((entry) => {
		switch (entry.eventType) {
			// Directories only matter for the `index` files
			case 'addDir':
			case 'unlinkDir':
				// Handle `index.html` for directories for if/when the user enables the `index` option
				const indexPath = join(entry.absolutePath, 'index.html');
				if (existsSync(indexPath)) {
					indexEntries[entry.eventType === 'addDir' ? 'set' : 'delete'](entry.urlPath, indexPath);
				}
				break;
			// Otherwise, user must specify pattern to match individual files
			case 'add':
				// Store the file in memory for serving
				staticFiles.set(entry.urlPath, entry.absolutePath);
				// If the file is an index.html, also store it in the index entries
				if (entry.urlPath.endsWith('index.html')) {
					indexEntries.set(dirname(entry.urlPath), entry.absolutePath);
				}
				break;
			case 'unlink':
				// Remove the file from memory when it is deleted
				staticFiles.delete(entry.urlPath);
				// If the file is an index.html, remove it from the index entries as well
				if (entry.urlPath.endsWith('index.html')) {
					indexEntries.delete(dirname(entry.urlPath));
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
					staticFile = indexEntries.get(req.pathname);
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
		{ runFirst: true }
	);
}

export const suppressHandleApplicationWarning = true;

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
