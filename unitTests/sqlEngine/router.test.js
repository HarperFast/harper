'use strict';

/**
 * Tests for the SQL engine router.
 *
 * The router selects between the legacy AlaSQL-based path and the new
 * Resource-API-based path based on the sql.engine config flag (env var
 * HARPER_SQL_ENGINE). Phase 0 only verifies dispatch behavior — the new
 * engine has no statements implemented yet, so 'new' mode always rejects and
 * 'auto' mode always falls back.
 */

const assert = require('assert');
const sinon = require('sinon');

const router = require('#src/sqlEngine/router');
const config = require('#src/sqlEngine/config');
const configUtils = require('#src/config/configUtils');
const { CONFIG_PARAMS } = require('#src/utility/hdbTerms');
const { EngineUnsupportedError } = require('#src/sqlEngine/errors');

describe('sqlEngine router', () => {
	let originalEngine;

	beforeEach(() => {
		originalEngine = process.env.HARPER_SQL_ENGINE;
		delete process.env.HARPER_SQL_ENGINE;
	});

	afterEach(() => {
		if (originalEngine === undefined) delete process.env.HARPER_SQL_ENGINE;
		else process.env.HARPER_SQL_ENGINE = originalEngine;
	});

	it('defaults to auto mode (phase-5 cutover)', () => {
		const cfg = config.getSqlEngineConfig();
		assert.strictEqual(cfg.engine, 'auto');
	});

	it('reads HARPER_SQL_ENGINE env var', () => {
		process.env.HARPER_SQL_ENGINE = 'new';
		assert.strictEqual(config.getSqlEngineConfig().engine, 'new');
		process.env.HARPER_SQL_ENGINE = 'auto';
		assert.strictEqual(config.getSqlEngineConfig().engine, 'auto');
		process.env.HARPER_SQL_ENGINE = 'legacy';
		assert.strictEqual(config.getSqlEngineConfig().engine, 'legacy');
	});

	it('ignores unknown env values', () => {
		process.env.HARPER_SQL_ENGINE = 'gibberish';
		assert.strictEqual(config.getSqlEngineConfig().engine, 'auto');
	});

	it('routes to legacy handler when engine=legacy', (done) => {
		process.env.HARPER_SQL_ENGINE = 'legacy';
		const legacy = sinon.stub().callsArgWith(1, null, 'legacy-result');
		router.route(
			{
				variant: 'select',
				jsonMessage: { hdb_user: {} },
				statement: { fake: 'ast' },
				legacy,
			},
			(err, data) => {
				assert.ifError(err);
				assert.strictEqual(data, 'legacy-result');
				assert.strictEqual(legacy.callCount, 1);
				done();
			}
		);
	});

	it('falls back to legacy on EngineUnsupportedError when engine=auto', (done) => {
		process.env.HARPER_SQL_ENGINE = 'auto';
		const legacy = sinon.stub().callsArgWith(1, null, 'fallback-result');
		router.route(
			{
				variant: 'select',
				jsonMessage: { hdb_user: {} },
				statement: { fake: 'ast' },
				legacy,
			},
			(err, data) => {
				assert.ifError(err);
				assert.strictEqual(data, 'fallback-result');
				assert.strictEqual(legacy.callCount, 1);
				done();
			}
		);
	});

	it('propagates EngineUnsupportedError when engine=new', (done) => {
		process.env.HARPER_SQL_ENGINE = 'new';
		const legacy = sinon.stub().callsArgWith(1, null, 'should-not-call');
		router.route(
			{
				variant: 'select',
				jsonMessage: { hdb_user: {} },
				statement: { fake: 'ast' },
				legacy,
			},
			(err, data) => {
				assert.ok(err instanceof EngineUnsupportedError, `expected EngineUnsupportedError, got ${err}`);
				assert.strictEqual(data, undefined);
				assert.strictEqual(legacy.callCount, 0);
				done();
			}
		);
	});

	it('propagates legacy errors when engine=legacy', (done) => {
		process.env.HARPER_SQL_ENGINE = 'legacy';
		const legacyErr = new Error('legacy boom');
		const legacy = sinon.stub().callsArgWith(1, legacyErr);
		router.route(
			{
				variant: 'select',
				jsonMessage: { hdb_user: {} },
				statement: { fake: 'ast' },
				legacy,
			},
			(err) => {
				assert.strictEqual(err, legacyErr);
				done();
			}
		);
	});
});

describe('sqlEngine config: harper config integration', () => {
	afterEach(() => {
		// Reset every key back to "unset" so it doesn't leak into other test files —
		// configUtils' in-memory config is process-wide (module singleton), shared by
		// every unit test file mocha loads in this run.
		configUtils.updateConfigObject(CONFIG_PARAMS.SQL_ENGINE, undefined);
		configUtils.updateConfigObject(CONFIG_PARAMS.SQL_ALLOWFULLSCAN, undefined);
		configUtils.updateConfigObject(CONFIG_PARAMS.SQL_MAXSORTROWS, undefined);
		configUtils.updateConfigObject(CONFIG_PARAMS.SQL_MAXHASHROWS, undefined);
	});

	it('reads sql.engine from Harper config when no env var is set', () => {
		configUtils.updateConfigObject(CONFIG_PARAMS.SQL_ENGINE, 'legacy');
		assert.strictEqual(config.getSqlEngineConfig().engine, 'legacy');
	});

	it('HARPER_SQL_ENGINE env var still takes precedence over sql.engine config', () => {
		const originalEngine = process.env.HARPER_SQL_ENGINE;
		configUtils.updateConfigObject(CONFIG_PARAMS.SQL_ENGINE, 'legacy');
		process.env.HARPER_SQL_ENGINE = 'new';
		try {
			assert.strictEqual(config.getSqlEngineConfig().engine, 'new');
		} finally {
			if (originalEngine === undefined) delete process.env.HARPER_SQL_ENGINE;
			else process.env.HARPER_SQL_ENGINE = originalEngine;
		}
	});

	it('reads sql.allowFullScan from Harper config (default is false)', () => {
		assert.strictEqual(config.getSqlEngineConfig().allowFullScan, false);
		configUtils.updateConfigObject(CONFIG_PARAMS.SQL_ALLOWFULLSCAN, true);
		assert.strictEqual(config.getSqlEngineConfig().allowFullScan, true);
	});

	it('reads sql.maxSortRows from Harper config (default is 1_000_000)', () => {
		assert.strictEqual(config.getSqlEngineConfig().maxSortRows, 1_000_000);
		configUtils.updateConfigObject(CONFIG_PARAMS.SQL_MAXSORTROWS, 42);
		assert.strictEqual(config.getSqlEngineConfig().maxSortRows, 42);
	});

	it('reads sql.maxHashRows from Harper config (default is 1_000_000)', () => {
		assert.strictEqual(config.getSqlEngineConfig().maxHashRows, 1_000_000);
		configUtils.updateConfigObject(CONFIG_PARAMS.SQL_MAXHASHROWS, 7);
		assert.strictEqual(config.getSqlEngineConfig().maxHashRows, 7);
	});
});
