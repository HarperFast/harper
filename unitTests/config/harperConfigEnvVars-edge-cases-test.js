'use strict';

const assert = require('node:assert/strict');
const rewire = require('rewire');
const fs = require('fs-extra');
const path = require('node:path');
const os = require('node:os');

const harperConfigEnvVars = rewire('../../config/harperConfigEnvVars.ts');
const applyRuntimeEnvConfig = harperConfigEnvVars.__get__('applyRuntimeEnvConfig');
const deleteNestedValue = harperConfigEnvVars.__get__('deleteNestedValue');
const loadConfigState = harperConfigEnvVars.__get__('loadConfigState');

describe('harperConfigEnvVars - Edge Cases', function () {
	let testRoot;
	let originalDefaultEnv;
	let originalSetEnv;

	beforeEach(function () {
		// Save original env vars
		originalDefaultEnv = process.env.HARPER_DEFAULT_CONFIG;
		originalSetEnv = process.env.HARPER_SET_CONFIG;

		// Create unique test directory
		testRoot = path.join(os.tmpdir(), 'hdb-edge-test-' + Date.now());
		fs.mkdirpSync(testRoot);
		fs.mkdirpSync(path.join(testRoot, 'backup'));
	});

	afterEach(function () {
		// Restore original env vars
		if (originalDefaultEnv !== undefined) {
			process.env.HARPER_DEFAULT_CONFIG = originalDefaultEnv;
		} else {
			delete process.env.HARPER_DEFAULT_CONFIG;
		}
		if (originalSetEnv !== undefined) {
			process.env.HARPER_SET_CONFIG = originalSetEnv;
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

	describe('deleteNestedValue', function () {
		it('should handle deleting from non-existent path gracefully', function () {
			const config = {
				http: {
					port: 9925,
				},
			};

			// Try to delete a path that doesn't exist
			deleteNestedValue(config, 'nonexistent.path.here');

			// Config should be unchanged
			assert.deepStrictEqual(config, {
				http: {
					port: 9925,
				},
			});
		});

		it('should handle deleting when intermediate path is not an object', function () {
			const config = {
				http: {
					port: 9925,
				},
			};

			// Try to delete through a primitive value
			deleteNestedValue(config, 'http.port.subkey');

			// Config should be unchanged (can't delete through primitive)
			assert.strictEqual(config.http.port, 9925);
		});
	});

	describe('loadConfigState', function () {
		it('should handle corrupted state file gracefully', function () {
			const statePath = path.join(testRoot, 'backup', '.harper-config-state.json');

			// Write corrupted JSON
			fs.writeFileSync(statePath, '{invalid json content}');

			// Should return fresh state without crashing
			const state = loadConfigState(testRoot);

			assert.ok(state);
			assert.strictEqual(state.version, '1.0');
			assert.deepStrictEqual(state.sources, {});
			assert.deepStrictEqual(state.originalValues, {});
			assert.deepStrictEqual(state.snapshots, {});
		});

		it('should handle state file without originalValues (backwards compatibility)', function () {
			const statePath = path.join(testRoot, 'backup', '.harper-config-state.json');

			// Write old format state file (without originalValues)
			fs.writeJsonSync(statePath, {
				version: '1.0',
				sources: { 'http.port': 'HARPER_DEFAULT_CONFIG' },
				snapshots: {},
			});

			const state = loadConfigState(testRoot);

			assert.ok(state);
			assert.deepStrictEqual(state.originalValues, {});
		});
	});

	describe('detectConfigDrift', function () {
		it('should detect when user manually changes a value', function () {
			// Set up initial state with tracked value at install
			process.env.HARPER_DEFAULT_CONFIG = JSON.stringify({
				http: {
					port: 9999,
				},
			});

			const fileConfig = {
				http: {
					port: 8888, // Different initial value
				},
			};

			// First run - install, sets to 9999 and stores original (8888)
			applyRuntimeEnvConfig(fileConfig, testRoot, { isInstall: true });
			assert.strictEqual(fileConfig.http.port, 9999);

			// User manually edits the config file value
			fileConfig.http.port = 7777;

			// Second run at runtime - should detect drift
			applyRuntimeEnvConfig(fileConfig, testRoot);

			// Check if drift was detected - source should be 'user' now
			const statePath = path.join(testRoot, 'backup', '.harper-config-state.json');
			const newState = fs.readJsonSync(statePath);

			// After drift detection, DEFAULT_CONFIG respects user edits
			// So port should still be 7777 (user value wins)
			assert.strictEqual(fileConfig.http.port, 7777);
			assert.strictEqual(newState.sources['http.port'], 'user');
		});

		it('should not detect drift for values set by HARPER_SET_CONFIG', function () {
			// Set up with SET_CONFIG (which should never be marked as drift)
			process.env.HARPER_SET_CONFIG = JSON.stringify({
				http: {
					port: 8888,
				},
			});

			const fileConfig = {
				http: {
					port: 8888,
				},
			};

			// First run
			applyRuntimeEnvConfig(fileConfig, testRoot);

			// User tries to change it
			fileConfig.http.port = 7777;

			// Second run - SET_CONFIG should override drift
			applyRuntimeEnvConfig(fileConfig, testRoot);

			// Value should be back to SET_CONFIG value
			assert.strictEqual(fileConfig.http.port, 8888);
		});
	});

	describe('removeValuesWithSource', function () {
		it('should remove all values from a specific source', function () {
			// Set multiple values with HARPER_DEFAULT_CONFIG at install
			process.env.HARPER_DEFAULT_CONFIG = JSON.stringify({
				http: {
					port: 9999,
					cors: true,
				},
				logging: {
					level: 'debug',
				},
			});

			const fileConfig = {
				http: {
					port: 9925,
				},
				logging: {
					level: 'info',
				},
			};

			// Apply at install time (so it overrides and stores originals)
			applyRuntimeEnvConfig(fileConfig, testRoot, { isInstall: true });
			assert.strictEqual(fileConfig.http.port, 9999);
			assert.strictEqual(fileConfig.http.cors, true);
			assert.strictEqual(fileConfig.logging.level, 'debug');

			// Remove the env var completely
			delete process.env.HARPER_DEFAULT_CONFIG;

			// Apply again at runtime - should restore originals and delete new values
			applyRuntimeEnvConfig(fileConfig, testRoot);

			// Overridden values should be restored to originals
			assert.strictEqual(fileConfig.http.port, 9925);
			assert.strictEqual(fileConfig.logging.level, 'info');
			// New values should be deleted
			assert.strictEqual(fileConfig.http.cors, undefined);
		});
	});

	describe('cleanupRemovedEnvVar', function () {
		it('should handle cleanup when env var was never set', function () {
			const fileConfig = {
				http: {
					port: 9925,
				},
			};

			// Don't set any env vars
			delete process.env.HARPER_DEFAULT_CONFIG;
			delete process.env.HARPER_SET_CONFIG;

			// Should not crash when trying to clean up non-existent env var
			const result = applyRuntimeEnvConfig(fileConfig, testRoot);

			assert.ok(result);
			assert.strictEqual(result.http.port, 9925);
		});
	});

	describe('storeOriginals edge cases', function () {
		it('should not store original when value is null', function () {
			process.env.HARPER_DEFAULT_CONFIG = JSON.stringify({
				http: {
					cors: true,
				},
			});

			const fileConfig = {
				http: {
					cors: null, // null value
				},
			};

			applyRuntimeEnvConfig(fileConfig, testRoot, { isInstall: true });

			// Check state - should not have stored null as original
			const statePath = path.join(testRoot, 'backup', '.harper-config-state.json');
			const state = fs.readJsonSync(statePath);

			// originalValues should be empty (null is not stored)
			assert.deepStrictEqual(state.originalValues, {});
		});

		it('should not store original when value is undefined', function () {
			process.env.HARPER_DEFAULT_CONFIG = JSON.stringify({
				http: {
					newKey: 'newValue',
				},
			});

			const fileConfig = {
				http: {
					port: 9925,
				},
				// newKey doesn't exist (undefined)
			};

			applyRuntimeEnvConfig(fileConfig, testRoot, { isInstall: true });

			// Check state
			const statePath = path.join(testRoot, 'backup', '.harper-config-state.json');
			const state = fs.readJsonSync(statePath);

			// originalValues should be empty (undefined is not stored)
			assert.deepStrictEqual(state.originalValues, {});
		});
	});

	describe('early return cases', function () {
		it('should return early when no env vars are set', function () {
			delete process.env.HARPER_DEFAULT_CONFIG;
			delete process.env.HARPER_SET_CONFIG;

			const fileConfig = {
				http: {
					port: 9925,
				},
			};

			const result = applyRuntimeEnvConfig(fileConfig, testRoot);

			// Should return config unchanged
			assert.strictEqual(result, fileConfig);
			assert.strictEqual(result.http.port, 9925);

			// Should not create state file
			const statePath = path.join(testRoot, 'backup', '.harper-config-state.json');
			assert.strictEqual(fs.existsSync(statePath), false);
		});
	});

	describe('drift detection at install vs runtime', function () {
		it('should not detect drift during install', function () {
			process.env.HARPER_DEFAULT_CONFIG = JSON.stringify({
				http: {
					port: 9999,
				},
			});

			const fileConfig = {
				http: {
					port: 7777, // Different from env var
				},
			};

			// Install - should override without drift detection
			applyRuntimeEnvConfig(fileConfig, testRoot, { isInstall: true });

			// Value should be overridden
			assert.strictEqual(fileConfig.http.port, 9999);

			// Check state - should NOT be marked as 'user'
			const statePath = path.join(testRoot, 'backup', '.harper-config-state.json');
			const state = fs.readJsonSync(statePath);
			assert.strictEqual(state.sources['http.port'], 'HARPER_DEFAULT_CONFIG');
		});
	});
});
