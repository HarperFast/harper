'use strict';

const assert = require('node:assert/strict');
const rewire = require('rewire');
const fs = require('fs-extra');
const path = require('node:path');
const os = require('node:os');

const harperConfigEnvVars = rewire('#src/config/harperConfigEnvVars');
const applyRuntimeEnvConfig = harperConfigEnvVars.__get__('applyRuntimeEnvConfig');
const composeConfigFromEnv = harperConfigEnvVars.__get__('composeConfigFromEnv');
const filterArgsAgainstRuntimeConfig = harperConfigEnvVars.__get__('filterArgsAgainstRuntimeConfig');
const unionArrays = harperConfigEnvVars.__get__('unionArrays');
const isDirectiveObject = harperConfigEnvVars.__get__('isDirectiveObject');
const flattenObject = harperConfigEnvVars.__get__('flattenObject');
const stableStringify = harperConfigEnvVars.__get__('stableStringify');

describe('$union array directive', function () {
	let testRoot;
	let originalSet;
	let originalDefault;

	beforeEach(function () {
		originalSet = process.env.HARPER_SET_CONFIG;
		originalDefault = process.env.HARPER_DEFAULT_CONFIG;
		delete process.env.HARPER_SET_CONFIG;
		delete process.env.HARPER_DEFAULT_CONFIG;

		testRoot = path.join(os.tmpdir(), 'hdb-union-test-' + Date.now() + '-' + Math.floor(process.hrtime()[1]));
		fs.mkdirpSync(path.join(testRoot, 'backup'));
	});

	afterEach(function () {
		if (originalSet !== undefined) process.env.HARPER_SET_CONFIG = originalSet;
		else delete process.env.HARPER_SET_CONFIG;
		if (originalDefault !== undefined) process.env.HARPER_DEFAULT_CONFIG = originalDefault;
		else delete process.env.HARPER_DEFAULT_CONFIG;

		try {
			fs.removeSync(testRoot);
			// eslint-disable-next-line sonarjs/no-ignored-exceptions
		} catch {
			// ignore cleanup errors
		}
	});

	describe('unionArrays (unit)', function () {
		it('appends only items not already present, preserving order', function () {
			assert.deepStrictEqual(unionArrays(['a'], ['b', 'a', 'c']), ['a', 'b', 'c']);
		});

		it('treats a missing/undefined current value as an empty array', function () {
			assert.deepStrictEqual(unionArrays(undefined, ['x']), ['x']);
			assert.deepStrictEqual(unionArrays(null, ['x']), ['x']);
		});

		it('is idempotent — re-applying the same items is a no-op', function () {
			const once = unionArrays(['a'], ['a', 'b']);
			assert.deepStrictEqual(once, ['a', 'b']);
			assert.deepStrictEqual(unionArrays(once, ['a', 'b']), ['a', 'b']);
		});

		it('dedupes deeply-equal object entries', function () {
			assert.deepStrictEqual(unionArrays([{ x: 1 }], [{ x: 1 }, { y: 2 }]), [{ x: 1 }, { y: 2 }]);
		});

		it('dedupes object entries regardless of property order (idempotent across boots)', function () {
			// e.g. an existing { host, port } vs a listed { port, host } — same object, must not re-append
			assert.deepStrictEqual(unionArrays([{ host: 'a', port: 1 }], [{ port: 1, host: 'a' }]), [{ host: 'a', port: 1 }]);
		});
	});

	describe('stableStringify (unit)', function () {
		it('always returns a string, even for undefined', function () {
			assert.strictEqual(stableStringify(undefined), 'null');
			assert.strictEqual(stableStringify(null), 'null');
		});

		it('sorts object keys so property order does not affect the result', function () {
			assert.strictEqual(stableStringify({ b: 1, a: 2 }), stableStringify({ a: 2, b: 1 }));
		});

		it('omits undefined-valued properties (matches JSON.stringify)', function () {
			assert.strictEqual(stableStringify({ a: 1, b: undefined }), '{"a":1}');
		});

		it('honors toJSON (Date) instead of serializing it as {}', function () {
			const d = new Date('2026-06-09T00:00:00.000Z');
			assert.strictEqual(stableStringify(d), JSON.stringify(d.toJSON()));
			// two equal Dates dedupe under $union; two different Dates do not
			assert.deepStrictEqual(
				unionArrays([new Date('2026-01-01T00:00:00Z')], [new Date('2026-01-01T00:00:00Z')]).length,
				1
			);
			assert.deepStrictEqual(
				unionArrays([new Date('2026-01-01T00:00:00Z')], [new Date('2026-02-01T00:00:00Z')]).length,
				2
			);
		});
	});

	describe('directive recognition', function () {
		it('isDirectiveObject is true only for supported directive keys', function () {
			assert.equal(isDirectiveObject({ $union: [] }), true);
			assert.equal(isDirectiveObject({ uses: [] }), false);
			assert.equal(isDirectiveObject(['a']), false);
			assert.equal(isDirectiveObject('a'), false);
			assert.equal(isDirectiveObject({}), false);
			// unsupported $-keys are NOT directives (e.g. JSON Schema keywords in component config)
			assert.equal(isDirectiveObject({ $schema: 'https://json-schema.org/draft/2020-12/schema' }), false);
			assert.equal(isDirectiveObject({ $append: ['x'] }), false);
		});

		it('flattenObject treats a directive as a leaf (does not recurse into $union)', function () {
			const flat = flattenObject({ tls: { uses: { $union: ['server'] } } });
			assert.deepStrictEqual(Object.keys(flat), ['tls.uses']);
			assert.deepStrictEqual(flat['tls.uses'], { $union: ['server'] });
		});
	});

	describe('under HARPER_SET_CONFIG', function () {
		it('adds listed items to an existing array, order-preserving (existing then listed)', function () {
			process.env.HARPER_SET_CONFIG = JSON.stringify({ tls: { uses: { $union: ['server', 'operations-api'] } } });
			const fileConfig = { tls: { uses: ['app-cert'] } };

			applyRuntimeEnvConfig(fileConfig, testRoot);

			assert.deepStrictEqual(fileConfig.tls.uses, ['app-cert', 'server', 'operations-api']);
		});

		it('produces just the listed items when no array exists yet', function () {
			process.env.HARPER_SET_CONFIG = JSON.stringify({ tls: { uses: { $union: ['server'] } } });
			const fileConfig = {};

			applyRuntimeEnvConfig(fileConfig, testRoot);

			assert.deepStrictEqual(fileConfig.tls.uses, ['server']);
		});

		it('is idempotent across repeated boots (no duplicates)', function () {
			process.env.HARPER_SET_CONFIG = JSON.stringify({ tls: { uses: { $union: ['server', 'operations-api'] } } });
			const fileConfig = { tls: { uses: ['app-cert'] } };

			applyRuntimeEnvConfig(fileConfig, testRoot);
			applyRuntimeEnvConfig(fileConfig, testRoot);
			applyRuntimeEnvConfig(fileConfig, testRoot);

			assert.deepStrictEqual(fileConfig.tls.uses, ['app-cert', 'server', 'operations-api']);
		});

		it('never deletes unnamed entries — app additions survive the force/drift path', function () {
			process.env.HARPER_SET_CONFIG = JSON.stringify({ tls: { uses: { $union: ['server'] } } });
			const fileConfig = { tls: { uses: ['app-cert'] } };

			applyRuntimeEnvConfig(fileConfig, testRoot);
			assert.deepStrictEqual(fileConfig.tls.uses, ['app-cert', 'server']);

			// App/user adds its own entry (drift relative to the env-var snapshot)
			fileConfig.tls.uses.push('app-extra');

			// Same env var re-applied: $union must keep the drifted 'app-extra' AND 'app-cert'
			applyRuntimeEnvConfig(fileConfig, testRoot);
			assert.deepStrictEqual(fileConfig.tls.uses, ['app-cert', 'server', 'app-extra']);
		});

		it('grows the union and keeps app entries when the directive list changes between boots', function () {
			// Boot 1: forces 'server'
			process.env.HARPER_SET_CONFIG = JSON.stringify({ tls: { uses: { $union: ['server'] } } });
			const fileConfig = { tls: { uses: ['app-cert'] } };
			applyRuntimeEnvConfig(fileConfig, testRoot);
			assert.deepStrictEqual(fileConfig.tls.uses, ['app-cert', 'server']);

			// Boot 2: directive list changes (hash differs → exercises the deletion/diff path)
			process.env.HARPER_SET_CONFIG = JSON.stringify({ tls: { uses: { $union: ['server', 'operations-api'] } } });
			applyRuntimeEnvConfig(fileConfig, testRoot);

			// app-cert (unnamed) survives the deletion path; the new member is added
			assert.deepStrictEqual(fileConfig.tls.uses, ['app-cert', 'server', 'operations-api']);
		});

		it('still replaces wholesale for a bare array (unchanged default)', function () {
			process.env.HARPER_SET_CONFIG = JSON.stringify({ tls: { uses: ['server', 'operations-api'] } });
			const fileConfig = { tls: { uses: ['app-cert'] } };

			applyRuntimeEnvConfig(fileConfig, testRoot);

			assert.deepStrictEqual(fileConfig.tls.uses, ['server', 'operations-api']);
		});
	});

	describe('under HARPER_DEFAULT_CONFIG', function () {
		it('honors $union at install time', function () {
			process.env.HARPER_DEFAULT_CONFIG = JSON.stringify({ tls: { uses: { $union: ['server'] } } });
			const fileConfig = { tls: { uses: ['app-cert'] } };

			applyRuntimeEnvConfig(fileConfig, testRoot, { isInstall: true });

			assert.deepStrictEqual(fileConfig.tls.uses, ['app-cert', 'server']);
		});

		it('does not union into an un-sourced array at runtime (DEFAULT no-op contract)', function () {
			// Runtime (not install) + an existing array DEFAULT never set → DEFAULT yields, union no-ops.
			process.env.HARPER_DEFAULT_CONFIG = JSON.stringify({ tls: { uses: { $union: ['server'] } } });
			const fileConfig = { tls: { uses: ['app-cert'] } };

			applyRuntimeEnvConfig(fileConfig, testRoot);

			assert.deepStrictEqual(
				fileConfig.tls.uses,
				['app-cert'],
				'runtime DEFAULT must not compose into an un-sourced array'
			);
		});

		it('re-applies $union idempotently at runtime on a DEFAULT-sourced path', function () {
			// Install sources the path via DEFAULT...
			process.env.HARPER_DEFAULT_CONFIG = JSON.stringify({ tls: { uses: { $union: ['server'] } } });
			const fileConfig = { tls: { uses: ['app-cert'] } };
			applyRuntimeEnvConfig(fileConfig, testRoot, { isInstall: true });
			assert.deepStrictEqual(fileConfig.tls.uses, ['app-cert', 'server']);

			// ...so a later runtime boot re-applies the directive (no-op) on that DEFAULT-sourced path,
			// and a grown list composes rather than no-ops.
			applyRuntimeEnvConfig(fileConfig, testRoot);
			assert.deepStrictEqual(fileConfig.tls.uses, ['app-cert', 'server'], 'idempotent runtime re-apply');

			process.env.HARPER_DEFAULT_CONFIG = JSON.stringify({ tls: { uses: { $union: ['server', 'operations-api'] } } });
			applyRuntimeEnvConfig(fileConfig, testRoot);
			assert.deepStrictEqual(
				fileConfig.tls.uses,
				['app-cert', 'server', 'operations-api'],
				'runtime compose on a DEFAULT-sourced path'
			);
		});
	});

	describe('composeConfigFromEnv', function () {
		it('accumulates $union across DEFAULT and SET layers', function () {
			process.env.HARPER_DEFAULT_CONFIG = JSON.stringify({ tls: { uses: { $union: ['default-cert'] } } });
			process.env.HARPER_SET_CONFIG = JSON.stringify({ tls: { uses: { $union: ['server'] } } });

			const result = composeConfigFromEnv();

			assert.deepStrictEqual(result.tls.uses, ['default-cert', 'server']);
		});

		it('unions a SET $union onto a base array', function () {
			process.env.HARPER_SET_CONFIG = JSON.stringify({ tls: { uses: { $union: ['server'] } } });

			const result = composeConfigFromEnv({ tls: { uses: ['app-cert'] } });

			assert.deepStrictEqual(result.tls.uses, ['app-cert', 'server']);
		});
	});

	describe('filterArgsAgainstRuntimeConfig', function () {
		it('filters the array path (treats the directive as a single leaf, not _$union)', function () {
			process.env.HARPER_SET_CONFIG = JSON.stringify({ tls: { uses: { $union: ['server'] } } });

			const filtered = filterArgsAgainstRuntimeConfig({ tls_uses: 'x', rootpath: '/y' });

			assert.deepStrictEqual(filtered, { rootpath: '/y' });
		});
	});

	describe('malformed directives throw', function () {
		it('rejects a non-array $union value', function () {
			process.env.HARPER_SET_CONFIG = JSON.stringify({ tls: { uses: { $union: 'server' } } });
			assert.throws(() => applyRuntimeEnvConfig({}, testRoot), /requires an array value/);
		});

		it('passes unsupported $-keys through as plain config (forward/JSON-Schema compatibility)', function () {
			// e.g. a component config embedding a JSON Schema — must keep flattening and applying,
			// not throw at boot (root config is forward-compatible; app config allows arbitrary keys)
			process.env.HARPER_SET_CONFIG = JSON.stringify({
				'my-app': { schema: { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object' } },
			});
			const fileConfig = {};

			applyRuntimeEnvConfig(fileConfig, testRoot);

			assert.strictEqual(fileConfig['my-app'].schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
			assert.strictEqual(fileConfig['my-app'].schema.type, 'object');
		});

		it('rejects a directive mixed with other keys', function () {
			process.env.HARPER_SET_CONFIG = JSON.stringify({ tls: { uses: { $union: ['server'], extra: 1 } } });
			assert.throws(() => applyRuntimeEnvConfig({}, testRoot), /must be the only key/);
		});
	});
});
