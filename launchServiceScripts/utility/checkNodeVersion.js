'use strict';

const semver_major = require('semver/functions/major');
const { packageJson } = require('../../utility/packageUtils');
const INSTALLED_NODE_VERSION = process.versions && process.versions.node ? process.versions.node : undefined;

module.exports = checkNodeVersion;

function checkNodeVersion() {
	const minimum_hdb_node_version = packageJson.engines['minimum-node'];
	if (INSTALLED_NODE_VERSION && semver_major(INSTALLED_NODE_VERSION) < semver_major(minimum_hdb_node_version)) {
		const version_error = `The minimum version of Node.js HarperDB supports is: ${minimum_hdb_node_version}, the currently installed Node.js version is: ${INSTALLED_NODE_VERSION}. Please install a version of Node.js that is withing the defined range.`;
		return { error: version_error };
	}
}
