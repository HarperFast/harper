const path = require('node:path');
const fs = require('node:fs');

/**
 * Finds and returns the package root directory
 */
function getHDBPackageRoot() {
	let dir = __dirname;
	while (!fs.existsSync(path.join(dir, 'package.json'))) {
		const parent = path.dirname(dir);
		if (parent === dir) throw new Error('Could not find package root');
		dir = parent;
	}
	return dir;
}

const PACKAGE_ROOT = getHDBPackageRoot();

module.exports = {
	PACKAGE_ROOT
}