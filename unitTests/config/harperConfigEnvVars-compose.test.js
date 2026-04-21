'use strict';

const assert = require('node:assert/strict');
const { composeConfigFromEnv } = require('#src/config/harperConfigEnvVars');

describe('composeConfigFromEnv', function () {
	let originalDefault;
	let originalSet;

	beforeEach(function () {
		originalDefault = process.env.HARPER_DEFAULT_CONFIG;
		originalSet = process.env.HARPER_SET_CONFIG;
		delete process.env.HARPER_DEFAULT_CONFIG;
		delete process.env.HARPER_SET_CONFIG;
	});

	afterEach(function () {
		if (originalDefault !== undefined) process.env.HARPER_DEFAULT_CONFIG = originalDefault;
		else delete process.env.HARPER_DEFAULT_CONFIG;
		if (originalSet !== undefined) process.env.HARPER_SET_CONFIG = originalSet;
		else delete process.env.HARPER_SET_CONFIG;
	});

	it('returns an empty object when no env vars and no base are provided', function () {
		assert.deepStrictEqual(composeConfigFromEnv(), {});
	});

	it('returns a clone of base when no env vars are set', function () {
		const base = { replication: { hostname: 'base-host', port: 9933 }, logging: { level: 'error' } };

		const result = composeConfigFromEnv(base);

		assert.deepStrictEqual(result, base);
		assert.notStrictEqual(result, base, 'result should be a fresh object');
		assert.notStrictEqual(result.replication, base.replication, 'nested objects should be cloned');
	});

	it('does not mutate the base when env vars override values', function () {
		const base = { replication: { hostname: 'base-host' } };
		process.env.HARPER_SET_CONFIG = JSON.stringify({ replication: { hostname: 'set-host' } });

		composeConfigFromEnv(base);

		assert.strictEqual(base.replication.hostname, 'base-host');
	});

	it('layers HARPER_DEFAULT_CONFIG below the base (base wins on conflict, defaults fill gaps)', function () {
		process.env.HARPER_DEFAULT_CONFIG = JSON.stringify({ replication: { hostname: 'default-host', port: 9999 } });

		const result = composeConfigFromEnv({ replication: { hostname: 'base-host' } });

		assert.strictEqual(result.replication.hostname, 'base-host', 'base should win over DEFAULT');
		assert.strictEqual(result.replication.port, 9999, 'DEFAULT should fill in where base does not specify a value');
	});

	it('applies HARPER_SET_CONFIG on top of everything', function () {
		process.env.HARPER_DEFAULT_CONFIG = JSON.stringify({ replication: { hostname: 'default-host', port: 9999 } });
		process.env.HARPER_SET_CONFIG = JSON.stringify({ replication: { hostname: 'set-host' } });

		const result = composeConfigFromEnv({ replication: { hostname: 'base-host' } });

		assert.strictEqual(result.replication.hostname, 'set-host', 'SET should win over base and DEFAULT');
		assert.strictEqual(result.replication.port, 9999, 'DEFAULT value should survive when nothing else overrides it');
	});

	it('reads values set by HARPER_SET_CONFIG under a nested path', function () {
		process.env.HARPER_SET_CONFIG = JSON.stringify({
			replication: { hostname: 'node.example.com', port: 9933 },
			http: { port: 9925 },
		});

		const result = composeConfigFromEnv();

		assert.strictEqual(result.replication.hostname, 'node.example.com');
		assert.strictEqual(result.replication.port, 9933);
		assert.strictEqual(result.http.port, 9925);
	});

	it('treats an empty-string env var as unset', function () {
		process.env.HARPER_SET_CONFIG = '';
		process.env.HARPER_DEFAULT_CONFIG = '   ';

		const result = composeConfigFromEnv({ replication: { hostname: 'base-host' } });

		assert.strictEqual(result.replication.hostname, 'base-host');
	});

	it('throws when env var contains invalid JSON', function () {
		process.env.HARPER_SET_CONFIG = '{not json';

		assert.throws(() => composeConfigFromEnv(), /HARPER_SET_CONFIG/);
	});
});
