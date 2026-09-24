'use strict';

/**
 * Read and seed the root config an activation publishes into.
 *
 * A unit run has ONE root config, the per-PID `harper-config.yaml` mocha.init.js materializes, and a deploy's
 * root-config entry is an effect of its activation (#2315 step 3). So a suite that activates a package build,
 * or seeds an entry to watch one change, is writing to a file every later suite in the run reads. Each test
 * that does puts the file back with `preserveRootConfig()`. Reads go to the file itself rather than
 * `getConfigObj()`, which `testUtils.preTestPrep()` keeps from refreshing.
 */

const { readFileSync, writeFileSync } = require('node:fs');
const YAML = require('yaml');
const { getConfigFilePath } = require('#src/config/configUtils');

function readRootConfig() {
	return YAML.parse(readFileSync(getConfigFilePath(), 'utf8')) ?? {};
}

function rootConfigEntry(name) {
	return readRootConfig()[name];
}

function setRootConfigEntry(name, entry) {
	const doc = YAML.parseDocument(readFileSync(getConfigFilePath(), 'utf8'));
	doc.setIn([name], entry);
	writeFileSync(getConfigFilePath(), String(doc));
}

/** Register hooks, inside a `describe`, that put the root config back as each test found it. */
function preserveRootConfig() {
	let saved;
	beforeEach(() => {
		saved = readFileSync(getConfigFilePath(), 'utf8');
	});
	afterEach(() => {
		writeFileSync(getConfigFilePath(), saved);
	});
}

module.exports = { readRootConfig, rootConfigEntry, setRootConfigEntry, preserveRootConfig };
