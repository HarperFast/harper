'use strict';

const semver = require('semver');
const { packageJson } = require('../../utility/packageUtils.js');
const INSTALLED_NODE_VERSION = process.versions && process.versions.node ? process.versions.node : undefined;

module.exports = checkNodeVersion;

function checkNodeVersion() {
	// Skip Node version check when running on Bun
	if (typeof globalThis.Bun !== 'undefined') return;
	const requiredRange = packageJson.engines.node;
	if (INSTALLED_NODE_VERSION && !semver.satisfies(INSTALLED_NODE_VERSION, requiredRange)) {
		const versionError = `Harper requires Node.js ${requiredRange}, but the currently installed version is ${INSTALLED_NODE_VERSION}. Please install a compatible version.`;
		return { error: versionError };
	}
}
