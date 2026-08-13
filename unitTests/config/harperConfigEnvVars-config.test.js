'use strict';

const assert = require('node:assert');
const rewire = require('rewire');
const fs = require('fs-extra');
const path = require('node:path');
const os = require('node:os');

const harperConfigEnvVars = rewire('#src/config/harperConfigEnvVars');
const applyRuntimeEnvConfig = harperConfigEnvVars.__get__('applyRuntimeEnvConfig');
const composeConfigFromEnv = harperConfigEnvVars.__get__('composeConfigFromEnv');
const filterArgsAgainstRuntimeConfig = harperConfigEnvVars.__get__('filterArgsAgainstRuntimeConfig');
const hasPersistedEnvConfigState = harperConfigEnvVars.__get__('hasPersistedEnvConfigState');

const ENV_VARS = ['HARPER_CONFIG', 'HARPER_DEFAULT_CONFIG', 'HARPER_SET_CONFIG'];

describe('HARPER_CONFIG', function () {
	let testRoot;
	let savedEnv;

	beforeEach(function () {
		savedEnv = {};
		for (const name of ENV_VARS) {
			savedEnv[name] = process.env[name];
			delete process.env[name];
		}

		testRoot = path.join(os.tmpdir(), 'hdb-config-test-' + Date.now() + '-' + Math.floor(process.hrtime()[1]));
		fs.mkdirpSync(path.join(testRoot, 'backup'));
	});

	afterEach(function () {
		for (const name of ENV_VARS) {
			if (savedEnv[name] !== undefined) process.env[name] = savedEnv[name];
			else delete process.env[name];
		}

		try {
			fs.removeSync(testRoot);
			// eslint-disable-next-line sonarjs/no-ignored-exceptions
		} catch {
			// ignore cleanup errors
		}
	});

	function readState() {
		return fs.readJsonSync(path.join(testRoot, 'backup', '.harper-config-state.json'));
	}

	describe('merge behavior', function () {
		it('sets only the keys it names, preserving siblings at any depth', function () {
			process.env.HARPER_CONFIG = JSON.stringify({ http: { port: 8080 } });
			const fileConfig = {
				http: { port: 9925, securePort: 9926, cors: { enabled: true } },
				logging: { level: 'warn' },
			};

			applyRuntimeEnvConfig(fileConfig, testRoot);

			assert.strictEqual(fileConfig.http.port, 8080);
			assert.strictEqual(fileConfig.http.securePort, 9926, 'sibling preserved');
			assert.strictEqual(fileConfig.http.cors.enabled, true, 'nested sibling preserved');
			assert.strictEqual(fileConfig.logging.level, 'warn', 'unrelated section preserved');
		});

		it('tracks its paths with source HARPER_CONFIG and stores originals', function () {
			process.env.HARPER_CONFIG = JSON.stringify({ http: { port: 8080 } });
			const fileConfig = { http: { port: 9925 } };

			applyRuntimeEnvConfig(fileConfig, testRoot);

			const state = readState();
			assert.strictEqual(state.sources['http.port'], 'HARPER_CONFIG');
			assert.strictEqual(state.originalValues['http.port'], 9925);
		});

		it('honors $union for arrays', function () {
			process.env.HARPER_CONFIG = JSON.stringify({ tls: { uses: { $union: ['server'] } } });
			const fileConfig = { tls: { uses: ['app-cert'] } };

			applyRuntimeEnvConfig(fileConfig, testRoot);
			applyRuntimeEnvConfig(fileConfig, testRoot);

			assert.deepStrictEqual(fileConfig.tls.uses, ['app-cert', 'server'], 'composes and stays idempotent');
		});
	});

	describe('precedence', function () {
		it('wins over an existing config-file value', function () {
			process.env.HARPER_CONFIG = JSON.stringify({ logging: { level: 'debug' } });
			const fileConfig = { logging: { level: 'warn' } };

			applyRuntimeEnvConfig(fileConfig, testRoot);

			assert.strictEqual(fileConfig.logging.level, 'debug');
		});

		it('reasserts over a manual user edit on the next boot', function () {
			process.env.HARPER_CONFIG = JSON.stringify({ logging: { level: 'debug' } });
			const fileConfig = { logging: { level: 'warn' } };
			applyRuntimeEnvConfig(fileConfig, testRoot);
			assert.strictEqual(fileConfig.logging.level, 'debug');

			// User hand-edits the config file between boots
			fileConfig.logging.level = 'error';

			applyRuntimeEnvConfig(fileConfig, testRoot);
			assert.strictEqual(fileConfig.logging.level, 'debug', 'env reasserts while the var names the key');
		});

		it('wins over HARPER_DEFAULT_CONFIG', function () {
			process.env.HARPER_DEFAULT_CONFIG = JSON.stringify({ http: { port: 7777 } });
			process.env.HARPER_CONFIG = JSON.stringify({ http: { port: 8080 } });
			const fileConfig = {};

			applyRuntimeEnvConfig(fileConfig, testRoot, { isInstall: true });

			assert.strictEqual(fileConfig.http.port, 8080);
			assert.strictEqual(readState().sources['http.port'], 'HARPER_CONFIG');
		});

		it('yields to HARPER_SET_CONFIG', function () {
			process.env.HARPER_CONFIG = JSON.stringify({ http: { port: 8080 } });
			process.env.HARPER_SET_CONFIG = JSON.stringify({ http: { port: 6666 } });
			const fileConfig = { http: { port: 9925 } };

			applyRuntimeEnvConfig(fileConfig, testRoot);

			assert.strictEqual(fileConfig.http.port, 6666);
			assert.strictEqual(readState().sources['http.port'], 'HARPER_SET_CONFIG');

			// And on a later boot, CONFIG still does not steal a SET-sourced path
			applyRuntimeEnvConfig(fileConfig, testRoot);
			assert.strictEqual(fileConfig.http.port, 6666);
			assert.strictEqual(readState().sources['http.port'], 'HARPER_SET_CONFIG');
		});

		it('reclaims a path the SAME boot HARPER_SET_CONFIG is removed (no one-boot drop to file value)', function () {
			// Boot 1: SET owns the path, CONFIG also names it
			process.env.HARPER_CONFIG = JSON.stringify({ http: { port: 2222 } });
			process.env.HARPER_SET_CONFIG = JSON.stringify({ http: { port: 3333 } });
			const fileConfig = { http: { port: 9925 } };
			applyRuntimeEnvConfig(fileConfig, testRoot);
			assert.strictEqual(fileConfig.http.port, 3333);
			assert.strictEqual(readState().sources['http.port'], 'HARPER_SET_CONFIG');

			// Boot 2: drop SET only — CONFIG must take the path back to 2222 THIS boot,
			// not fall through to the file original (9925) for a boot.
			delete process.env.HARPER_SET_CONFIG;
			applyRuntimeEnvConfig(fileConfig, testRoot);
			assert.strictEqual(fileConfig.http.port, 2222, 'CONFIG reclaims same boot');
			assert.strictEqual(readState().sources['http.port'], 'HARPER_CONFIG');

			// And dropping CONFIG afterward restores the true file original
			delete process.env.HARPER_CONFIG;
			applyRuntimeEnvConfig(fileConfig, testRoot);
			assert.strictEqual(fileConfig.http.port, 9925, 'original restored after both vars gone');
		});
	});

	describe('deletion / cleanup', function () {
		it('restores the original value when a key is dropped between boots', function () {
			process.env.HARPER_CONFIG = JSON.stringify({ http: { port: 8080 }, logging: { level: 'debug' } });
			const fileConfig = { http: { port: 9925 }, logging: { level: 'warn' } };
			applyRuntimeEnvConfig(fileConfig, testRoot);
			assert.strictEqual(fileConfig.http.port, 8080);

			// Next boot: http.port dropped from the var
			process.env.HARPER_CONFIG = JSON.stringify({ logging: { level: 'debug' } });
			applyRuntimeEnvConfig(fileConfig, testRoot);

			assert.strictEqual(fileConfig.http.port, 9925, 'original restored');
			assert.strictEqual(fileConfig.logging.level, 'debug', 'remaining key still applied');
			assert.strictEqual(readState().sources['http.port'], undefined);
		});

		it('restores originals when the variable is removed entirely', function () {
			process.env.HARPER_CONFIG = JSON.stringify({ http: { port: 8080 } });
			const fileConfig = { http: { port: 9925 } };
			applyRuntimeEnvConfig(fileConfig, testRoot);
			assert.strictEqual(fileConfig.http.port, 8080);

			delete process.env.HARPER_CONFIG;
			applyRuntimeEnvConfig(fileConfig, testRoot);

			assert.strictEqual(fileConfig.http.port, 9925, 'original restored after var removal');
			const state = readState();
			assert.strictEqual(state.snapshots.HARPER_CONFIG, undefined, 'snapshot cleaned up');
		});

		it('deletes a key it introduced (no original) when dropped', function () {
			process.env.HARPER_CONFIG = JSON.stringify({ http: { cors: { enabled: true } } });
			const fileConfig = { http: {} };
			applyRuntimeEnvConfig(fileConfig, testRoot);
			assert.strictEqual(fileConfig.http.cors.enabled, true);

			delete process.env.HARPER_CONFIG;
			applyRuntimeEnvConfig(fileConfig, testRoot);

			assert.strictEqual(fileConfig.http.cors?.enabled, undefined, 'introduced key removed');
		});

		it('prunes an entry it introduced entirely when the entry is dropped (#2067)', function () {
			process.env.HARPER_CONFIG = JSON.stringify({
				models: { embedding: { a: { backend: 'openai' }, b: { backend: 'openai' } } },
			});
			const fileConfig = {};
			applyRuntimeEnvConfig(fileConfig, testRoot);
			assert.strictEqual(fileConfig.models.embedding.b.backend, 'openai');

			process.env.HARPER_CONFIG = JSON.stringify({
				models: { embedding: { a: { backend: 'openai' } } },
			});
			applyRuntimeEnvConfig(fileConfig, testRoot);
			assert.strictEqual(fileConfig.models.embedding.b, undefined, 'dropped entry pruned, not left as {}');
			assert.strictEqual(fileConfig.models.embedding.a.backend, 'openai');
		});

		it('does not prune a deliberate empty object when removing an already-absent key', function () {
			// a has other content at populate time, so no empty-scope marker exists
			process.env.HARPER_CONFIG = JSON.stringify({ a: { b: 2 } });
			const fileConfig = { a: { keep: 1 } };
			applyRuntimeEnvConfig(fileConfig, testRoot);
			assert.strictEqual(fileConfig.a.b, 2);

			// user hand-edited the file down to a deliberate `a: {}` between boots
			const editedConfig = { a: {} };
			delete process.env.HARPER_CONFIG;
			applyRuntimeEnvConfig(editedConfig, testRoot);
			assert.deepStrictEqual(editedConfig.a, {}, 'no-op removal must not eat the empty scope');
		});

		it('does not prune when the absent key collides with an Object.prototype member', function () {
			process.env.HARPER_CONFIG = JSON.stringify({ x: { constructor: 1 } });
			const fileConfig = { x: { keep: 1 } };
			applyRuntimeEnvConfig(fileConfig, testRoot);
			assert.strictEqual(fileConfig.x.constructor, 1);

			// user hand-edited the file down to a deliberate `x: {}` between boots
			const editedConfig = { x: {} };
			delete process.env.HARPER_CONFIG;
			applyRuntimeEnvConfig(editedConfig, testRoot);
			assert.deepStrictEqual(editedConfig.x, {}, 'prototype-chain key must not defeat the absent-leaf guard');
		});

		it('clears a stale marker when the user hand-deletes the scope the env var populated', function () {
			process.env.HARPER_CONFIG = JSON.stringify({ myComponent: { port: 1 } });
			const fileConfig = { myComponent: {} };
			applyRuntimeEnvConfig(fileConfig, testRoot);
			assert.strictEqual(fileConfig.myComponent.port, 1);

			// user hand-deletes the whole scope while the env var is still set;
			// the CONFIG layer re-asserts its leaf on the next boot
			const editedConfig = {};
			applyRuntimeEnvConfig(editedConfig, testRoot);
			assert.strictEqual(editedConfig.myComponent.port, 1);

			// removing the env var must not resurrect the hand-deleted scope
			delete process.env.HARPER_CONFIG;
			applyRuntimeEnvConfig(editedConfig, testRoot);
			assert.strictEqual(editedConfig.myComponent, undefined, 'hand-deleted scope must stay deleted');
		});

		it('clears a stale marker even when the scope name collides with an Object.prototype member', function () {
			process.env.HARPER_CONFIG = JSON.stringify({ constructor: { port: 1 } });
			const fileConfig = { constructor: {} };
			applyRuntimeEnvConfig(fileConfig, testRoot);
			assert.strictEqual(fileConfig.constructor.port, 1);

			// user hand-deletes the scope; the walk must see absence, not the prototype
			const editedConfig = {};
			applyRuntimeEnvConfig(editedConfig, testRoot);
			assert.strictEqual(editedConfig.constructor.port, 1);

			delete process.env.HARPER_CONFIG;
			applyRuntimeEnvConfig(editedConfig, testRoot);
			assert.strictEqual(editedConfig.constructor?.port, undefined, 'hand-deleted scope must stay deleted');
		});

		it('keeps the marker across a restart while a higher layer holds a scalar over the scope', function () {
			process.env.HARPER_CONFIG = JSON.stringify({ myComponent: { port: 1 } });
			const fileConfig = { myComponent: {} };
			applyRuntimeEnvConfig(fileConfig, testRoot);

			process.env.HARPER_SET_CONFIG = JSON.stringify({ myComponent: false });
			applyRuntimeEnvConfig(fileConfig, testRoot);
			assert.strictEqual(fileConfig.myComponent, false);

			// ordinary restart with both vars unchanged: occlusion is not deletion
			applyRuntimeEnvConfig(fileConfig, testRoot);
			assert.strictEqual(fileConfig.myComponent, false);

			// both layers released: the file-declared empty scope must come back
			delete process.env.HARPER_SET_CONFIG;
			applyRuntimeEnvConfig(fileConfig, testRoot);
			delete process.env.HARPER_CONFIG;
			applyRuntimeEnvConfig(fileConfig, testRoot);
			assert.deepStrictEqual(fileConfig.myComponent, {}, 'marker must survive restarts under an occluding scalar');
		});

		it('keeps a declared-empty scope restorable across stacked CONFIG and SET layers', function () {
			process.env.HARPER_CONFIG = JSON.stringify({ myComponent: { port: 1 } });
			const fileConfig = { myComponent: {} };
			applyRuntimeEnvConfig(fileConfig, testRoot);
			assert.strictEqual(fileConfig.myComponent.port, 1);

			// SET overwrites the whole scope with a leaf, then releases it
			process.env.HARPER_SET_CONFIG = JSON.stringify({ myComponent: false });
			applyRuntimeEnvConfig(fileConfig, testRoot);
			assert.strictEqual(fileConfig.myComponent, false);

			delete process.env.HARPER_SET_CONFIG;
			applyRuntimeEnvConfig(fileConfig, testRoot);
			assert.strictEqual(fileConfig.myComponent.port, 1, 'CONFIG layer reasserts after SET releases');

			delete process.env.HARPER_CONFIG;
			applyRuntimeEnvConfig(fileConfig, testRoot);
			assert.deepStrictEqual(fileConfig.myComponent, {}, 'file-declared empty scope survives the stack');
		});
	});

	describe('individual env var interaction', function () {
		it('does NOT filter individual args against HARPER_CONFIG (SET-only filtering)', function () {
			process.env.HARPER_CONFIG = JSON.stringify({ operationsApi: { network: { port: 9925 } } });

			const args = { operationsapi_network_port: '9930', rootpath: '/y' };
			const filtered = filterArgsAgainstRuntimeConfig(args);

			assert.deepStrictEqual(filtered, args, 'individual env vars win over HARPER_CONFIG');
		});
	});

	describe('hasPersistedEnvConfigState', function () {
		it('is false for a fresh root and true once a var has been applied', function () {
			assert.strictEqual(hasPersistedEnvConfigState(testRoot), false, 'no state file yet');

			process.env.HARPER_CONFIG = JSON.stringify({ http: { port: 8080 } });
			applyRuntimeEnvConfig({ http: { port: 9925 } }, testRoot);

			assert.strictEqual(hasPersistedEnvConfigState(testRoot), true, 'snapshot persisted after apply');
		});
	});

	describe('composeConfigFromEnv', function () {
		it('layers DEFAULT < base < HARPER_CONFIG < SET', function () {
			process.env.HARPER_DEFAULT_CONFIG = JSON.stringify({ a: 1, b: 1, c: 1, d: 1 });
			process.env.HARPER_CONFIG = JSON.stringify({ c: 3, d: 3 });
			process.env.HARPER_SET_CONFIG = JSON.stringify({ d: 4 });

			const result = composeConfigFromEnv({ b: 2, c: 2, d: 2 });

			assert.strictEqual(result.a, 1, 'DEFAULT fills the gap');
			assert.strictEqual(result.b, 2, 'base beats DEFAULT');
			assert.strictEqual(result.c, 3, 'HARPER_CONFIG beats base');
			assert.strictEqual(result.d, 4, 'SET beats HARPER_CONFIG');
		});
	});
});
