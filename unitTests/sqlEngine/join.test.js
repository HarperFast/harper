'use strict';

/**
 * Phase 3 join pipeline tests for the new SQL engine.
 *
 * Like pipeline.test.js, these bypass the real Resource API with mock tables
 * that record the search target(s) they receive and yield fixed rows, then run
 * SQL through the full normalize -> bind -> build -> optimize -> physical ->
 * execute pipeline. allowFullScan is enabled by default here so every join
 * strategy can be exercised; dedicated tests cover the no-full-scan policy.
 */

const assert = require('assert');
const alasql = require('alasql');

const router = require('#src/sqlEngine/router');
const binder = require('#src/sqlEngine/binder/bind');
const { EngineUnsupportedError } = require('#src/sqlEngine/errors');

function makeMockTable({ primaryKey = 'id', attributes = [], rows = [] } = {}) {
	const table = {
		primaryKey,
		attributes: attributes.map((a) => ({ name: a.name, indexed: !!a.indexed })),
		indices: Object.fromEntries(attributes.filter((a) => a.indexed).map((a) => [a.name, true])),
		_searches: [],
		async *search(target) {
			table._searches.push(target);
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

function sortByJson(rows) {
	return [...rows].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

describe('sqlEngine phase 3: joins', () => {
	let originalEngine;
	let users;
	let orders;
	let products;

	beforeEach(() => {
		originalEngine = process.env.HARPER_SQL_ENGINE;
		process.env.HARPER_SQL_ENGINE = 'new';
		globalThis.harperConfig = { sql: { allowFullScan: true } };

		users = makeMockTable({
			primaryKey: 'id',
			attributes: [
				{ name: 'id', indexed: true },
				{ name: 'name', indexed: true },
				{ name: 'city', indexed: true },
			],
			rows: [
				{ id: 1, name: 'alice', city: 'denver' },
				{ id: 2, name: 'bob', city: 'austin' },
				{ id: 3, name: 'carol', city: 'denver' },
			],
		});
		orders = makeMockTable({
			primaryKey: 'id',
			attributes: [
				{ name: 'id', indexed: true },
				{ name: 'user_id', indexed: true },
				{ name: 'amount', indexed: false },
			],
			rows: [
				{ id: 10, user_id: 1, amount: 100 },
				{ id: 11, user_id: 1, amount: 50 },
				{ id: 12, user_id: 2, amount: 75 },
				// user 3 has no orders
			],
		});
		products = makeMockTable({
			primaryKey: 'sku',
			attributes: [
				{ name: 'sku', indexed: true },
				{ name: 'order_id', indexed: true },
				{ name: 'label', indexed: false },
			],
			rows: [
				{ sku: 'A', order_id: 10, label: 'widget' },
				{ sku: 'B', order_id: 12, label: 'gadget' },
			],
		});

		binder._setDatabasesLoader(() => ({ dev: { user: users, orders, product: products } }));
	});

	afterEach(() => {
		if (originalEngine === undefined) delete process.env.HARPER_SQL_ENGINE;
		else process.env.HARPER_SQL_ENGINE = originalEngine;
		delete globalThis.harperConfig;
		binder._setDatabasesLoader(null);
	});

	it('INNER JOIN returns matched rows with clean column names', async () => {
		const data = await runSql('SELECT u.name, o.amount FROM dev.user u JOIN dev.orders o ON u.id = o.user_id');
		assert.deepStrictEqual(
			sortByJson(data),
			sortByJson([
				{ name: 'alice', amount: 100 },
				{ name: 'alice', amount: 50 },
				{ name: 'bob', amount: 75 },
			])
		);
	});

	it('uses an indexed probe (indexNL) on the inner table — no full inner scan', async () => {
		await runSql('SELECT u.name, o.amount FROM dev.user u JOIN dev.orders o ON u.id = o.user_id');
		// Inner (orders) probed once per outer row, each with an equals on user_id.
		assert.ok(orders._searches.length >= 3);
		for (const t of orders._searches) {
			assert.ok(t.conditions.some((c) => c.attribute === 'user_id' && c.comparator === 'equals'));
		}
	});

	it('column-name collision suffixes the later column (_2)', async () => {
		const data = await runSql('SELECT u.id, o.id FROM dev.user u JOIN dev.orders o ON u.id = o.user_id');
		assert.deepStrictEqual(
			sortByJson(data),
			sortByJson([
				{ id: 1, id_2: 10 },
				{ id: 1, id_2: 11 },
				{ id: 2, id_2: 12 },
			])
		);
	});

	it('LEFT JOIN null-fills the right side when there is no match', async () => {
		const data = await runSql('SELECT u.name, o.amount FROM dev.user u LEFT JOIN dev.orders o ON u.id = o.user_id');
		assert.deepStrictEqual(
			sortByJson(data),
			sortByJson([
				{ name: 'alice', amount: 100 },
				{ name: 'alice', amount: 50 },
				{ name: 'bob', amount: 75 },
				{ name: 'carol', amount: null },
			])
		);
	});

	it('WHERE on one table is pushed to that table scan', async () => {
		const data = await runSql(
			"SELECT u.name, o.amount FROM dev.user u JOIN dev.orders o ON u.id = o.user_id WHERE u.city = 'denver'"
		);
		assert.deepStrictEqual(
			sortByJson(data),
			sortByJson([
				{ name: 'alice', amount: 100 },
				{ name: 'alice', amount: 50 },
			])
		);
		// The driving (user) scan carries the city equality.
		const userScan = users._searches[0];
		assert.deepStrictEqual(userScan.conditions, [{ attribute: 'city', comparator: 'equals', value: 'denver' }]);
	});

	it('three-table join chains correctly', async () => {
		const data = await runSql(
			'SELECT u.name, o.amount, p.label FROM dev.user u ' +
				'JOIN dev.orders o ON u.id = o.user_id ' +
				'JOIN dev.product p ON o.id = p.order_id'
		);
		assert.deepStrictEqual(
			sortByJson(data),
			sortByJson([
				{ name: 'alice', amount: 100, label: 'widget' },
				{ name: 'bob', amount: 75, label: 'gadget' },
			])
		);
	});

	it('GROUP BY over a join aggregates per group key', async () => {
		const data = await runSql(
			'SELECT u.city, COUNT(*) AS n FROM dev.user u JOIN dev.orders o ON u.id = o.user_id GROUP BY u.city'
		);
		assert.deepStrictEqual(
			sortByJson(data),
			sortByJson([
				{ city: 'denver', n: 2 },
				{ city: 'austin', n: 1 },
			])
		);
	});

	it('ORDER BY a joined column sorts the result', async () => {
		const data = await runSql(
			'SELECT u.name, o.amount FROM dev.user u JOIN dev.orders o ON u.id = o.user_id ORDER BY o.amount DESC'
		);
		assert.deepStrictEqual(
			data.map((r) => r.amount),
			[100, 75, 50]
		);
	});

	it('CROSS join (comma FROM) produces the cartesian product', async () => {
		const data = await runSql('SELECT u.id, o.id FROM dev.user u, dev.orders o');
		assert.strictEqual(data.length, 3 * 3);
	});

	it('LEFT JOIN with WHERE on the nullable side filters null-filled rows (not pushed down)', async () => {
		// carol has no orders; the WHERE on the right (nullable) table must drop her,
		// not return her null-filled.
		const data = await runSql(
			'SELECT u.name, o.amount FROM dev.user u LEFT JOIN dev.orders o ON u.id = o.user_id WHERE o.amount > 80'
		);
		assert.deepStrictEqual(sortByJson(data), sortByJson([{ name: 'alice', amount: 100 }]));
		// orders must not have been pre-filtered by amount on its own scan.
		for (const t of orders._searches) {
			assert.ok(!t.conditions.some((c) => c.attribute === 'amount'));
		}
	});

	it('LEFT JOIN ... WHERE o.<col> IS NULL keeps only the unmatched (anti-join) rows', async () => {
		const data = await runSql(
			'SELECT u.name FROM dev.user u LEFT JOIN dev.orders o ON u.id = o.user_id WHERE o.id IS NULL'
		);
		assert.deepStrictEqual(data, [{ name: 'carol' }]);
	});

	it('rejects duplicate table aliases in a join', async () => {
		await assert.rejects(
			runSql('SELECT u.id FROM dev.user u JOIN dev.user u ON u.id = u.id'),
			EngineUnsupportedError
		);
	});

	it('rejects an ambiguous unqualified column', async () => {
		await assert.rejects(
			runSql('SELECT id FROM dev.user u JOIN dev.orders o ON u.id = o.user_id'),
			EngineUnsupportedError
		);
	});

	it('rejects an unknown table qualifier', async () => {
		await assert.rejects(
			runSql('SELECT x.name FROM dev.user u JOIN dev.orders o ON u.id = o.user_id'),
			EngineUnsupportedError
		);
	});

	it('rejects RIGHT JOIN', async () => {
		await assert.rejects(
			runSql('SELECT u.name FROM dev.user u RIGHT JOIN dev.orders o ON u.id = o.user_id'),
			EngineUnsupportedError
		);
	});

	it('indexNL join passes with allowFullScan off when the outer has an indexed filter', async () => {
		globalThis.harperConfig = { sql: { allowFullScan: false } };
		const data = await runSql(
			'SELECT u.name, o.amount FROM dev.user u JOIN dev.orders o ON u.id = o.user_id WHERE u.id = 1'
		);
		assert.deepStrictEqual(
			sortByJson(data),
			sortByJson([
				{ name: 'alice', amount: 100 },
				{ name: 'alice', amount: 50 },
			])
		);
	});

	it('rejects a join whose outer side requires a full scan when allowFullScan is off', async () => {
		globalThis.harperConfig = { sql: { allowFullScan: false } };
		await assert.rejects(
			runSql('SELECT u.name, o.amount FROM dev.user u JOIN dev.orders o ON u.id = o.user_id'),
			EngineUnsupportedError
		);
	});
});
