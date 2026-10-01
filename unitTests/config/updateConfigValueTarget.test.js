'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const YAML = require('yaml');

const testUtils = require('../testUtils.js');
testUtils.preTestPrep();

const { getConfigFilePath, getConfigValue, updateConfigObject, updateConfigValue } = require('#src/config/configUtils');
const { CONFIG_PARAM_MAP } = require('#src/utility/hdbTerms');
const { HOME_ENV_KEYS } = require('../bootPropsFixture.js');
const { preserveRootConfig, readRootConfig } = require('../rootConfigFixture.js');

describe('updateConfigValue', () => {
	preserveRootConfig();
	let elsewhere;

	beforeEach(() => {
		elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'update-config-elsewhere-'));
		for (const dir of ['database', 'log', 'components']) fs.mkdirSync(path.join(elsewhere, dir));
	});

	afterEach(() => {
		fs.rmSync(elsewhere, { recursive: true, force: true });
	});

	it('writes the file boot reads, even when the document names another rootPath', () => {
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

	function withBootSource(rootPath, body) {
		const saved = ['ROOTPATH', ...HOME_ENV_KEYS].map((key) => [key, process.env[key]]);
		if (rootPath === undefined) delete process.env.ROOTPATH;
		else process.env.ROOTPATH = rootPath;
		for (const key of HOME_ENV_KEYS) process.env[key] = elsewhere;
		try {
			return body();
		} finally {
			for (const [key, value] of saved) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		}
	}

	it('fails rather than writing another copy when the file boot reads is missing', () => {
		const before = fs.readFileSync(getConfigFilePath(), 'utf8');

		// Boot would read `<elsewhere>/harper-config.yaml`, which does not exist, while the copy under the configured
		// rootPath does: rewriting that copy would report success for a change the next boot never sees.
		assert.throws(() => withBootSource(elsewhere, () => updateConfigValue('logging_level', 'fatal')), /ENOENT/);

		assert.strictEqual(fs.readFileSync(getConfigFilePath(), 'utf8'), before, 'the other copy was not rewritten');
	});

	it('writes the copy under the configured rootPath when there is no boot source at all, as during an install', () => {
		const bootConfig = fs.readFileSync(getConfigFilePath(), 'utf8');
		const installConfigPath = path.join(elsewhere, 'harper-config.yaml');
		const doc = YAML.parseDocument(bootConfig);
		doc.setIn(['rootPath'], elsewhere);
		fs.writeFileSync(installConfigPath, String(doc));
		const configuredRoot = getConfigValue(CONFIG_PARAM_MAP.hdb_root);
		updateConfigObject(CONFIG_PARAM_MAP.hdb_root, elsewhere);
		try {
			withBootSource(undefined, () => updateConfigValue('logging_level', 'fatal'));
		} finally {
			updateConfigObject(CONFIG_PARAM_MAP.hdb_root, configuredRoot);
		}

		assert.strictEqual(YAML.parse(fs.readFileSync(installConfigPath, 'utf8')).logging?.level, 'fatal');
		assert.strictEqual(fs.readFileSync(getConfigFilePath(), 'utf8'), bootConfig, 'the per-PID copy is untouched');
	});
});
