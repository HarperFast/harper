'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const YAML = require('yaml');
const commonUtils = require('#src/utility/common_utils');
const configUtils = require('#src/config/configUtils');
const env = require('#src/utility/environment/environmentManager');

const CONFIG_FILE_NAME = 'harperdb-config.yaml';
const SAVED_ENV_VARS = [
	'ROOTPATH',
	'HARPER_BUILTIN_COMPONENTS',
	'HARPER_DEFAULT_CONFIG',
	'HARPER_CONFIG',
	'HARPER_SET_CONFIG',
];
const WAF_LEAVES = { enabled: true, region: 'us-east-1', nodeTags: ['edge', 'primary'] };

describe('built-in component backfill after HARPER_DEFAULT_CONFIG leaves', function () {
	let savedEnv;
	let rootPath;
	let configFilePath;

	// bin/run.ts: env.initSync() reads the config at module load, ensureBuiltInComponentConfigKeys() runs in initialize()
	function boot() {
		configUtils.initConfig(true);
		const memoizedBeforeBackfill = structuredClone(configUtils.getConfigObj().waf);
		return { memoizedBeforeBackfill, backfilled: configUtils.ensureBuiltInComponentConfigKeys() };
	}

	function onDiskWaf() {
		return YAML.parse(fs.readFileSync(configFilePath, 'utf8')).waf;
	}

	function assertWafLeavesEverywhere() {
		assert.deepStrictEqual(onDiskWaf(), WAF_LEAVES, 'config file');
		assert.deepStrictEqual(configUtils.getConfigObj().waf, WAF_LEAVES, 'config tree the component loader reads');
		const flat = configUtils.getFlatConfigObj();
		assert.strictEqual(flat.waf_enabled, true);
		assert.strictEqual(flat.waf_region, 'us-east-1');
		assert.deepStrictEqual(flat.waf_nodetags, ['edge', 'primary']);
	}

	function writeUpgradedConfig(extraYaml = '') {
		const defaultConfig = fs
			.readFileSync(path.join(__dirname, '../../static/defaultConfig.yaml'), 'utf8')
			.replace(/^rootPath: null$/m, `rootPath: ${JSON.stringify(rootPath)}`);
		fs.writeFileSync(configFilePath, defaultConfig + extraYaml);
	}

	beforeEach(function () {
		savedEnv = new Map(SAVED_ENV_VARS.map((name) => [name, process.env[name]]));
		rootPath = fs.mkdtempSync(path.join(os.tmpdir(), 'harper-builtin-backfill-'));
		configFilePath = path.join(rootPath, CONFIG_FILE_NAME);
		for (const name of ['HARPER_DEFAULT_CONFIG', 'HARPER_CONFIG', 'HARPER_SET_CONFIG']) delete process.env[name];
		process.env.ROOTPATH = rootPath;
		process.env.HARPER_BUILTIN_COMPONENTS = 'waf=@/dist/waf/waf.js';
		commonUtils.resetNoBootFileCache();
	});

	afterEach(function () {
		for (const [name, value] of savedEnv) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
		commonUtils.resetNoBootFileCache();
		env.initSync(true);
		fs.rmSync(rootPath, { recursive: true, force: true });
	});

	it('leaves env-supplied leaves in place on an upgraded config that has no waf key', function () {
		writeUpgradedConfig();
		assert.ok(
			!configUtils.parseYamlDoc(configFilePath).hasIn(['waf']),
			'the fixture must be an upgraded config without waf'
		);
		process.env.HARPER_DEFAULT_CONFIG = JSON.stringify({ waf: WAF_LEAVES });

		const { memoizedBeforeBackfill, backfilled } = boot();

		assert.deepStrictEqual(
			memoizedBeforeBackfill,
			WAF_LEAVES,
			'the env layer must populate the key before the backfill runs'
		);
		assert.deepStrictEqual(backfilled, [], 'nothing is left for the backfill to add');
		assertWafLeavesEverywhere();
	});

	it('keeps them across a restart, which reasserts the env layer onto the persisted values', function () {
		writeUpgradedConfig();
		process.env.HARPER_DEFAULT_CONFIG = JSON.stringify({ waf: WAF_LEAVES });

		boot();
		const restarted = boot();

		assert.deepStrictEqual(restarted.memoizedBeforeBackfill, WAF_LEAVES);
		assert.deepStrictEqual(restarted.backfilled, []);
		assertWafLeavesEverywhere();
	});

	it('fills env-supplied leaves under an empty waf block that an earlier boot backfilled', function () {
		writeUpgradedConfig('waf: {}\n');
		process.env.HARPER_DEFAULT_CONFIG = JSON.stringify({ waf: WAF_LEAVES });

		const { memoizedBeforeBackfill, backfilled } = boot();

		assert.deepStrictEqual(memoizedBeforeBackfill, WAF_LEAVES);
		assert.deepStrictEqual(backfilled, []);
		assertWafLeavesEverywhere();
	});

	it('still backfills an empty waf block when no env layer supplies one', function () {
		writeUpgradedConfig();

		const { memoizedBeforeBackfill, backfilled } = boot();

		assert.strictEqual(memoizedBeforeBackfill, undefined);
		assert.deepStrictEqual(backfilled, ['waf']);
		assert.deepStrictEqual(onDiskWaf(), {});
		assert.deepStrictEqual(configUtils.getConfigObj().waf, {});
	});
});
