'use strict';

const assert = require('node:assert');
const rewire = require('rewire');
const fs = require('fs-extra');
const path = require('node:path');
const os = require('node:os');

const harperConfigEnvVars = rewire('#src/config/harperConfigEnvVars');
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
		} catch {
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

		it('should RESTORE original value when key removed from HARPER_SET_CONFIG via changed env var', function () {
			// Start with original file config
			const fileConfig = {
				http: {
					port: 9925,
					mtls: false, // Original value from template
				},
			};

			// First run - SET_CONFIG overrides mtls to true
			process.env.HARPER_SET_CONFIG = JSON.stringify({
				http: {
					mtls: true,
				},
			});

			applyRuntimeEnvConfig(fileConfig, testRoot);
			assert.strictEqual(fileConfig.http.mtls, true, 'SET_CONFIG should override to true');

			// Second run - SET_CONFIG changed to empty http object (removed mtls key)
			process.env.HARPER_SET_CONFIG = JSON.stringify({
				http: {},
			});

			applyRuntimeEnvConfig(fileConfig, testRoot);
			assert.strictEqual(fileConfig.http.mtls, false, 'Should restore original value when key removed from SET_CONFIG');
			assert.strictEqual(fileConfig.http.port, 9925, 'Other values should remain unchanged');
		});

		it('should remove an entry entirely when removed from HARPER_SET_CONFIG, not leave an empty object (#2067)', function () {
			// First run - two sibling entries under a nested map
			process.env.HARPER_SET_CONFIG = JSON.stringify({
				models: {
					embedding: {
						default: { backend: 'openai', baseUrl: 'http://127.0.0.1:8001/v1', model: 'nomic' },
						qwen3: { backend: 'openai', baseUrl: 'http://127.0.0.1:8002/v1', model: 'qwen' },
					},
				},
			});

			const fileConfig = {};
			applyRuntimeEnvConfig(fileConfig, testRoot);
			assert.strictEqual(fileConfig.models.embedding.qwen3.backend, 'openai');

			// Second run - qwen3 removed from SET_CONFIG
			process.env.HARPER_SET_CONFIG = JSON.stringify({
				models: {
					embedding: {
						default: { backend: 'openai', baseUrl: 'http://127.0.0.1:8001/v1', model: 'nomic' },
					},
				},
			});

			applyRuntimeEnvConfig(fileConfig, testRoot);
			assert.strictEqual(fileConfig.models.embedding.qwen3, undefined, 'Removed entry must be pruned, not left as {}');
			assert.strictEqual(fileConfig.models.embedding.default.model, 'nomic', 'Sibling entry should be intact');
		});

		it('should prune emptied parents when HARPER_SET_CONFIG is removed entirely', function () {
			process.env.HARPER_SET_CONFIG = JSON.stringify({
				models: { embedding: { qwen3: { backend: 'openai', model: 'qwen' } } },
			});

			const fileConfig = { http: { port: 9925 } };
			applyRuntimeEnvConfig(fileConfig, testRoot);
			assert.strictEqual(fileConfig.models.embedding.qwen3.backend, 'openai');

			delete process.env.HARPER_SET_CONFIG;

			applyRuntimeEnvConfig(fileConfig, testRoot);
			assert.strictEqual(fileConfig.models, undefined, 'Vacated subtree must be pruned, not left as a {} skeleton');
			assert.strictEqual(fileConfig.http.port, 9925, 'Unrelated config should be intact');
		});

		it('should not touch a deliberate empty object scope elsewhere in the file when pruning', function () {
			// A bare `componentName: {}` in the config file is user content (#1618/#1726)
			const fileConfig = { myComponent: {}, http: { port: 9925 } };
			process.env.HARPER_SET_CONFIG = JSON.stringify({
				models: { embedding: { a: { backend: 'openai' } } },
			});

			applyRuntimeEnvConfig(fileConfig, testRoot);

			delete process.env.HARPER_SET_CONFIG;

			applyRuntimeEnvConfig(fileConfig, testRoot);
			assert.deepStrictEqual(fileConfig.myComponent, {}, 'User empty scope must be preserved');
			assert.strictEqual(fileConfig.models, undefined, 'Vacated subtree must be pruned');
		});

		it('should restore a scope the file declared empty after the env var that populated it vacates (#1726)', function () {
			const fileConfig = { myComponent: {} };
			process.env.HARPER_SET_CONFIG = JSON.stringify({ myComponent: { port: 123 } });

			applyRuntimeEnvConfig(fileConfig, testRoot);
			assert.strictEqual(fileConfig.myComponent.port, 123);

			delete process.env.HARPER_SET_CONFIG;

			applyRuntimeEnvConfig(fileConfig, testRoot);
			assert.deepStrictEqual(fileConfig.myComponent, {}, 'Declared-empty scope must survive populate-then-vacate');
		});

		it('should not resurrect a vacated scope over a value the env var just set', function () {
			process.env.HARPER_SET_CONFIG = JSON.stringify({ a: { b: { c: 1 } } });
			const fileConfig = { a: { b: {} } };
			applyRuntimeEnvConfig(fileConfig, testRoot);
			assert.strictEqual(fileConfig.a.b.c, 1);

			// SET flips a to a scalar; the vacated a.b.c must not restore {} over it
			process.env.HARPER_SET_CONFIG = JSON.stringify({ a: 5 });
			applyRuntimeEnvConfig(fileConfig, testRoot);
			assert.strictEqual(fileConfig.a, 5, 'scalar set by the force layer must stand');
		});

		it('should keep an entry whose original values were restored while its added keys are pruned', function () {
			const fileConfig = { models: { embedding: { qwen3: { backend: 'ollama' } } } };
			process.env.HARPER_SET_CONFIG = JSON.stringify({
				models: { embedding: { qwen3: { backend: 'openai', model: 'qwen' } } },
			});

			applyRuntimeEnvConfig(fileConfig, testRoot);
			assert.strictEqual(fileConfig.models.embedding.qwen3.model, 'qwen');

			// qwen3 dropped from SET_CONFIG: backend restores to its original, model had none
			process.env.HARPER_SET_CONFIG = JSON.stringify({ models: { embedding: {} } });

			applyRuntimeEnvConfig(fileConfig, testRoot);
			assert.deepStrictEqual(
				fileConfig.models.embedding.qwen3,
				{ backend: 'ollama' },
				'Restored original keeps the entry; only the added key is removed'
			);
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
