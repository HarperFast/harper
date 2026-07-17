/**
 * Differential / cutover-readiness test: new SQL engine vs legacy AlaSQL engine.
 *
 * Boots TWO real Harper instances with identical schema + seed data — one with
 * HARPER_SQL_ENGINE=auto (the production cutover setting: new engine first, fall
 * back to legacy on EngineUnsupportedError), one with HARPER_SQL_ENGINE=legacy —
 * then runs the same broad battery of SQL against both and compares (a) the
 * operation response and (b) the resulting table state.
 *
 * Running the new side in `auto` mirrors exactly what flipping the default to
 * `auto` would do in production: a query the new engine can't plan falls back and
 * therefore matches legacy by construction; the only way to fail is a *silent*
 * divergence — the new engine planning a query but returning different results.
 * That is precisely the cutover risk this test is built to catch.
 *
 * Reads use indexed WHERE clauses (PK ranges/equalities) where they must be
 * served by the new engine; deliberately non-indexable predicates exercise the
 * fallback path.
 *
 * Covers the phase-5 coercion blocker (loose `IN` membership — `id IN ('1')` vs a
 * numeric column). Still NOT covered: the non-PK `LIKE` DELETE 403 (see PLAN.md).
 */
import { suite, test, before, after } from 'node:test';
import assert from 'node:assert';
import { startHarper, teardownHarper, createHarperContext } from '@harperfast/integration-testing';
import { createApiClient } from './utils/client.mjs';

const SEED = [
	// `active` is a real boolean column to exercise quoted-boolean coercion
	// (`active = 'false'`), a legacy AlaSQL behavior the new engine must match.
	{ id: 1, name: 'alpha', qty: 10, tag: 'x', active: true },
	{ id: 2, name: 'beta', qty: 20, tag: 'y', active: false },
	{ id: 3, name: 'gamma', qty: 30, tag: 'x', active: true },
	{ id: 4, name: 'delta', qty: 40, tag: 'y', active: false },
	// Null-bearing row to exercise NULL semantics (a classic AlaSQL-vs-SQL
	// divergence source). id 7 stays clear of the mutation tests' ids (5, 6).
	{ id: 7, name: null, qty: null, tag: 'z', active: null },
];
const ORDERS = [
	{ id: 100, widget_id: 1, amt: 5 },
	{ id: 101, widget_id: 1, amt: 7 },
	{ id: 102, widget_id: 3, amt: 9 },
];

// Per-record audit timestamps are stamped independently by each instance, so
// they always differ — drop them so only engine-attributable differences show.
function stripVolatile(row) {
	if (!row || typeof row !== 'object') return row;
	const { __createdtime__, __updatedtime__, ...rest } = row;
	return rest;
}

function sortRows(rows) {
	if (!Array.isArray(rows)) return rows;
	return [...rows].map(stripVolatile).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

/** Strip fields that legitimately vary run-to-run so they don't mask real diffs. */
function normalizeResponse(body) {
	if (Array.isArray(body)) return sortRows(body);
	if (body && typeof body === 'object') {
		const out = {};
		for (const k of Object.keys(body).sort()) {
			if (k === 'txn_time' || k === 'new_attributes') continue;
			out[k] = Array.isArray(body[k]) ? [...body[k]].sort() : body[k];
		}
		return out;
	}
	return body;
}

suite('SQL engine differential — new vs legacy', () => {
	const ctxNew = createHarperContext('engine-new');
	const ctxLegacy = createHarperContext('engine-legacy');
	let clientNew;
	let clientLegacy;
	const differences = [];

	async function seed(client) {
		await client.req().send({ operation: 'create_schema', schema: 'dev' }).expect(200);
		await client
			.req()
			.send({ operation: 'create_table', schema: 'dev', table: 'widget', primary_key: 'id' })
			.expect(200);
		await client
			.req()
			.send({ operation: 'create_table', schema: 'dev', table: 'orders', primary_key: 'id' })
			.expect(200);
		await client.req().send({ operation: 'insert', schema: 'dev', table: 'widget', records: SEED }).expect(200);
		await client.req().send({ operation: 'insert', schema: 'dev', table: 'orders', records: ORDERS }).expect(200);
	}

	// Run a SQL statement on a client; return { ok, body } (ok=false on error status).
	async function runOn(client, statement) {
		const res = await client.req().send({ operation: 'sql', sql: statement });
		return { status: res.status, body: res.body };
	}

	// Run on both engines, record any difference in normalized response.
	async function diff(label, statement) {
		const [a, b] = await Promise.all([runOn(clientNew, statement), runOn(clientLegacy, statement)]);
		const newNorm = { status: a.status, body: normalizeResponse(a.body) };
		const legacyNorm = { status: b.status, body: normalizeResponse(b.body) };
		let equal = true;
		try {
			assert.deepStrictEqual(newNorm, legacyNorm);
		} catch {
			equal = false;
		}
		differences.push({ label, statement, equal, new: newNorm, legacy: legacyNorm });
		return { a, b };
	}

	// Compare full table state on both engines (via search_by_hash over a fixed id span).
	async function diffState(label, table, ids) {
		const fetch = (client) =>
			client
				.req()
				.send({ operation: 'search_by_hash', schema: 'dev', table, hash_values: ids, get_attributes: ['*'] })
				.then((r) => sortRows(r.body));
		const [n, l] = await Promise.all([fetch(clientNew), fetch(clientLegacy)]);
		let equal = true;
		try {
			assert.deepStrictEqual(n, l);
		} catch {
			equal = false;
		}
		differences.push({ label: `STATE ${label}`, equal, new: n, legacy: l });
	}

	before(async () => {
		await startHarper(ctxNew, { config: {}, env: { HARPER_SQL_ENGINE: 'auto' } });
		await startHarper(ctxLegacy, { config: {}, env: { HARPER_SQL_ENGINE: 'legacy' } });
		clientNew = createApiClient(ctxNew.harper);
		clientLegacy = createApiClient(ctxLegacy.harper);
		await Promise.all([seed(clientNew), seed(clientLegacy)]);
	});

	after(async () => {
		// Emit the difference summary regardless of pass/fail.
		const diffs = differences.filter((d) => !d.equal);
		console.log('\n========== SQL ENGINE DIFFERENTIAL SUMMARY ==========');
		console.log(`${differences.length} comparisons, ${diffs.length} with differences.\n`);
		for (const d of diffs) {
			console.log(`✗ ${d.label}${d.statement ? `  [${d.statement}]` : ''}`);
			console.log(`    new   : ${JSON.stringify(d.new)}`);
			console.log(`    legacy: ${JSON.stringify(d.legacy)}`);
		}
		const same = differences.filter((d) => d.equal).map((d) => d.label);
		console.log(`\n✓ Identical (${same.length}): ${same.join(', ')}`);
		console.log('=====================================================\n');
		await Promise.all([teardownHarper(ctxNew), teardownHarper(ctxLegacy)]);
	});

	test('SELECT — single-table reads', async () => {
		await diff('select eq', 'SELECT id, name, qty FROM dev.widget WHERE id = 2');
		await diff('select range', 'SELECT id, name FROM dev.widget WHERE id >= 2');
		await diff('select IN', 'SELECT name, qty FROM dev.widget WHERE id IN (1, 3)');
		await diff('select projected *', 'SELECT * FROM dev.widget WHERE id = 1');
	});

	test('SELECT — predicate variety (OR / NOT / BETWEEN / LIKE / IN)', async () => {
		await diff('or', 'SELECT id FROM dev.widget WHERE id = 1 OR id = 3');
		await diff('not', "SELECT id FROM dev.widget WHERE id >= 1 AND NOT (tag = 'x')");
		await diff('between-indexed', 'SELECT id FROM dev.widget WHERE id BETWEEN 2 AND 3');
		await diff('like-prefix', "SELECT name FROM dev.widget WHERE id >= 1 AND name LIKE 'a%'");
		await diff('like-contains', "SELECT name FROM dev.widget WHERE id >= 1 AND name LIKE '%a%'");
		// Non-indexable predicate (qty not indexed) — exercises the fallback path.
		await diff('between-unindexed', 'SELECT id FROM dev.widget WHERE qty BETWEEN 15 AND 35');
		// Standalone suffix/substring LIKE can't seek even an indexed column — the
		// new engine must reject and fall back (blocker-2 path), matching legacy.
		await diff('like-suffix-standalone', "SELECT name FROM dev.widget WHERE name LIKE '%a'");
		await diff('like-contains-standalone', "SELECT name FROM dev.widget WHERE name LIKE '%am%'");
		// F-145 regression anchors: `!=`/NOT IN on the PRIMARY KEY. The `!=`
		// expansion AND-s a not-null guard, and the primary store never has
		// indexNulls — pre-fix the pushed guard made Table.search throw a raw 400
		// ("not indexed for nulls") past the router's fallback catch, leaking an
		// error where legacy returns rows. The guard must ride as a residual
		// filter (or the scan must reject at plan time and fall back).
		await diff('ne-pk (F-145)', 'SELECT id, name FROM dev.widget WHERE id != 2');
		await diff('ne-pk-ordered (F-145)', 'SELECT id FROM dev.widget WHERE id != 2 ORDER BY id DESC');
		await diff('not-in-pk (F-145)', 'SELECT id FROM dev.widget WHERE id NOT IN (2, 4)');
	});

	test('SELECT — loose IN coercion (string literals vs numeric column)', async () => {
		// Legacy AlaSQL matches quoted numerics in IN against numeric values; the new
		// engine must too (single `=` stays strict in both — not tested as a match).
		await diff('in-str-pk', "SELECT id FROM dev.widget WHERE id IN ('1', '3')");
		await diff('in-str-nonpk', "SELECT id, qty FROM dev.widget WHERE qty IN ('20', '30')");
		await diff('in-mixed', "SELECT id FROM dev.widget WHERE id IN (2, '4')");
	});

	test('SELECT — loose boolean coercion (quoted boolean literal vs boolean column)', async () => {
		// Legacy coerces `'false'`/`'true'` to a boolean to match a boolean column;
		// the new engine must too. Numeric `=` stays strict (guard below), so this is
		// boolean-only.
		await diff('bool-eq-false', "SELECT id FROM dev.widget WHERE active = 'false'");
		await diff('bool-eq-true', "SELECT id FROM dev.widget WHERE active = 'true'");
		await diff('bool-eq-literal', 'SELECT id FROM dev.widget WHERE active = false');
		// `!=` coerces the quoted boolean AND (SQL three-valued logic) excludes the
		// NULL-active row (id 7) — legacy does both, so the new engine must too.
		await diff('bool-ne-false', "SELECT id FROM dev.widget WHERE id >= 1 AND active != 'false'");
		// Non-boolean `!=` over a NULL-bearing column: the NULL row (id 7, qty NULL)
		// must be excluded too — proves the not-null guard isn't boolean-specific.
		await diff('ne-excludes-null', 'SELECT id FROM dev.widget WHERE id >= 1 AND qty != 20');
		// Guard: numeric `=` with a quoted number must NOT coerce (legacy returns
		// nothing) — proves the boolean expansion didn't loosen numeric `=`.
		await diff('eq-num-str-strict', "SELECT id FROM dev.widget WHERE qty = '20'");
	});

	test('SELECT — NULL semantics', async () => {
		await diff('is null', 'SELECT id FROM dev.widget WHERE id >= 1 AND qty IS NULL');
		await diff('is not null', 'SELECT id FROM dev.widget WHERE id >= 1 AND qty IS NOT NULL');
	});

	test('SELECT — ORDER BY / LIMIT / OFFSET / DISTINCT', async () => {
		await diff('order desc', 'SELECT id, qty FROM dev.widget WHERE id >= 1 ORDER BY qty DESC');
		await diff('limit offset', 'SELECT id FROM dev.widget WHERE id >= 1 ORDER BY id LIMIT 2 OFFSET 1');
		await diff('distinct', 'SELECT DISTINCT tag FROM dev.widget WHERE id >= 1');
		// No-WHERE ORDER BY on an indexed attribute: the new engine serves it via the
		// index's natural order (D-219) — results must still match legacy.
		await diff('order-no-where', 'SELECT id FROM dev.widget ORDER BY id');
		await diff('order-no-where-limit (D-219)', 'SELECT id, name FROM dev.widget ORDER BY id LIMIT 3');
		await diff('order-no-where-desc (D-219)', 'SELECT id FROM dev.widget ORDER BY id DESC LIMIT 2');
	});

	test('SELECT — aggregates', async () => {
		await diff('count', 'SELECT COUNT(*) AS n FROM dev.widget WHERE id >= 1');
		await diff('sum+group', 'SELECT tag, SUM(qty) AS total FROM dev.widget WHERE id >= 1 GROUP BY tag');
		await diff('min max avg', 'SELECT MIN(qty) AS mn, MAX(qty) AS mx, AVG(qty) AS av FROM dev.widget WHERE id >= 1');
		await diff('having', 'SELECT tag, COUNT(*) AS n FROM dev.widget WHERE id >= 1 GROUP BY tag HAVING COUNT(*) > 1');
		// Unaliased aggregates: the output-column label must match legacy AlaSQL
		// (`COUNT(*)`, `MIN(qty)`, …). Every case above carries an `AS` alias, which
		// masked a real label divergence the scale suite caught at indexed scale.
		await diff('count-bare', 'SELECT COUNT(*) FROM dev.widget WHERE id >= 1');
		await diff('count-bare-group', 'SELECT tag, COUNT(*) FROM dev.widget WHERE id >= 1 GROUP BY tag');
		await diff('min-max-bare', 'SELECT MIN(qty), MAX(qty) FROM dev.widget WHERE id >= 1');
		// DISTINCT inside an aggregate must match legacy (dedup), not count every row.
		// Index-served, so the new engine handles it directly (no legacy fallback).
		await diff('count-distinct', 'SELECT COUNT(DISTINCT tag) AS n FROM dev.widget WHERE id >= 1');
	});

	test('SELECT — join', async () => {
		await diff(
			'inner join',
			'SELECT w.name, o.amt FROM dev.widget w JOIN dev.orders o ON w.id = o.widget_id WHERE w.id >= 1'
		);
		await diff(
			'left join',
			'SELECT w.name, o.amt FROM dev.widget w LEFT JOIN dev.orders o ON w.id = o.widget_id WHERE w.id >= 1'
		);
	});

	test('INSERT — response + state parity', async () => {
		await diff('insert new', "INSERT INTO dev.widget (id, name, qty, tag) VALUES (5, 'eps', 50, 'x')");
		await diff(
			'insert dup',
			"INSERT INTO dev.widget (id, name, qty, tag) VALUES (2, 'dup', 99, 'z'), (6, 'zed', 60, 'y')"
		);
		await diffState('after inserts', 'widget', [2, 5, 6]);
	});

	test('UPDATE — response + state parity', async () => {
		await diff('update set', "UPDATE dev.widget SET name = 'renamed' WHERE id = 1");
		await diff('update relative', 'UPDATE dev.widget SET qty = qty + 5 WHERE id = 3');
		// SET on the primary key: the new engine rejects (EngineUnsupportedError) so
		// auto falls back to legacy, which declines the re-key ("updated 0 of 1").
		// Regression anchor for the false-success bug (executor reported the row
		// updated while the stored pk stayed unchanged).
		await diff('update pk declined', 'UPDATE dev.widget SET id = 30 WHERE id = 3');
		await diffState('after updates', 'widget', [1, 3, 30]);
	});

	test('DELETE — response + state parity', async () => {
		await diff('delete one', 'DELETE FROM dev.widget WHERE id = 4');
		await diff('delete none', 'DELETE FROM dev.widget WHERE id = 999');
		await diffState('after deletes', 'widget', [3, 4]);
	});

	// Runs last: fail if any comparison diverged (the after() hook prints details).
	test('new engine matches legacy across the battery', () => {
		const diverged = differences.filter((d) => !d.equal);
		assert.strictEqual(
			diverged.length,
			0,
			`engine divergences: ${diverged.map((d) => d.label).join(', ')} (see summary above)`
		);
	});
});
