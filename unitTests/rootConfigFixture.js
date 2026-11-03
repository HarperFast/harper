'use strict';

/**
 * A unit run has ONE root config, the per-PID `harper-config.yaml` mocha.init.js materializes, and every later
 * suite in the run reads it — so a test that activates a package build or seeds an entry puts the file back with
 * `preserveRootConfig()`. Reads go to the file itself rather than `getConfigObj()`, which
 * `testUtils.preTestPrep()` keeps from refreshing.
 */

const { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const YAML = require('yaml');
const { getConfigFilePath } = require('#src/config/configUtils');
const env = require('#src/utility/environment/environmentManager');
const { CONFIG_PARAMS } = require('#src/utility/hdbTerms');

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

/**
 * Register hooks, inside a `describe`, that remove every application its tests deployed into the run's one
 * components root. A later suite that loads that root would otherwise load them too, with the default config's
 * `rest: true` claiming REST's root mount for the rest of the run.
 */
function removeDeployedComponents() {
	const visibleEntries = () => {
		const root = env.get(CONFIG_PARAMS.COMPONENTSROOT);
		return existsSync(root) ? readdirSync(root).filter((name) => !name.startsWith('.')) : [];
	};
	let existing;
	before(() => {
		existing = new Set(visibleEntries());
	});
	after(() => {
		for (const name of visibleEntries()) {
			if (!existing.has(name)) {
				rmSync(join(env.get(CONFIG_PARAMS.COMPONENTSROOT), name), { recursive: true, force: true, maxRetries: 5 });
			}
		}
	});
}

module.exports = { readRootConfig, rootConfigEntry, setRootConfigEntry, preserveRootConfig, removeDeployedComponents };
