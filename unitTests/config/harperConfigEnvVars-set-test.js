'use strict';

const assert = require('node:assert/strict');
const rewire = require('rewire');
const fs = require('fs-extra');
const path = require('node:path');
const os = require('node:os');

const harperConfigEnvVars = rewire('../../config/harperConfigEnvVars.ts');
const applyRuntimeEnvConfig = harperConfigEnvVars.__get__('applyRuntimeEnvConfig');

describe('HARPER_SET_CONFIG', function () {
	let testRoot;
	let originalEnv;

	beforeEach(function () {
		// Save original env var
		originalEnv = process.env.HARPER_SET_CONFIG;

		// Create unique test directory
		testRoot = path.join(os.tmpdir(), 'hdb-set-test-' + Date.now());
		fs.mkdirpSync(testRoot);
		fs.mkdirpSync(path.join(testRoot, 'backup'));
	});

	afterEach(function () {
		// Restore original env var
		if (originalEnv !== undefined) {
			process.env.HARPER_SET_CONFIG = originalEnv;
		} else {
			delete process.env.HARPER_SET_CONFIG;
		}

		// Cleanup test directory
		try {
			fs.removeSync(testRoot);
			// eslint-disable-next-line sonarjs/no-ignored-exceptions
		} catch (err) {
			// Ignore cleanup errors
		}
	});

	describe('Install-time behavior', function () {
		it('should apply HARPER_SET_CONFIG during install', function () {
			process.env.HARPER_SET_CONFIG = JSON.stringify({
				http: {
					port: 8888,
				},
			});

			const fileConfig = {
				http: {
					port: 9925, // Will be overridden
				},
			};

			applyRuntimeEnvConfig(fileConfig, testRoot, { isInstall: true });

			assert.strictEqual(fileConfig.http.port, 8888, 'Should override to 8888');
		});

		it('should override HARPER_DEFAULT_CONFIG values during install', function () {
			// Set both env vars
			process.env.HARPER_DEFAULT_CONFIG = JSON.stringify({
				http: {
					port: 9999,
				},
			});
			process.env.HARPER_SET_CONFIG = JSON.stringify({
				http: {
					port: 7777,
				},
			});

			const fileConfig = {
				http: {
					port: 9925,
				},
			};

			// Apply both at once (simulates install)
			applyRuntimeEnvConfig(fileConfig, testRoot, { isInstall: true });
			assert.strictEqual(fileConfig.http.port, 7777, 'SET_CONFIG should override DEFAULT_CONFIG');

			// Verify state tracking
			const statePath = path.join(testRoot, 'backup', '.harper-config-state.json');
			const state = fs.readJsonSync(statePath);
			assert.strictEqual(state.sources['http.port'], 'HARPER_SET_CONFIG', 'Source should be HARPER_SET_CONFIG');
		});

		it('should track HARPER_SET_CONFIG in state file', function () {
			process.env.HARPER_SET_CONFIG = JSON.stringify({
				logging: {
					level: 'warn',
				},
			});

			const fileConfig = {
				logging: {
					level: 'info',
				},
			};

			applyRuntimeEnvConfig(fileConfig, testRoot, { isInstall: true });

			const statePath = path.join(testRoot, 'backup', '.harper-config-state.json');
			const state = fs.readJsonSync(statePath);

			assert.strictEqual(state.sources['logging.level'], 'HARPER_SET_CONFIG');
			assert.ok(state.snapshots.HARPER_SET_CONFIG);
			assert.strictEqual(state.snapshots.HARPER_SET_CONFIG.config.logging.level, 'warn');
		});
	});

	describe('Runtime behavior', function () {
		it('should apply HARPER_SET_CONFIG at runtime', function () {
			process.env.HARPER_SET_CONFIG = JSON.stringify({
				http: {
					port: 8888,
				},
			});

			const fileConfig = {
				http: {
					port: 9925,
				},
			};

			applyRuntimeEnvConfig(fileConfig, testRoot);

			assert.strictEqual(fileConfig.http.port, 8888, 'Should override to 8888');
		});

		it('should override HARPER_DEFAULT_CONFIG at runtime', function () {
			// Set both env vars
			process.env.HARPER_DEFAULT_CONFIG = JSON.stringify({
				http: {
					port: 9999,
				},
			});
			process.env.HARPER_SET_CONFIG = JSON.stringify({
				http: {
					port: 7777,
				},
			});

			const fileConfig = {
				http: {
					port: 9925,
				},
			};

			applyRuntimeEnvConfig(fileConfig, testRoot);

			assert.strictEqual(fileConfig.http.port, 7777, 'SET_CONFIG should override DEFAULT_CONFIG');

			// Verify state tracking shows SET_CONFIG won
			const statePath = path.join(testRoot, 'backup', '.harper-config-state.json');
			const state = fs.readJsonSync(statePath);
			assert.strictEqual(state.sources['http.port'], 'HARPER_SET_CONFIG');
		});

		it('should override user edits (force override)', function () {
			// First run - set value with HARPER_SET_CONFIG
			process.env.HARPER_SET_CONFIG = JSON.stringify({
				http: {
					port: 8888,
				},
			});

			const fileConfig = {
				http: {
					port: 9925,
				},
			};

			applyRuntimeEnvConfig(fileConfig, testRoot);
			assert.strictEqual(fileConfig.http.port, 8888);

			// Simulate user edit
			fileConfig.http.port = 7777;
			const statePath = path.join(testRoot, 'backup', '.harper-config-state.json');
			const state = fs.readJsonSync(statePath);
			state.sources['http.port'] = 'user';
			fs.writeJsonSync(statePath, state);

			// Second run - HARPER_SET_CONFIG should still override
			applyRuntimeEnvConfig(fileConfig, testRoot);
			assert.strictEqual(fileConfig.http.port, 8888, 'SET_CONFIG should override user edits');
		});

		it('should delete NEW values when key removed from HARPER_SET_CONFIG', function () {
			// First run - add new key
			process.env.HARPER_SET_CONFIG = JSON.stringify({
				http: {
					newKey: 'testValue',
				},
			});

			const fileConfig = {
				http: {
					port: 9925,
				},
			};

			applyRuntimeEnvConfig(fileConfig, testRoot);
			assert.strictEqual(fileConfig.http.newKey, 'testValue');

			// Second run - remove key
			process.env.HARPER_SET_CONFIG = JSON.stringify({});

			applyRuntimeEnvConfig(fileConfig, testRoot);
			assert.strictEqual(fileConfig.http.newKey, undefined, 'Should delete key that had no original');
		});

		it('should RESTORE original values when key removed from HARPER_SET_CONFIG', function () {
			// Start with original file config
			const fileConfig = {
				http: {
					port: 9925, // Original value
				},
			};

			// First run - SET_CONFIG overrides it
			process.env.HARPER_SET_CONFIG = JSON.stringify({
				http: {
					port: 9999,
				},
			});

			applyRuntimeEnvConfig(fileConfig, testRoot);
			assert.strictEqual(fileConfig.http.port, 9999, 'SET_CONFIG should override to 9999');

			// Second run - SET_CONFIG removed, should restore original
			delete process.env.HARPER_SET_CONFIG;

			applyRuntimeEnvConfig(fileConfig, testRoot);
			assert.strictEqual(fileConfig.http.port, 9925, 'Should restore original value when SET_CONFIG removed');
		});

		it('should update values when HARPER_SET_CONFIG changes', function () {
			// First run
			process.env.HARPER_SET_CONFIG = JSON.stringify({
				logging: {
					level: 'debug',
				},
			});

			const fileConfig = {
				logging: {
					level: 'info',
				},
			};

			applyRuntimeEnvConfig(fileConfig, testRoot);
			assert.strictEqual(fileConfig.logging.level, 'debug');

			// Second run with different value
			process.env.HARPER_SET_CONFIG = JSON.stringify({
				logging: {
					level: 'error',
				},
			});

			applyRuntimeEnvConfig(fileConfig, testRoot);
			assert.strictEqual(fileConfig.logging.level, 'error', 'Should update to new value');
		});
	});

	describe('Precedence', function () {
		it('should follow precedence: SET_CONFIG > user > DEFAULT_CONFIG > file', function () {
			// Start with file default
			const fileConfig = {
				http: {
					port: 9925, // File default
				},
			};

			// Apply HARPER_DEFAULT_CONFIG at install
			process.env.HARPER_DEFAULT_CONFIG = JSON.stringify({
				http: {
					port: 9999,
				},
			});

			applyRuntimeEnvConfig(fileConfig, testRoot, { isInstall: true });
			assert.strictEqual(fileConfig.http.port, 9999, 'DEFAULT_CONFIG overrides file');

			// Simulate user edit at runtime
			fileConfig.http.port = 7777;
			const statePath = path.join(testRoot, 'backup', '.harper-config-state.json');
			let state = fs.readJsonSync(statePath);
			state.sources['http.port'] = 'user';
			fs.writeJsonSync(statePath, state);

			// Apply runtime with only DEFAULT_CONFIG (user edit should win)
			applyRuntimeEnvConfig(fileConfig, testRoot);
			assert.strictEqual(fileConfig.http.port, 7777, 'User edit overrides DEFAULT_CONFIG');

			// Now apply SET_CONFIG (should override user edit)
			process.env.HARPER_SET_CONFIG = JSON.stringify({
				http: {
					port: 5555,
				},
			});

			applyRuntimeEnvConfig(fileConfig, testRoot);
			assert.strictEqual(fileConfig.http.port, 5555, 'SET_CONFIG overrides user edit');
		});
	});
});
