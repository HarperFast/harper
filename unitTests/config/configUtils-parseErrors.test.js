'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const commonUtils = require('#src/utility/common_utils');
const configUtils = require('#src/config/configUtils');

const CONFIG_FILE_NAME = 'harperdb-config.yaml';
const CONFIG_ENV_VARS = ['HARPER_DEFAULT_CONFIG', 'HARPER_CONFIG', 'HARPER_SET_CONFIG'];
const BACKFILLED_KEY_PATHS = [['storage', 'path'], ['logging', 'rotation', 'path'], ['authentication'], ['analytics']];

function safeParseError(configFilePath) {
	return (error) => {
		assert.strictEqual(error.statusCode, 500);
		assert.match(error.message, /Error parsing .*YAMLParseError/);
		assert.match(error.message, /Unable to parse the Harper configuration file/);
		assert.ok(error.message.includes(configFilePath), 'names the config file');
		assert.match(error.message, /line \d+, column \d+/, 'locates the parse error');
		assert.ok(!error.message.includes('config-secret-sentinel'), 'does not include config source text');
		assert.ok(!error.stack.includes('config-secret-sentinel'), 'does not include config source text in the stack');
		return true;
	};
}

describe('configUtils initConfig YAML parse errors', function () {
	let originalRootPath;
	let originalConfigEnvVars;
	let rootPath;
	let configFilePath;

	beforeEach(function () {
		originalRootPath = process.env.ROOTPATH;
		originalConfigEnvVars = new Map(CONFIG_ENV_VARS.map((key) => [key, process.env[key]]));
		for (const key of CONFIG_ENV_VARS) delete process.env[key];

		rootPath = fs.mkdtempSync(path.join(os.tmpdir(), 'harper-config-parse-errors-'));
		configFilePath = path.join(rootPath, CONFIG_FILE_NAME);
		const defaultConfigPath = path.join(__dirname, '../../static/defaultConfig.yaml');
		const defaultConfig = fs
			.readFileSync(defaultConfigPath, 'utf8')
			.replace(/^rootPath: null$/m, `rootPath: ${JSON.stringify(rootPath)}`);
		fs.writeFileSync(configFilePath, defaultConfig);
		process.env.ROOTPATH = rootPath;
		commonUtils.resetNoBootFileCache();
	});

	afterEach(function () {
		if (originalRootPath === undefined) delete process.env.ROOTPATH;
		else process.env.ROOTPATH = originalRootPath;
		for (const [key, value] of originalConfigEnvVars) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		commonUtils.resetNoBootFileCache();
		fs.rmSync(rootPath, { recursive: true, force: true });
	});

	it('rejects malformed YAML when no legacy keys need backfilling', function () {
		configUtils.initConfig(true);
		const activeConfig = configUtils.getConfigObj();
		const activeFlatConfig = configUtils.getFlatConfigObj();
		const validConfig = fs.readFileSync(configFilePath, 'utf8');
		fs.writeFileSync(configFilePath, `${validConfig}\ninvalid: ["config-secret-sentinel\n`);
		const malformedConfig = fs.readFileSync(configFilePath, 'utf8');
		const configDoc = configUtils.parseYamlDoc(configFilePath);

		assert.ok(configDoc.errors.length > 0, 'the fixture must contain a YAML parse error');
		for (const keyPath of BACKFILLED_KEY_PATHS) {
			assert.ok(configDoc.hasIn(keyPath), `the fixture must already have ${keyPath.join('.')}`);
		}

		assert.throws(() => configUtils.initConfig(true), safeParseError(configFilePath));

		assert.strictEqual(fs.readFileSync(configFilePath, 'utf8'), malformedConfig, 'does not rewrite malformed YAML');
		assert.strictEqual(configUtils.getConfigObj(), activeConfig, 'keeps the active config object');
		assert.strictEqual(configUtils.getFlatConfigObj(), activeFlatConfig, 'keeps the active flat config');
	});

	it('rejects duplicate YAML keys when no legacy keys need backfilling', function () {
		const validConfig = fs.readFileSync(configFilePath, 'utf8');
		const duplicatedConfig = validConfig.replace('  port: null\n', '  port: null\n  port: null\n');
		assert.notStrictEqual(duplicatedConfig, validConfig, 'the fixture must duplicate a config key');
		fs.writeFileSync(configFilePath, duplicatedConfig);
		const configDoc = configUtils.parseYamlDoc(configFilePath);

		assert.ok(configDoc.errors.some((error) => error.code === 'DUPLICATE_KEY'));
		for (const keyPath of BACKFILLED_KEY_PATHS) {
			assert.ok(configDoc.hasIn(keyPath), `the fixture must already have ${keyPath.join('.')}`);
		}

		assert.throws(() => configUtils.initConfig(true), safeParseError(configFilePath));
		assert.strictEqual(fs.readFileSync(configFilePath, 'utf8'), duplicatedConfig, 'does not rewrite malformed YAML');
	});
});
