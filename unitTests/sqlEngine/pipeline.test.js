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
const config = require('#src/sqlEngine/config');
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

	it('LIKE suffix maps to ends_with', async () => {
		const data = await runSql("SELECT name FROM dev.user WHERE name LIKE '%e'");
		const names = data.map((r) => r.name).sort();
		assert.deepStrictEqual(names, ['alice', 'dave']);
		assert.strictEqual(mockTable._lastTarget.conditions[0].comparator, 'ends_with');
	});

	it('LIKE both ends maps to contains', async () => {
		const data = await runSql("SELECT name FROM dev.user WHERE name LIKE '%a%'");
		const names = data.map((r) => r.name).sort();
		assert.deepStrictEqual(names, ['alice', 'carol', 'dave']);
		assert.strictEqual(mockTable._lastTarget.conditions[0].comparator, 'contains');
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
});
