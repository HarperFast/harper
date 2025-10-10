const { join, dirname } = require('node:path');
const { existsSync, readFileSync } = require('node:fs');

/**
 * A naive find-up implementation to find the root package.json, and
 * subsequently the root directory of the package. In theory we could require
 * package.json directly (`require('../../package.json')`), but that would not
 * give us the root directory of the repo, which is needed for other things.
 * Furthermore, when this is eventually converted to TS, we should consider
 * using `import('../../package.json')` as that will give type-safe access to
 * the package.json file.
 *
 * The purpose of doing this instead of cobbling together a path directly is
 * that in development mode this file will be resolved from its actual path
 * `/utility/packageUtils.js`, but in production, it will be bundled into the
 * built output and the path will be different. Since builds will not
 * automatically transform a path like that (it will only do so for
 * requires/imports), we need to stick to directory traversal to find the
 * package root.
 *
 * This function isn't full-proof and could fail in some edge cases. The max
 * iteration check is in place to prevent infinite loops.
 *
 * If we ever encounter this error, we should improve the function to handle
 * the edge case instead of just increasing the `MAX` value.
 *
 * @returns {string} package.json file path
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
 * The HarperDB package root directory.
 *
 * Works across dev and prod (built).
 *
 * @type {string}
 */
const PACKAGE_ROOT = dirname(packageJsonPath);

module.exports = {
	packageJson,
	PACKAGE_ROOT,
};
