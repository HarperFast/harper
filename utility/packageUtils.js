'use strict';
const { join, dirname } = require('node:path');
const { existsSync, readFileSync } = require('node:fs');

/**
 * A naive find-up implementation to find the root package.json, and
 * subsequently the root directory of the package. In theory we could require
 * package.json directly (`require('../../package.json')`), but that would not
 * give us the root directory of the repo, which is needed for other things.
 *
 * The purpose of doing this instead of cobbling together a path directly is
 * that in development mode this file will be resolved from its actual path
 * `/utility/packageUtils.js`, but in production, it will be bundled into the
 * built output and the path will be different. Since builds will not
 * automatically transform a path like that (it will only do so for
 * requires/imports), we need to stick to directory traversal to find the
 * package root.
 *
 * NOTE: This file is intentionally kept as CommonJS (.js) rather than
 * TypeScript. Node v24 type-stripping treats `.ts` files with top-level
 * `import`/`export` as ESM, where `__dirname` is undefined. Keeping this as
 * `.js` lets it stay CJS, retaining `__dirname`, while remaining importable
 * from both CJS and ESM (via Node's CJS interop) consumers.
 */
function findPackageJson() {
	const MAX = 10;
	let dir = __dirname,
		filePath,
		i = 0;
	while (!existsSync((filePath = join(dir, 'package.json')))) {
		if (dir === (dir = dirname(dir)) || i++ > MAX) throw new Error('Could not find package root');
	}
	return filePath;
}

const packageJsonPath = findPackageJson();
const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));

/**
 * The Harper package root directory.
 *
 * Works across dev and prod (built).
 */
const PACKAGE_ROOT = dirname(packageJsonPath);

/**
 * The directory that holds source files at runtime: `PACKAGE_ROOT` in
 * type-strip mode (where `node bin/harper.ts` runs the .ts sources directly)
 * and `PACKAGE_ROOT/dist` in dist mode (where transpiled .js files live).
 *
 * `__dirname` of this CJS file resolves to either `<PACKAGE_ROOT>/utility`
 * (source) or `<PACKAGE_ROOT>/dist/utility` (dist), so we can detect the mode
 * just by looking at this file's own location.
 */
const RUNTIME_SRC_ROOT = __dirname.startsWith(join(PACKAGE_ROOT, 'dist')) ? join(PACKAGE_ROOT, 'dist') : PACKAGE_ROOT;

/**
 * File extension of the running modules: `.ts` in type-strip mode, `.js` in
 * dist mode. Use this when constructing file paths for `new Worker(...)` or
 * similar APIs that need the on-disk filename.
 */
const RUNTIME_FILE_EXT = RUNTIME_SRC_ROOT === PACKAGE_ROOT ? '.ts' : '.js';

module.exports = { packageJson, PACKAGE_ROOT, RUNTIME_SRC_ROOT, RUNTIME_FILE_EXT };
