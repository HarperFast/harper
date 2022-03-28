'use strict';

const semver_neq = require('semver/functions/neq');
const fs = require('fs');

const jsonData = JSON.parse(fs.readFileSync(`${__dirname}/../../package.json`, 'utf-8'));

module.exports = checkNodeVersion;

function checkNodeVersion() {
	const current_hdb_node_version = jsonData.engines.node;
	if (
		process.versions &&
		process.versions.node &&
		current_hdb_node_version &&
		semver_neq(process.versions.node, current_hdb_node_version)
	) {
		const version_error = `This version of HarperDB is designed to run on Node ${current_hdb_node_version}, the currently installed Node.js version is: ${process.versions.node}.  Please change to version of Node.js ${current_hdb_node_version} to proceed.`;
		return { error: version_error };
	}
}
