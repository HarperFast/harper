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

	/** Run `body` with the process's boot source replaced, restoring it before returning. */
	function withBootSource({ rootPath, home }, body) {
		const saved = { ROOTPATH: process.env.ROOTPATH, HOME: process.env.HOME };
		const set = (name, value) => (value === undefined ? delete process.env[name] : (process.env[name] = value));
		set('ROOTPATH', rootPath);
		set('HOME', home);
		try {
			return body();
		} finally {
			set('ROOTPATH', saved.ROOTPATH);
			set('HOME', saved.HOME);
		}
	}

	it('fails rather than writing another copy when the file boot reads is missing', () => {
		const before = fs.readFileSync(getConfigFilePath(), 'utf8');

		// Boot would read `<elsewhere>/harper-config.yaml`, which does not exist, while the copy under the cached
		// rootPath does: rewriting that copy would report success for a change the next boot never sees.
		assert.throws(
			() =>
				withBootSource({ rootPath: elsewhere, home: process.env.HOME }, () =>
					updateConfigValue('logging_level', 'fatal')
				),
			/ENOENT/
		);

		assert.strictEqual(fs.readFileSync(getConfigFilePath(), 'utf8'), before, 'the other copy was not rewritten');
	});

	it('falls back to the rootPath the document names when there is no boot source at all, as during an install', () => {
		// No ROOTPATH and no boot props file: the state an install is in before it writes the boot props.
		withBootSource({ rootPath: undefined, home: elsewhere }, () => updateConfigValue('logging_level', 'fatal'));

		assert.strictEqual(readRootConfig().logging?.level, 'fatal');
	});
});
