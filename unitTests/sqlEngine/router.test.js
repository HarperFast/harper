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
	// configUtils' in-memory config is process-wide, shared by every unit test file mocha loads
	// in this run — clear to a known state per test, restore whatever was there afterward.
	const SQL_KEYS = [
		CONFIG_PARAMS.SQL_ENGINE,
		CONFIG_PARAMS.SQL_ALLOWFULLSCAN,
		CONFIG_PARAMS.SQL_MAXSORTROWS,
		CONFIG_PARAMS.SQL_MAXHASHROWS,
	];
	let originalValues;

	beforeEach(() => {
		originalValues = SQL_KEYS.map((key) => configUtils.getConfigValue(key));
		// Clear to a known-unset state so a default-value assertion below can't go red on a
		// machine whose own harper-config.yaml happens to set one of these already.
		SQL_KEYS.forEach((key) => configUtils.updateConfigObject(key, undefined));
	});

	afterEach(() => {
		SQL_KEYS.forEach((key, i) => configUtils.updateConfigObject(key, originalValues[i]));
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

	it('ignores an unknown sql.engine value and falls back to the default', () => {
		configUtils.updateConfigObject(CONFIG_PARAMS.SQL_ENGINE, 'gibberish');
		assert.strictEqual(config.getSqlEngineConfig().engine, 'auto');
	});

	it('ignores a wrong-typed sql.allowFullScan value and falls back to the default', () => {
		configUtils.updateConfigObject(CONFIG_PARAMS.SQL_ALLOWFULLSCAN, 'true');
		assert.strictEqual(config.getSqlEngineConfig().allowFullScan, false);
	});

	it('ignores wrong-typed sql.maxSortRows/maxHashRows values and falls back to the defaults', () => {
		configUtils.updateConfigObject(CONFIG_PARAMS.SQL_MAXSORTROWS, 'unlimited');
		configUtils.updateConfigObject(CONFIG_PARAMS.SQL_MAXHASHROWS, 'unlimited');
		const cfg = config.getSqlEngineConfig();
		assert.strictEqual(cfg.maxSortRows, 1_000_000);
		assert.strictEqual(cfg.maxHashRows, 1_000_000);
	});

	// The tests above inject through updateConfigObject(), which writes flatConfigObj directly
	// and never exercises flattenConfig()'s nested-to-flat key derivation a real boot goes
	// through — cover that derivation here instead of needing a full config-file fixture.
	it('flattenConfig() derives the four flat sql.* keys from a nested sql block', () => {
		const flat = configUtils.flattenConfig({
			sql: { engine: 'legacy', allowFullScan: true, maxSortRows: 5, maxHashRows: 7 },
		});
		assert.strictEqual(flat[CONFIG_PARAMS.SQL_ENGINE.toLowerCase()], 'legacy');
		assert.strictEqual(flat[CONFIG_PARAMS.SQL_ALLOWFULLSCAN.toLowerCase()], true);
		assert.strictEqual(flat[CONFIG_PARAMS.SQL_MAXSORTROWS.toLowerCase()], 5);
		assert.strictEqual(flat[CONFIG_PARAMS.SQL_MAXHASHROWS.toLowerCase()], 7);
	});
});
