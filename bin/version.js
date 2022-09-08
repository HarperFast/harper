'use strict';

let fs = require('fs-extra');
const logger = require('../utility/logging/harper_logger');

module.exports = {
	version,
	printVersion,
	nodeVersion,
};

let jsonData = require('../package.json');

function version() {
	if (jsonData) {
		return jsonData.version;
	}
}

function nodeVersion() {
	if (jsonData && jsonData.engines && jsonData.engines['preferred-node']) {
		return jsonData.engines['preferred-node'];
	}

	return undefined;
}

function printVersion() {
	if (jsonData) {
		console.log(`HarperDB Version ${jsonData.version}`);
	}
}
