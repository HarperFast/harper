import { registerHooks, createRequire } from 'node:module';
import { dirname, join, sep } from 'node:path';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);

export function trackNativeDatabases(databasePath: string) {
	let loaded = false;
	if (databasePath.endsWith('.ts')) {
		const root = dirname(dirname(databasePath));
		const roots = [...new Set([root, realpathSync(root)])];
		const databaseURLs = new Set([databasePath, realpathSync(databasePath)].map((file) => pathToFileURL(file).href));
		const distURLs = roots.map((path) => pathToFileURL(join(path, 'dist') + sep).href);
		const distPaths = roots.map((path) => join(path, 'dist') + sep);
		if (Object.keys(require.cache).some((file) => distPaths.some((dist) => file.startsWith(dist))))
			throw new Error('Native unit tests cannot load this repository’s compiled dist tree.');
		registerHooks({
			load(url, context, nextLoad) {
				if (distURLs.some((dist) => url.startsWith(dist)))
					throw new Error(`Native unit tests cannot load compiled core: ${url}`);
				const result = nextLoad(url, context);
				if (databaseURLs.has(url)) loaded = true;
				return result;
			},
		});
	}
	return () => loaded;
}
