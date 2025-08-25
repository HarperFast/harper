'use strict';

const semverMajor = require('semver/functions/major');
const { packageJson } = require('../../utility/packageUtils.js');
const INSTALLED_NODE_VERSION = process.versions && process.versions.node ? process.versions.node : undefined;

module.exports = checkNodeVersion;

function checkNodeVersion() {
	const minimumHdbNodeVersion = packageJson.engines['minimum-node'];
	if (INSTALLED_NODE_VERSION && semverMajor(INSTALLED_NODE_VERSION) < semverMajor(minimumHdbNodeVersion)) {
		const versionError = `The minimum version of Node.js HarperDB supports is: ${minimumHdbNodeVersion}, the currently installed Node.js version is: ${INSTALLED_NODE_VERSION}. Please install a version of Node.js that is withing the defined range.`;
		return { error: versionError };
	}
}
