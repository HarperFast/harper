'use strict';

module.exports = {
	version,
	printVersion,
};

let jsonData = require('../package.json');

function version() {
	if (jsonData) {
		return jsonData.version;
	}
}

function printVersion() {
	if (jsonData) {
		console.log(`HarperDB Version ${jsonData.version}`);
	}
}
