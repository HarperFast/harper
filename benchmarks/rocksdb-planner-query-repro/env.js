'use strict';
// Boots a bare Harper environment (no HTTP server) for in-process table/search access,
// with a *persistent* (not per-PID) db path so repeated CLI invocations reuse loaded data.
// Mirrors unitTests/mocha.init.js's bootstrap, but with a caller-supplied, stable path.
const path = require('node:path');
const fs = require('node:fs');
const env = require('#src/utility/environment/environmentManager');
const terms = require('#src/utility/hdbTerms');

function initEnv(dbPath) {
	fs.mkdirSync(dbPath, { recursive: true });
	env.initSync();
	env.setProperty(terms.HDB_SETTINGS_NAMES.HDB_ROOT_KEY, dbPath);
	env.setProperty(terms.CONFIG_PARAMS.DATABASES, {
		data: { path: dbPath },
		dev: { path: dbPath },
		test: { path: dbPath },
		test2: { path: dbPath },
	});
	if (process.env.HARNESS_STORAGE_ENGINE) {
		// databases.ts / branchDatabase.ts read HARPER_STORAGE_ENGINE directly from process.env
		process.env.HARPER_STORAGE_ENGINE = process.env.HARNESS_STORAGE_ENGINE;
	}
	const { resetDatabases } = require('#src/resources/databases');
	resetDatabases();
}

module.exports = { initEnv };
