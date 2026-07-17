'use strict';

/**
 * Phase 4 mutation tests for the new SQL engine (INSERT / UPDATE / DELETE).
 *
 * Like the SELECT tests, these bypass the real Resource API. A mock "writable
 * table" implements the static Resource methods the write path uses (get / put /
 * patch / delete / getNewId) over an in-memory Map, plus `search` for the
 * UPDATE/DELETE selector. The transaction runner is stubbed to invoke its
 * callback once (and record that it did), so we can assert the whole batch runs
 * inside a single transaction.
 */

const assert = require('assert');
const alasql = require('alasql');

const router = require('#src/sqlEngine/router');
const binder = require('#src/sqlEngine/binder/bind');
const mutation = require('#src/sqlEngine/executor/runMutation');

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

function makeWritableTable({ primaryKey = 'id', attributes = [], rows = [] } = {}) {
	const store = new Map(rows.map((r) => [r[primaryKey], { ...r }]));
	let counter = 1000;
	const table = {
		primaryKey,
		attributes: attributes.map((a) => ({ name: a.name, indexed: !!a.indexed })),
		indices: Object.fromEntries(attributes.filter((a) => a.indexed).map((a) => [a.name, true])),
		_store: store,
		_ops: [],
		getNewId() {
			return `gen-${counter++}`;
		},
		get(id) {
			return store.get(id);
		},
		put(record) {
			table._ops.push(['put', record[primaryKey]]);
			store.set(record[primaryKey], { ...record });
		},
		patch(id, update) {
			table._ops.push(['patch', id]);
			const existing = store.get(id) || { [primaryKey]: id };
			const merged = { ...existing };
			for (const [k, v] of Object.entries(update)) {
				// Mirror the real write path's CRDT merge: an Addition value applies
				// as an atomic delta against the stored value (resources/tracked.ts).
				merged[k] = v && typeof v === 'object' && v.__op__ === 'add' ? (+existing[k] || 0) + v.value : v;
			}
			store.set(id, merged);
		},
		delete(id) {
			table._ops.push(['delete', id]);
			return store.delete(id);
		},
		async *search(target) {
			let result = [...store.values()];
			if (Array.isArray(target.conditions) && target.conditions.length > 0) {
				result = result.filter((row) => evalConditions(row, target.conditions, target.operator || 'and'));
			}
			for (const row of result) {
				if (target.select) {
					const out = {};
					for (const k of target.select) out[k] = row[k];
					yield out;
				} else {
					yield { ...row };
				}
			}
		},
	};
	return table;
}

function runSql(sql) {
	return new Promise((resolve, reject) => {
		const parsed = alasql.parse(sql);
		const variant = sql.trim().split(/\s+/)[0].toLowerCase();
		const hdb_user = { username: 'test' };
		// Faithful to sqlTranslator/index.ts processAST: SELECT is dispatched with
		// the bare AST, while INSERT/UPDATE/DELETE are wrapped as { statement,
		// hdb_user } (the legacy handler arg shape).
		const ast = parsed.statements[0];
		const statement = variant === 'select' ? ast : { statement: ast, hdb_user };
		router.route(
			{
				variant,
				jsonMessage: { hdb_user, bypass_auth: true },
				statement,
				legacy: () => reject(new Error('legacy fallback should not be invoked')),
			},
			(err, data) => (err ? reject(err) : resolve(data))
		);
	});
}

describe('sqlEngine phase 4: mutations', () => {
	let originalEngine;
	let widgets;
	let txnCalls;

	beforeEach(() => {
		originalEngine = process.env.HARPER_SQL_ENGINE;
		process.env.HARPER_SQL_ENGINE = 'new';
		globalThis.harperConfig = { sql: { allowFullScan: true } };

		widgets = makeWritableTable({
			primaryKey: 'id',
			attributes: [
				{ name: 'id', indexed: true },
				{ name: 'name', indexed: true },
				{ name: 'qty', indexed: false },
			],
			rows: [
				{ id: 1, name: 'alpha', qty: 10 },
				{ id: 2, name: 'beta', qty: 20 },
				{ id: 3, name: 'gamma', qty: 30 },
			],
		});

		binder._setDatabasesLoader(() => ({ dev: { widget: widgets } }));

		// Stub the transaction runner: run the callback once, record the call, and
		// attach a dummy transaction to the context.
		txnCalls = 0;
		mutation._setTransactionRunner((context, callback) => {
			txnCalls++;
			context.transaction = { open: true };
			return callback();
		});
	});

	afterEach(() => {
		if (originalEngine === undefined) delete process.env.HARPER_SQL_ENGINE;
		else process.env.HARPER_SQL_ENGINE = originalEngine;
		delete globalThis.harperConfig;
		binder._setDatabasesLoader(null);
		mutation._setTransactionRunner(null);
	});

	it('INSERT adds new rows and reports inserted_hashes', async () => {
		const res = await runSql("INSERT INTO dev.widget (id, name, qty) VALUES (4, 'delta', 40), (5, 'eps', 50)");
		assert.deepStrictEqual(res.inserted_hashes, [4, 5]);
		assert.deepStrictEqual(res.skipped_hashes, []);
		assert.strictEqual(res.message, 'inserted 2 of 2 records');
		assert.deepStrictEqual(widgets._store.get(4), { id: 4, name: 'delta', qty: 40 });
		assert.strictEqual(txnCalls, 1); // whole batch in one transaction
	});

	it('INSERT skips rows whose primary key already exists', async () => {
		const res = await runSql("INSERT INTO dev.widget (id, name, qty) VALUES (2, 'dup', 99), (6, 'zeta', 60)");
		assert.deepStrictEqual(res.inserted_hashes, [6]);
		assert.deepStrictEqual(res.skipped_hashes, [2]);
		assert.strictEqual(res.message, 'inserted 1 of 2 records');
		// Existing row 2 is untouched.
		assert.deepStrictEqual(widgets._store.get(2), { id: 2, name: 'beta', qty: 20 });
	});

	// A dynamic-schema table mirroring the real Table: new columns are auto-added
	// via addAttributes, which rejects backtick/slash names (resources/Table.ts).
	function makeDynamicTable() {
		const t = makeWritableTable({
			primaryKey: 'id',
			attributes: [{ name: 'id', indexed: true }],
			rows: [],
		});
		t.schemaDefined = false;
		t.addAttributes = async (attrs) => {
			for (const a of attrs) {
				if (/[`/]/.test(a.name)) {
					throw new Error('Attribute names cannot include backticks or forward slashes');
				}
				t.attributes.push({ name: a.name, indexed: !!a.indexed });
			}
		};
		return t;
	}

	it('INSERT rejects an invalid attribute name (backtick/slash), like legacy', async () => {
		const dyn = makeDynamicTable();
		binder._setDatabasesLoader(() => ({ dev: { invalid_attribute: dyn } }));
		await assert.rejects(
			() => runSql("INSERT INTO dev.invalid_attribute (id, `some/attribute`) VALUES ('1', 'x')"),
			/Attribute names cannot include backticks or forward slashes/
		);
		// Rejected before any row write (validation precedes the insert loop).
		assert.strictEqual(dyn._store.size, 0);
	});

	it('UPDATE rejects an invalid attribute name (backtick/slash), like legacy', async () => {
		const dyn = makeDynamicTable();
		binder._setDatabasesLoader(() => ({ dev: { invalid_attribute: dyn } }));
		await assert.rejects(
			() => runSql("UPDATE dev.invalid_attribute SET `some/attribute` = 'x' WHERE id = 100"),
			/Attribute names cannot include backticks or forward slashes/
		);
	});

	it('UPDATE rejects a SET on the primary key (EngineUnsupportedError, so auto falls back)', async () => {
		// Table.patch can't re-key a record (identity is the call argument, not the
		// payload) — without this rejection the executor reported a false success
		// while the stored primary key stayed unchanged.
		await assert.rejects(() => runSql('UPDATE dev.widget SET id = 30 WHERE id = 2'), /cannot change the primary key/);
		// Nothing was written.
		assert.deepStrictEqual(widgets._store.get(2), { id: 2, name: 'beta', qty: 20 });
		assert.strictEqual(widgets._store.get(30), undefined);
	});

	it('INSERT auto-creates new valid attributes on a dynamic-schema table', async () => {
		const dyn = makeDynamicTable();
		binder._setDatabasesLoader(() => ({ dev: { invalid_attribute: dyn } }));
		const res = await runSql("INSERT INTO dev.invalid_attribute (id, color) VALUES ('1', 'red')");
		assert.deepStrictEqual(res.inserted_hashes, ['1']);
		// The new column was added (indexed) via addAttributes, matching legacy.
		assert.ok(dyn.attributes.find((a) => a.name === 'color' && a.indexed));
	});

	it('INSERT auto-generates a primary key when none is supplied', async () => {
		const res = await runSql("INSERT INTO dev.widget (name, qty) VALUES ('auto', 7)");
		assert.strictEqual(res.inserted_hashes.length, 1);
		const id = res.inserted_hashes[0];
		assert.ok(String(id).startsWith('gen-'));
		assert.deepStrictEqual(widgets._store.get(id), { id, name: 'auto', qty: 7 });
	});

	it('UPDATE applies SET assignments to matched rows', async () => {
		const res = await runSql("UPDATE dev.widget SET name = 'renamed' WHERE id = 2");
		assert.deepStrictEqual(res.update_hashes, [2]);
		assert.strictEqual(res.message, 'updated 1 of 1 records');
		assert.strictEqual(widgets._store.get(2).name, 'renamed');
		assert.strictEqual(widgets._store.get(2).qty, 20); // unchanged field preserved
	});

	it('UPDATE supports relative assignments reading the existing value', async () => {
		const res = await runSql('UPDATE dev.widget SET qty = qty + 5 WHERE qty >= 20');
		assert.deepStrictEqual(res.update_hashes.sort(), [2, 3]);
		assert.strictEqual(widgets._store.get(2).qty, 25);
		assert.strictEqual(widgets._store.get(3).qty, 35);
		assert.strictEqual(widgets._store.get(1).qty, 10); // not matched
	});

	it('UPDATE assignment reading a DIFFERENT column selects that column, not just the primary key', async () => {
		// name = name || qty is neither a delta (not self-referential) nor pk-only —
		// the selector must project `name` and `qty`, not just `id`, for .eval(row) to
		// see both values.
		const res = await runSql(`UPDATE dev.widget SET name = name || '-' || qty WHERE id = 2`);
		assert.deepStrictEqual(res.update_hashes, [2]);
		assert.strictEqual(widgets._store.get(2).name, 'beta-20');
		assert.strictEqual(widgets._store.get(2).qty, 20); // unchanged field preserved
	});

	it('UPDATE col = col ± N is written as an atomic Addition delta (F-146)', async () => {
		// A self-referential increment must NOT be a read-compute-write of an
		// absolute value (which loses updates under concurrency) — it must patch an
		// Addition CRDT delta so the storage layer applies it atomically.
		const captured = [];
		const origPatch = widgets.patch.bind(widgets);
		widgets.patch = (id, update) => {
			captured.push([id, update.qty]);
			return origPatch(id, update);
		};
		await runSql('UPDATE dev.widget SET qty = qty + 5 WHERE id = 2');
		await runSql('UPDATE dev.widget SET qty = qty - 3 WHERE id = 3');
		assert.strictEqual(captured[0][1].__op__, 'add');
		assert.strictEqual(captured[0][1].value, 5);
		assert.strictEqual(captured[1][1].__op__, 'add');
		assert.strictEqual(captured[1][1].value, -3);
		// A non-self-referential assignment stays absolute (no Addition).
		captured.length = 0;
		await runSql('UPDATE dev.widget SET qty = 99 WHERE id = 2');
		assert.strictEqual(captured[0][1], 99);
	});

	it('DELETE removes matched rows and reports deleted_hashes', async () => {
		const res = await runSql('DELETE FROM dev.widget WHERE id = 1');
		assert.deepStrictEqual(res.deleted_hashes, [1]);
		assert.strictEqual(res.message, '1 of 1 record successfully deleted');
		assert.strictEqual(widgets._store.has(1), false);
		assert.strictEqual(widgets._store.size, 2);
	});

	it('DELETE with no matches reports zero deleted', async () => {
		const res = await runSql('DELETE FROM dev.widget WHERE id = 999');
		assert.deepStrictEqual(res.deleted_hashes, []);
		assert.strictEqual(res.message, '0 of 0 records successfully deleted');
		assert.strictEqual(widgets._store.size, 3);
	});

	it('all writes in a multi-row mutation share one transaction', async () => {
		await runSql('UPDATE dev.widget SET qty = qty + 1 WHERE qty >= 10');
		assert.strictEqual(txnCalls, 1);
		assert.strictEqual(widgets._ops.filter((o) => o[0] === 'patch').length, 3);
	});
});
