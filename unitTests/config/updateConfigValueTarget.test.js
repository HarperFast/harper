'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const YAML = require('yaml');

const testUtils = require('../testUtils.js');
testUtils.preTestPrep();

const { getConfigFilePath, updateConfigValue } = require('#src/config/configUtils');
const { preserveRootConfig, readRootConfig } = require('../rootConfigFixture.js');

describe('updateConfigValue', () => {
	preserveRootConfig();
	let elsewhere;

	beforeEach(() => {
		elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'update-config-elsewhere-'));
		// Config validation requires the paths the document resolves against its rootPath to exist.
		for (const dir of ['database', 'log', 'components']) fs.mkdirSync(path.join(elsewhere, dir));
	});

	afterEach(() => {
		fs.rmSync(elsewhere, { recursive: true, force: true });
	});

	it('writes the file boot reads, even when the document names another rootPath', () => {
		// A layout whose config file is not at `<rootPath>/harper-config.yaml`, which is also what a
		// `set_configuration` of `rootPath` produces for every write after it.
		const doc = YAML.parseDocument(fs.readFileSync(getConfigFilePath(), 'utf8'));
		doc.setIn(['rootPath'], elsewhere);
		fs.writeFileSync(getConfigFilePath(), String(doc));

		updateConfigValue('logging_level', 'fatal');

		assert.strictEqual(readRootConfig().logging?.level, 'fatal', 'the change is in the file boot reads');
		assert.strictEqual(
			fs.existsSync(path.join(elsewhere, 'harper-config.yaml')),
			false,
			'and no config file was written under the other rootPath'
		);
	});
});
