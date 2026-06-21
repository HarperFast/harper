'use strict';

/**
 * End-to-end pipeline tests for the new SQL engine, phase 2: aggregates.
 *
 * Sets globalThis.harperConfig.sql.allowFullScan = true so the mock table
 * does not require an indexed WHERE condition (aggregate queries legitimately
 * scan all rows).
 */

const assert = require('assert');
const alasql = require('alasql');

const router = require('#src/sqlEngine/router');
const binder = require('#src/sqlEngine/binder/bind');

function makeMockTable({ primaryKey = 'id', attributes = [], rows = [] } = {}) {
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
	return conditions[fn]((c) => {
		if (c.conditions) return evalConditions(row, c.conditions, c.operator || 'and');
		const v = row[c.attribute];
		if (c.comparator === 'equals') return v === c.value;
		return false;
	});
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

// ──────────────────────────────────────────────────────────────────────────
// Test data: orders with category, amount, status
//   electronics: 3 orders (status=active: 2, inactive: 1)  amounts: 100, 200, 150
//   clothing:    2 orders (status=active: 2)                 amounts: 80, 120
// ──────────────────────────────────────────────────────────────────────────
const ORDERS = [
	{ id: 1, category: 'electronics', amount: 100, status: 'active' },
	{ id: 2, category: 'electronics', amount: 200, status: 'active' },
	{ id: 3, category: 'electronics', amount: 150, status: 'inactive' },
	{ id: 4, category: 'clothing', amount: 80, status: 'active' },
	{ id: 5, category: 'clothing', amount: 120, status: 'active' },
];

describe('sqlEngine phase 2: aggregates', () => {
	let originalEngine;
	let savedHarperConfig;
	let mockTable;

	beforeEach(() => {
		originalEngine = process.env.HARPER_SQL_ENGINE;
		process.env.HARPER_SQL_ENGINE = 'new';

		// Allow full scans — aggregate queries legitimately read all rows.
		savedHarperConfig = globalThis.harperConfig;
		globalThis.harperConfig = { sql: { allowFullScan: true } };

		mockTable = makeMockTable({
			primaryKey: 'id',
			attributes: [
				{ name: 'id', indexed: true },
				{ name: 'category', indexed: true },
				{ name: 'amount', indexed: false },
				{ name: 'status', indexed: true },
			],
			rows: ORDERS,
		});
		binder._setDatabasesLoader(() => ({ dev: { orders: mockTable } }));
	});

	afterEach(() => {
		if (originalEngine === undefined) delete process.env.HARPER_SQL_ENGINE;
		else process.env.HARPER_SQL_ENGINE = originalEngine;
		globalThis.harperConfig = savedHarperConfig;
		binder._setDatabasesLoader(null);
	});

	it('COUNT(*) with no GROUP BY returns one row', async () => {
		const rows = await runSql('SELECT COUNT(*) AS cnt FROM dev.orders');
		assert.strictEqual(rows.length, 1);
		assert.strictEqual(rows[0].cnt, 5);
	});

	it('COUNT(*) on empty result set returns 0', async () => {
		const rows = await runSql("SELECT COUNT(*) AS cnt FROM dev.orders WHERE status = 'nonexistent'");
		assert.strictEqual(rows.length, 1);
		assert.strictEqual(rows[0].cnt, 0);
	});

	it('SUM and AVG with no GROUP BY', async () => {
		const rows = await runSql('SELECT SUM(amount) AS tot, AVG(amount) AS av FROM dev.orders');
		assert.strictEqual(rows.length, 1);
		assert.strictEqual(rows[0].tot, 650);
		assert.strictEqual(rows[0].av, 130);
	});

	it('MIN and MAX with no GROUP BY', async () => {
		const rows = await runSql('SELECT MIN(amount) AS lo, MAX(amount) AS hi FROM dev.orders');
		assert.strictEqual(rows.length, 1);
		assert.strictEqual(rows[0].lo, 80);
		assert.strictEqual(rows[0].hi, 200);
	});

	it('GROUP BY category with COUNT(*)', async () => {
		const rows = await runSql('SELECT category, COUNT(*) AS cnt FROM dev.orders GROUP BY category');
		assert.strictEqual(rows.length, 2);
		const byCategory = Object.fromEntries(rows.map((r) => [r.category, r.cnt]));
		assert.strictEqual(byCategory.electronics, 3);
		assert.strictEqual(byCategory.clothing, 2);
	});

	it('GROUP BY category with SUM', async () => {
		const rows = await runSql('SELECT category, SUM(amount) AS tot FROM dev.orders GROUP BY category');
		assert.strictEqual(rows.length, 2);
		const byCategory = Object.fromEntries(rows.map((r) => [r.category, r.tot]));
		assert.strictEqual(byCategory.electronics, 450);
		assert.strictEqual(byCategory.clothing, 200);
	});

	it('GROUP BY with WHERE clause pushdown', async () => {
		const rows = await runSql(
			"SELECT category, COUNT(*) AS cnt FROM dev.orders WHERE status = 'active' GROUP BY category"
		);
		assert.strictEqual(rows.length, 2);
		const byCategory = Object.fromEntries(rows.map((r) => [r.category, r.cnt]));
		assert.strictEqual(byCategory.electronics, 2);
		assert.strictEqual(byCategory.clothing, 2);
	});

	it('HAVING filters groups', async () => {
		const rows = await runSql('SELECT category, COUNT(*) AS cnt FROM dev.orders GROUP BY category HAVING COUNT(*) > 2');
		assert.strictEqual(rows.length, 1);
		assert.strictEqual(rows[0].category, 'electronics');
		assert.strictEqual(rows[0].cnt, 3);
	});

	it('multiple aggregates in one GROUP BY query', async () => {
		const rows = await runSql(
			'SELECT category, COUNT(*) AS cnt, SUM(amount) AS tot, MIN(amount) AS lo, MAX(amount) AS hi FROM dev.orders GROUP BY category'
		);
		assert.strictEqual(rows.length, 2);
		const elec = rows.find((r) => r.category === 'electronics');
		assert.ok(elec, 'electronics group missing');
		assert.strictEqual(elec.cnt, 3);
		assert.strictEqual(elec.tot, 450);
		assert.strictEqual(elec.lo, 100);
		assert.strictEqual(elec.hi, 200);
	});

	it('PROD aggregate', async () => {
		const rows = await runSql('SELECT PROD(id) AS p FROM dev.orders');
		assert.strictEqual(rows.length, 1);
		assert.strictEqual(rows[0].p, 1 * 2 * 3 * 4 * 5);
	});

	it('MEDIAN aggregate', async () => {
		const rows = await runSql('SELECT MEDIAN(amount) AS med FROM dev.orders');
		assert.strictEqual(rows.length, 1);
		// sorted amounts: 80, 100, 120, 150, 200  → median = 120
		assert.strictEqual(rows[0].med, 120);
	});

	it('MEAN is an alias for AVG', async () => {
		const rows = await runSql('SELECT MEAN(amount) AS mn FROM dev.orders');
		assert.strictEqual(rows.length, 1);
		assert.strictEqual(rows[0].mn, 130);
	});

	it('SELECT DISTINCT category returns unique values', async () => {
		const rows = await runSql('SELECT DISTINCT category FROM dev.orders');
		assert.strictEqual(rows.length, 2);
		const cats = rows.map((r) => r.category).sort();
		assert.deepStrictEqual(cats, ['clothing', 'electronics']);
	});

	it('ORDER BY aggregate result', async () => {
		const rows = await runSql(
			'SELECT category, COUNT(*) AS cnt FROM dev.orders GROUP BY category ORDER BY COUNT(*) DESC'
		);
		assert.strictEqual(rows.length, 2);
		assert.strictEqual(rows[0].category, 'electronics');
		assert.strictEqual(rows[1].category, 'clothing');
	});
});
