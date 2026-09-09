'use strict';
// Boots a bare Harper environment (no HTTP server) for in-process table access, against a
// persistent (not per-PID) db path so repeated process invocations reuse the same on-disk data.
// Adapted from benchmarks/rocksdb-planner-query-repro/env.js (rocksdb-planner-repro-rig branch).
const fs = require('node:fs');
const env = require('#src/utility/environment/environmentManager');
const terms = require('#src/utility/hdbTerms');

function initEnv(dbPath, database) {
	fs.mkdirSync(dbPath, { recursive: true });
	env.initSync();
	env.setProperty(terms.HDB_SETTINGS_NAMES.HDB_ROOT_KEY, dbPath);
	env.setProperty(terms.CONFIG_PARAMS.DATABASES, { [database]: { path: dbPath } });
	if (process.env.HARNESS_STORAGE_ENGINE) {
		process.env.HARPER_STORAGE_ENGINE = process.env.HARNESS_STORAGE_ENGINE;
	}
	const { resetDatabases } = require('#src/resources/databases');
	resetDatabases();
}

module.exports = { initEnv };
