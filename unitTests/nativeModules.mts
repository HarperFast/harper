import { createRequire } from 'node:module';
import { dirname, join, sep } from 'node:path';
import { realpathSync } from 'node:fs';

const require = createRequire(import.meta.url);

export function nativeCoreGuard(databasePath: string) {
	const root = dirname(dirname(databasePath));
	const roots = databasePath.endsWith('.ts') ? [...new Set([root, realpathSync(root)])] : [];
	const distPaths = roots.map((path) => join(path, 'dist') + sep);
	const reported = new Set<string>();
	return () => {
		const paths = Object.keys(require.cache).filter(
			(file) => !reported.has(file) && distPaths.some((dist) => file.startsWith(dist))
		);
		for (const file of paths) reported.add(file);
		if (paths.length) throw new Error(`Native unit tests loaded compiled core: ${paths.join(', ')}`);
	};
}
