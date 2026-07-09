'use strict';

/**
 * End-to-end pipeline tests for the new SQL engine, phase 1.
 *
 * These tests bypass the real Resource API by overriding the binder's
 * databases loader with a mock table that records the search target it
 * receives and yields a fixed set of rows. This exercises the full
 * normalize -> bind -> build -> optimize -> physical -> execute pipeline
 * without depending on LMDB/RocksDB.
 */

const assert = require('assert');
const alasql = require('alasql');

const router = require('#src/sqlEngine/router');
const binder = require('#src/sqlEngine/binder/bind');
const { EngineUnsupportedError } = require('#src/sqlEngine/errors');

function makeMockTable({ primaryKey = 'id', attributes = [], rows = [] } = {}) {
	const indexed = new Set(attributes.filter((a) => a.indexed).map((a) => a.name));
	indexed.add(primaryKey);
	const table = {
		primaryKey,
		attributes: attributes.map((a) => ({ name: a.name, indexed: !!a.indexed })),
		indices: Object.fromEntries(attributes.filter((a) => a.indexed).map((a) => [a.name, true])),
		_lastTarget: null,
		async *search(target) {
			table._lastTarget = target;
			let result = [...rows];
			if (Array.isArray(target.conditions) && target.conditions.length > 0) {
				result = result.filter((row) => evalConditions(row, target.conditions, target.operator || 'and'));
			}
			if (target.sort) {
				const { attribute, descending } = target.sort;
				result.sort((a, b) => {
					const av = a[attribute];
					const bv = b[attribute];
					const cmp = av < bv ? -1 : av > bv ? 1 : 0;
					return descending ? -cmp : cmp;
				});
			}
			if (target.offset) result = result.slice(target.offset);
			if (target.limit != null) result = result.slice(0, target.limit);
			for (const row of result) {
				if (target.select) {
					const out = {};
					for (const k of target.select) out[k] = row[k];
					yield out;
				} else {
					yield row;
				}
			}
		},
	};
	return table;
}

function evalConditions(row, conditions, operator) {
	const fn = operator === 'or' ? 'some' : 'every';
	return conditions[fn]((c) => evalCondition(row, c));
}

function evalCondition(row, c) {
	if (c.conditions) return evalConditions(row, c.conditions, c.operator || 'and');
	const v = row[c.attribute];
	switch (c.comparator) {
		case 'equals':
			return v === c.value;
		case 'ne':
			return v !== c.value;
		case 'lt':
			return v < c.value;
		case 'le':
			return v <= c.value;
		case 'gt':
			return v > c.value;
		case 'ge':
			return v >= c.value;
		case 'between':
			return v >= c.value[0] && v <= c.value[1];
		case 'starts_with':
			return typeof v === 'string' && v.startsWith(c.value);
		case 'ends_with':
			return typeof v === 'string' && v.endsWith(c.value);
		case 'contains':
			return typeof v === 'string' && v.includes(c.value);
		default:
			return false;
	}
}

function runSql(sql) {
	return new Promise((resolve, reject) => {
		const parsed = alasql.parse(sql);
		const variant = sql.trim().split(/\s+/)[0].toLowerCase();
		router.route(
			{
				variant,
				jsonMessage: { hdb_user: { username: 'test' }, bypass_auth: true },
				statement: parsed.statements[0],
				legacy: () => reject(new Error('legacy fallback should not be invoked')),
			},
			(err, data) => (err ? reject(err) : resolve(data))
		);
	});
}

describe('sqlEngine phase 1: SELECT pipeline', () => {
	let originalEngine;
	let mockTable;

	beforeEach(() => {
		originalEngine = process.env.HARPER_SQL_ENGINE;
		process.env.HARPER_SQL_ENGINE = 'new';
		mockTable = makeMockTable({
			primaryKey: 'id',
			attributes: [
				{ name: 'id', indexed: true },
				{ name: 'name', indexed: true },
				{ name: 'age', indexed: true },
				{ name: 'city', indexed: false },
			],
			rows: [
				{ id: 1, name: 'alice', age: 30, city: 'denver' },
				{ id: 2, name: 'bob', age: 25, city: 'austin' },
				{ id: 3, name: 'carol', age: 40, city: 'denver' },
				{ id: 4, name: 'dave', age: 35, city: 'austin' },
			],
		});
		binder._setDatabasesLoader(() => ({ dev: { user: mockTable } }));
	});

	afterEach(() => {
		if (originalEngine === undefined) delete process.env.HARPER_SQL_ENGINE;
		else process.env.HARPER_SQL_ENGINE = originalEngine;
		binder._setDatabasesLoader(null);
	});

	it('SELECT * with WHERE id = literal returns matching row', async () => {
		const data = await runSql('SELECT * FROM dev.user WHERE id = 2');
		assert.deepStrictEqual(data, [{ id: 2, name: 'bob', age: 25, city: 'austin' }]);
		assert.strictEqual(mockTable._lastTarget.allowFullScan, false);
		assert.deepStrictEqual(mockTable._lastTarget.conditions, [{ attribute: 'id', comparator: 'equals', value: 2 }]);
	});

	it('SELECT projection only fetches requested columns', async () => {
		const data = await runSql('SELECT name FROM dev.user WHERE id = 1');
		assert.deepStrictEqual(data, [{ name: 'alice' }]);
		assert.deepStrictEqual(mockTable._lastTarget.select.sort(), ['id', 'name']);
	});

	it('AND in WHERE pushes conjuncts as separate conditions', async () => {
		const data = await runSql('SELECT name FROM dev.user WHERE age >= 30 AND age <= 35');
		const names = data.map((r) => r.name).sort();
		assert.deepStrictEqual(names, ['alice', 'dave']);
		const conds = mockTable._lastTarget.conditions.map((c) => c.comparator).sort();
		assert.deepStrictEqual(conds, ['ge', 'le']);
	});

	it('IN list becomes an OR group of equals conditions', async () => {
		const data = await runSql('SELECT name FROM dev.user WHERE id IN (1, 3)');
		const names = data.map((r) => r.name).sort();
		assert.deepStrictEqual(names, ['alice', 'carol']);
	});

	it('IN coerces quoted-numeric literals to match numeric values (legacy loose IN)', async () => {
		// Mock table matches strictly (===), so the row only matches because the
		// engine expands '1'/'3' to include their numeric forms.
		const data = await runSql("SELECT name FROM dev.user WHERE id IN ('1', '3')");
		const names = data.map((r) => r.name).sort();
		assert.deepStrictEqual(names, ['alice', 'carol']);
		// Each quoted numeric pushes both the string and number form.
		const idEquals = mockTable._lastTarget.conditions[0].conditions
			.filter((c) => c.attribute === 'id' && c.comparator === 'equals')
			.map((c) => c.value);
		assert.deepStrictEqual(idEquals, ['1', 1, '3', 3]);
	});

	it('= coerces a quoted boolean literal to match a boolean column (legacy coercion)', async () => {
		// Mock matches strictly (===), so a `false` row only matches because the
		// engine expands 'false' to include the real boolean.
		const boolTable = makeMockTable({
			primaryKey: 'id',
			attributes: [
				{ name: 'id', indexed: true },
				{ name: 'active', indexed: true },
			],
			rows: [
				{ id: 1, active: true },
				{ id: 2, active: false },
				{ id: 3, active: true },
				{ id: 4, active: null },
			],
		});
		binder._setDatabasesLoader(() => ({ dev: { user: boolTable } }));
		const data = await runSql("SELECT id FROM dev.user WHERE active = 'false'");
		assert.deepStrictEqual(
			data.map((r) => r.id),
			[2]
		);
		// Expanded into an OR over the string and boolean forms.
		assert.deepStrictEqual(boolTable._lastTarget.conditions[0], {
			conditions: [
				{ attribute: 'active', comparator: 'equals', value: 'false' },
				{ attribute: 'active', comparator: 'equals', value: false },
			],
			operator: 'or',
		});
	});

	it('!= coerces a quoted boolean AND excludes NULLs (SQL three-valued logic)', async () => {
		const boolTable = makeMockTable({
			primaryKey: 'id',
			attributes: [
				{ name: 'id', indexed: true },
				{ name: 'active', indexed: true },
			],
			rows: [
				{ id: 1, active: true },
				{ id: 2, active: false },
				{ id: 3, active: true },
				{ id: 4, active: null },
			],
		});
		binder._setDatabasesLoader(() => ({ dev: { user: boolTable } }));
		// id > 0 drives the scan; `active != 'false'` rides as a filter. The NULL
		// row (id 4) must be excluded, like legacy — only the `true` rows remain.
		const data = await runSql("SELECT id FROM dev.user WHERE id > 0 AND active != 'false'");
		assert.deepStrictEqual(data.map((r) => r.id).sort(), [1, 3]);
		// The active condition is an AND of: ne 'false', ne false, and a not-null guard.
		const activeCond = boolTable._lastTarget.conditions.find((c) => c.conditions);
		assert.deepStrictEqual(activeCond, {
			conditions: [
				{ attribute: 'active', comparator: 'ne', value: 'false' },
				{ attribute: 'active', comparator: 'ne', value: false },
				{ attribute: 'active', comparator: 'ne', value: null },
			],
			operator: 'and',
		});
	});

	it('= with a quoted number stays strict (no numeric coercion, unlike IN)', async () => {
		// Legacy returns nothing for `age = '30'` (numeric column, quoted literal);
		// the new engine must too — the boolean expansion must not loosen numeric `=`.
		const data = await runSql("SELECT name FROM dev.user WHERE age = '30'");
		assert.deepStrictEqual(data, []);
		assert.deepStrictEqual(mockTable._lastTarget.conditions, [{ attribute: 'age', comparator: 'equals', value: '30' }]);
	});

	it('BETWEEN maps to between comparator', async () => {
		const data = await runSql('SELECT name FROM dev.user WHERE age BETWEEN 30 AND 40');
		const names = data.map((r) => r.name).sort();
		assert.deepStrictEqual(names, ['alice', 'carol', 'dave']);
		assert.deepStrictEqual(mockTable._lastTarget.conditions[0], {
			attribute: 'age',
			comparator: 'between',
			value: [30, 40],
		});
	});

	it('LIKE prefix maps to starts_with', async () => {
		const data = await runSql("SELECT name FROM dev.user WHERE name LIKE 'a%'");
		const names = data.map((r) => r.name).sort();
		assert.deepStrictEqual(names, ['alice']);
		assert.deepStrictEqual(mockTable._lastTarget.conditions[0], {
			attribute: 'name',
			comparator: 'starts_with',
			value: 'a',
		});
	});

	// ends_with / contains can't be served by an index (suffix/substring → full
	// scan), so they must be combined with an index-driving condition; standalone
	// they are rejected (see below). Here `id > 0` drives the scan and the LIKE
	// rides along as a pushed filter.
	it('LIKE suffix maps to ends_with (combined with an index driver)', async () => {
		const data = await runSql("SELECT name FROM dev.user WHERE id > 0 AND name LIKE '%e'");
		const names = data.map((r) => r.name).sort();
		assert.deepStrictEqual(names, ['alice', 'dave']);
		const comparators = mockTable._lastTarget.conditions.map((c) => c.comparator);
		assert.ok(comparators.includes('ends_with'));
	});

	it('LIKE both ends maps to contains (combined with an index driver)', async () => {
		const data = await runSql("SELECT name FROM dev.user WHERE id > 0 AND name LIKE '%a%'");
		const names = data.map((r) => r.name).sort();
		assert.deepStrictEqual(names, ['alice', 'carol', 'dave']);
		const comparators = mockTable._lastTarget.conditions.map((c) => c.comparator);
		assert.ok(comparators.includes('contains'));
	});

	it('rejects a standalone ends_with/contains even on an indexed attribute (full scan)', async () => {
		// `name` is indexed, but suffix/substring match can't seek the index, so
		// Table.search would 403; the engine must reject (→ legacy fallback) instead.
		await assert.rejects(() => runSql("SELECT name FROM dev.user WHERE name LIKE '%e'"), EngineUnsupportedError);
		await assert.rejects(() => runSql("SELECT name FROM dev.user WHERE name LIKE '%a%'"), EngineUnsupportedError);
	});

	it('ORDER BY indexed column pushes sort to Table.search', async () => {
		const data = await runSql('SELECT name FROM dev.user WHERE age > 0 ORDER BY age DESC');
		assert.deepStrictEqual(
			data.map((r) => r.name),
			['carol', 'dave', 'alice', 'bob']
		);
		assert.deepStrictEqual(mockTable._lastTarget.sort, { attribute: 'age', descending: true });
	});

	it('LIMIT and OFFSET get pushed to Table.search', async () => {
		const data = await runSql('SELECT name FROM dev.user WHERE age > 0 ORDER BY age LIMIT 2 OFFSET 1');
		assert.deepStrictEqual(
			data.map((r) => r.name),
			['alice', 'dave']
		);
		assert.strictEqual(mockTable._lastTarget.limit, 2);
		assert.strictEqual(mockTable._lastTarget.offset, 1);
	});

	it('does NOT push LIMIT into the scan when a residual filter remains', async () => {
		// `id > 0` is index-served, but `UPPER(city) = 'AUSTIN'` is a residual applied
		// after the scan. Pushing the limit into Table.search would cap rows *before*
		// the residual runs — silent under-fetch (here 0 rows instead of 1). The limit
		// must stay above the residual filter.
		const data = await runSql("SELECT name FROM dev.user WHERE id > 0 AND UPPER(city) = 'AUSTIN' LIMIT 1");
		assert.strictEqual(data.length, 1);
		assert.strictEqual(data[0].name, 'bob');
		assert.strictEqual(mockTable._lastTarget.limit, undefined);
	});

	it('rejects a no-WHERE ORDER BY (full ordered scan) without allowFullScan', async () => {
		// A pushed sort with no index-driving condition is a full table scan; the
		// engine must reject (→ legacy fallback), not emit an empty `and` group that
		// Table.search throws on.
		await assert.rejects(() => runSql('SELECT name FROM dev.user ORDER BY name'), EngineUnsupportedError);
	});

	it('rejects unindexed-only WHERE without allowFullScan', async () => {
		await assert.rejects(() => runSql("SELECT * FROM dev.user WHERE city = 'denver'"), EngineUnsupportedError);
	});

	it('rejects GROUP BY aggregate with no usable index condition (allowFullScan=false)', async () => {
		await assert.rejects(() => runSql('SELECT city, COUNT(*) FROM dev.user GROUP BY city'), EngineUnsupportedError);
	});

	it('residual filter applies in-memory when condition cannot be pushed', async () => {
		const data = await runSql("SELECT name FROM dev.user WHERE id > 0 AND UPPER(name) = 'BOB'");
		assert.deepStrictEqual(
			data.map((r) => r.name),
			['bob']
		);
	});

	it('NOT IN excludes NULL rows (IS NOT NULL guard, legacy 3VL parity)', async () => {
		const table = makeMockTable({
			primaryKey: 'id',
			attributes: [
				{ name: 'id', indexed: true },
				{ name: 'age', indexed: true },
			],
			rows: [
				{ id: 1, age: 30 },
				{ id: 2, age: 25 },
				{ id: 3, age: null }, // NULL: excluded by NOT IN under SQL 3VL
			],
		});
		binder._setDatabasesLoader(() => ({ dev: { user: table } }));
		// `age NOT IN (25)` ANDed with an indexed conjunct runs on the new engine (no
		// fallback). A NULL age yields UNKNOWN → excluded, matching legacy AlaSQL —
		// without the guard the new engine would return id 3 (silent divergence).
		const data = await runSql('SELECT id FROM dev.user WHERE id > 0 AND age NOT IN (25)');
		assert.deepStrictEqual(data.map((r) => r.id).sort(), [1]);
	});
});
