'use strict';

const assert = require('node:assert/strict');
const rewire = require('rewire');
const fs = require('fs-extra');
const path = require('node:path');
const os = require('node:os');

const harperConfigEnvVars = rewire('../../config/harperConfigEnvVars.ts');
const applyRuntimeEnvConfig = harperConfigEnvVars.__get__('applyRuntimeEnvConfig');

describe('HARPER_DEFAULT_CONFIG - true defaults behavior', function () {
	let testRoot;
	let originalEnv;

	beforeEach(function () {
		// Save original env var
		originalEnv = process.env.HARPER_DEFAULT_CONFIG;

		// Create unique test directory
		testRoot = path.join(os.tmpdir(), 'hdb-defaults-test-' + Date.now());
		fs.mkdirpSync(testRoot);
		fs.mkdirpSync(path.join(testRoot, 'backup'));
	});

	afterEach(function () {
		// Restore original env var
		if (originalEnv !== undefined) {
			process.env.HARPER_DEFAULT_CONFIG = originalEnv;
		} else {
			delete process.env.HARPER_DEFAULT_CONFIG;
		}

		// Cleanup test directory
		try {
			fs.removeSync(testRoot);
			// eslint-disable-next-line sonarjs/no-ignored-exceptions
		} catch (err) {
			// Ignore cleanup errors
		}
	});

	it('should NOT override existing config values at runtime (config file priority)', function () {
		process.env.HARPER_DEFAULT_CONFIG = JSON.stringify({
			http: {
				mtls: true,
				port: 9999,
			},
		});

		// Simulate existing config file with different values
		const fileConfig = {
			http: {
				mtls: false, // Should NOT be overridden at runtime
				port: 9925, // Should NOT be overridden at runtime
			},
			logging: {
				level: 'error',
			},
		};

		const result = applyRuntimeEnvConfig(fileConfig, testRoot);

		// Config file takes priority at runtime (not overridden)
		assert.strictEqual(result.http.mtls, false, 'Config file should take priority at runtime');
		assert.strictEqual(result.http.port, 9925, 'Config file should take priority at runtime');
	});

	it('should SET values that do not exist in config', function () {
		process.env.HARPER_DEFAULT_CONFIG = JSON.stringify({
			http: {
				corsAccessList: ['*.example.com'],
			},
			newSetting: 'test-value',
		});

		const fileConfig = {
			http: {
				port: 9925,
			},
			logging: {
				level: 'error',
			},
		};

		const result = applyRuntimeEnvConfig(fileConfig, testRoot);

		// New values should be added
		assert.deepStrictEqual(result.http.corsAccessList, ['*.example.com']);
		assert.strictEqual(result.newSetting, 'test-value');

		// Existing values should not be touched
		assert.strictEqual(result.http.port, 9925);
	});

	it('should UPDATE values it previously set (on subsequent runs)', function () {
		process.env.HARPER_DEFAULT_CONFIG = JSON.stringify({
			http: {
				port: 9999,
			},
		});

		// Simulate config with value NOT set yet
		const fileConfig = {
			logging: {
				level: 'error',
			},
		};

		// First run - HARPER_DEFAULT_CONFIG sets http.port
		applyRuntimeEnvConfig(fileConfig, testRoot);
		assert.strictEqual(fileConfig.http.port, 9999, 'First run should set the value');

		// Second run - HARPER_DEFAULT_CONFIG changes http.port
		process.env.HARPER_DEFAULT_CONFIG = JSON.stringify({
			http: {
				port: 8888, // Changed value
			},
		});

		applyRuntimeEnvConfig(fileConfig, testRoot);
		assert.strictEqual(fileConfig.http.port, 8888, 'Second run should update value it previously set');
	});

	it('should NOT override value if user edited it after HARPER_DEFAULT_CONFIG set it', function () {
		process.env.HARPER_DEFAULT_CONFIG = JSON.stringify({
			http: {
				port: 9999,
			},
		});

		// Simulate config with value NOT set yet
		const fileConfig = {
			logging: {
				level: 'error',
			},
		};

		// First run - HARPER_DEFAULT_CONFIG sets http.port
		applyRuntimeEnvConfig(fileConfig, testRoot);
		assert.strictEqual(fileConfig.http.port, 9999);

		// User manually edits the file (simulated by changing value and state file)
		fileConfig.http.port = 7777;

		// Load state and mark as user edit
		const statePath = path.join(testRoot, 'backup', '.harper-config-state.json');
		const state = fs.readJsonSync(statePath);
		state.sources['http.port'] = 'user';
		fs.writeJsonSync(statePath, state);

		// Second run - HARPER_DEFAULT_CONFIG should NOT override user edit
		applyRuntimeEnvConfig(fileConfig, testRoot);
		assert.strictEqual(fileConfig.http.port, 7777, 'Should not override user edits');
	});

	it('should UPDATE value set during install when env var changes at runtime', function () {
		process.env.HARPER_DEFAULT_CONFIG = JSON.stringify({
			http: {
				foo: true,
			},
		});

		// Simulate install - apply with isInstall flag
		const fileConfig = {
			logging: {
				level: 'error',
			},
		};
		applyRuntimeEnvConfig(fileConfig, testRoot, { isInstall: true });
		assert.strictEqual(fileConfig.http.foo, true, 'Install should set http.foo to true');

		// Simulate runtime with DIFFERENT env var value
		process.env.HARPER_DEFAULT_CONFIG = JSON.stringify({
			http: {
				foo: false, // Changed from true to false
			},
		});

		applyRuntimeEnvConfig(fileConfig, testRoot);
		assert.strictEqual(fileConfig.http.foo, false, 'Runtime should update value that was set during install');
	});

	it('should restore original value when key removed from HARPER_DEFAULT_CONFIG', function () {
		// Install - set logging.level to debug (overriding template default 'info')
		process.env.HARPER_DEFAULT_CONFIG = JSON.stringify({
			logging: {
				level: 'debug',
			},
		});

		const fileConfig = {
			logging: {
				level: 'info', // Template default value
			},
		};

		applyRuntimeEnvConfig(fileConfig, testRoot, { isInstall: true });
		assert.strictEqual(fileConfig.logging.level, 'debug', 'Install should override to debug');

		// Runtime - remove logging.level from env var
		process.env.HARPER_DEFAULT_CONFIG = JSON.stringify({});

		applyRuntimeEnvConfig(fileConfig, testRoot);
		assert.strictEqual(fileConfig.logging.level, 'info', 'Should restore original value (info)');
	});

	it('should DELETE new keys when removed from HARPER_DEFAULT_CONFIG (no original value)', function () {
		// First run - add a NEW key that doesn't exist in config
		process.env.HARPER_DEFAULT_CONFIG = JSON.stringify({
			http: {
				newKey: 'newValue',
			},
		});

		const fileConfig = {
			http: {
				port: 9925,
			},
			logging: {
				level: 'error',
			},
		};

		applyRuntimeEnvConfig(fileConfig, testRoot);
		assert.strictEqual(fileConfig.http.newKey, 'newValue', 'Should add new key');

		// Second run - remove the new key from env var
		process.env.HARPER_DEFAULT_CONFIG = JSON.stringify({});

		applyRuntimeEnvConfig(fileConfig, testRoot);
		assert.strictEqual(fileConfig.http.newKey, undefined, 'Should delete new key (no original to restore)');
	});

	it('should handle complex deletions with mix of restored and deleted keys', function () {
		// Install - override existing value and add new value
		process.env.HARPER_DEFAULT_CONFIG = JSON.stringify({
			http: {
				port: 9999, // Override existing
				newSetting: 'test', // Add new
			},
			logging: {
				level: 'debug', // Override existing
			},
		});

		const fileConfig = {
			http: {
				port: 9925, // Original value
			},
			logging: {
				level: 'info', // Original value
			},
		};

		applyRuntimeEnvConfig(fileConfig, testRoot, { isInstall: true });
		assert.strictEqual(fileConfig.http.port, 9999);
		assert.strictEqual(fileConfig.http.newSetting, 'test');
		assert.strictEqual(fileConfig.logging.level, 'debug');

		// Runtime - remove all keys
		process.env.HARPER_DEFAULT_CONFIG = JSON.stringify({});

		applyRuntimeEnvConfig(fileConfig, testRoot);
		// Should restore originals
		assert.strictEqual(fileConfig.http.port, 9925, 'Should restore original port');
		assert.strictEqual(fileConfig.logging.level, 'info', 'Should restore original level');
		// Should delete new key
		assert.strictEqual(fileConfig.http.newSetting, undefined, 'Should delete new key');
	});

	it('should handle deeply nested config changes', function () {
		process.env.HARPER_DEFAULT_CONFIG = JSON.stringify({
			http: {
				cors: {
					enabled: true,
					origins: ['*.example.com'],
				},
			},
		});

		const fileConfig = {
			http: {
				port: 9925,
			},
		};

		// First run - add nested config
		applyRuntimeEnvConfig(fileConfig, testRoot);
		assert.strictEqual(fileConfig.http.cors.enabled, true);
		assert.deepStrictEqual(fileConfig.http.cors.origins, ['*.example.com']);

		// Second run - update nested value
		process.env.HARPER_DEFAULT_CONFIG = JSON.stringify({
			http: {
				cors: {
					enabled: false, // Changed
					origins: ['*.test.com'], // Changed
				},
			},
		});

		applyRuntimeEnvConfig(fileConfig, testRoot);
		assert.strictEqual(fileConfig.http.cors.enabled, false, 'Should update nested value');
		assert.deepStrictEqual(fileConfig.http.cors.origins, ['*.test.com'], 'Should update nested array');

		// Third run - remove nested config
		process.env.HARPER_DEFAULT_CONFIG = JSON.stringify({});

		applyRuntimeEnvConfig(fileConfig, testRoot);
		// Deleting nested properties leaves empty parent object
		assert.strictEqual(fileConfig.http.cors.enabled, undefined, 'Should delete nested enabled');
		assert.strictEqual(fileConfig.http.cors.origins, undefined, 'Should delete nested origins');
	});

	it('should track originalValues correctly across multiple changes', function () {
		// Install with original value
		process.env.HARPER_DEFAULT_CONFIG = JSON.stringify({
			logging: {
				level: 'debug',
			},
		});

		const fileConfig = {
			logging: {
				level: 'info', // Original
			},
		};

		applyRuntimeEnvConfig(fileConfig, testRoot, { isInstall: true });
		assert.strictEqual(fileConfig.logging.level, 'debug');

		// Runtime - change to different value
		process.env.HARPER_DEFAULT_CONFIG = JSON.stringify({
			logging: {
				level: 'warn',
			},
		});

		applyRuntimeEnvConfig(fileConfig, testRoot);
		assert.strictEqual(fileConfig.logging.level, 'warn', 'Should update to warn');

		// Runtime - remove key (should restore ORIGINAL, not previous env var value)
		process.env.HARPER_DEFAULT_CONFIG = JSON.stringify({});

		applyRuntimeEnvConfig(fileConfig, testRoot);
		assert.strictEqual(fileConfig.logging.level, 'info', 'Should restore original (info), not previous env var (warn)');
	});
});
