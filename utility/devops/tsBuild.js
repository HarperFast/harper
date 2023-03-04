const fg = require('fast-glob');
const { statSync, existsSync } = require('fs');
const { execSync, execFileSync, spawnSync } = require('child_process');
const { isMainThread } = require('worker_threads');
const { join, relative } = require('path');
const { PACKAGE_ROOT } = require('../hdbTerms');
const SRC_DIRECTORIES = ['resources', 'server'];
const TS_DIRECTORY = 'ts-build';
let needs_compile;
if (isMainThread) {
	/**
	 * Check to see if any TypeScript files need to be recompiled
	 */
	for (let filename of fg.sync(
		SRC_DIRECTORIES.map((dir) => dir + '/**/*.ts'),
		{ cwd: PACKAGE_ROOT }
	)) {
		if (
			statSync(join(PACKAGE_ROOT, filename)).mtimeMs >
			statSync(join(PACKAGE_ROOT, TS_DIRECTORY, filename.replace(/.ts$/, '.js'))).mtimeMs
		) {
			console.warn(
				`TypeScript ${filename} is not compiled (consider enabling auto-compilation of TypeScript in your IDE). Compiling now`
			);
			needs_compile = true;
			break;
		}
	}
	if (needs_compile) {
		// if we need it, run typescript compiler
		let result = spawnSync(process.argv[0], [join(PACKAGE_ROOT, 'node_modules/.bin/tsc')], { cwd: PACKAGE_ROOT });
		if (result.stdout.length) console.log(result.stdout.toString());
		if (result.stderr.length) console.log(result.stderr.toString());
	}
}

let Module = module.constructor;
let findPath = Module._findPath;
/**
 * Hack the node module system to make it so we can load the TypeScript compiled modules from a separate directory
 * *and* load JavaScript files from their existing source directory. This is just intended for source/dev use, and
 * should be skipped in our built version. But this allows us to keep TypeScript alongside JavaScript while having
 * the built output in separate directory so we can easily gitignore all the built modules.
 */
Module._findPath = function (request, paths, isMain) {
	if (
		request.startsWith('.') &&
		!isMain &&
		paths.length === 1 &&
		paths[0].startsWith(PACKAGE_ROOT) &&
		!paths[0].includes('node_modules')
	) {
		// relative reference in our code base
		let path = relative(PACKAGE_ROOT, paths[0]);
		let alternate;
		if (path.startsWith(TS_DIRECTORY)) {
			alternate = join(PACKAGE_ROOT, relative(TS_DIRECTORY, path));
		} else {
			alternate = join(PACKAGE_ROOT, TS_DIRECTORY, path);
		}
		let filename = join(alternate, request) + '.js';
		if (existsSync(filename)) return filename;
	}
	return findPath(request, paths, isMain);
};
