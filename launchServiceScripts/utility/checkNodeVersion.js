'use strict';

const semver_major = require('semver/functions/major');
const semver_satisfies = require('semver/functions/satisfies');

const jsonData = require('../../package.json');
const INSTALLED_NODE_VERSION = process.versions && process.versions.node ? process.versions.node : undefined;

module.exports = checkNodeVersion;

function checkNodeVersion() {
	const node_version = jsonData.engines.node;

	const preferred_hdb_node_version = jsonData.engines['preferred-node'];
	if (INSTALLED_NODE_VERSION) {
		if (node_version && !semver_satisfies(INSTALLED_NODE_VERSION, node_version)) {
			const version_error = `This version of HarperDB supports Node.js versions: ${node_version}, the currently installed Node.js version is: ${INSTALLED_NODE_VERSION}. Please install a version of Node.js that is withing the defined range.`;
			return {error: version_error};
		}

		if (preferred_hdb_node_version && semver_major(INSTALLED_NODE_VERSION) !== semver_major(preferred_hdb_node_version)) {
			const version_error = `This version of HarperDB is tested against Node.js version ${preferred_hdb_node_version}, the currently installed Node.js version is: ${INSTALLED_NODE_VERSION}. Some issues may occur with untested versions of Node.js.`;
			return {warn: version_error};
		}
	}
}
