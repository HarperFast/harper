/**
 * Differential test: new SQL engine vs legacy AlaSQL engine.
 *
 * Boots TWO real Harper instances with identical schema + seed data — one with
 * HARPER_SQL_ENGINE=new, one with the default (legacy) engine — then runs the
 * same battery of SQL statements against both and compares (a) the operation
 * response and (b) the resulting table state. Every difference is collected and
 * printed as a summary at the end.
 *
 * Reads use indexed WHERE clauses (ranges/equalities on the primary key) so the
 * new engine's no-full-scan policy is satisfied without allowFullScan.
 *
 * Goal: surface behavioral divergences (response shape/wording, value/type
 * coercion, ordering, null handling, coverage gaps) between the two engines.
 */
import { suite, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startHarper, teardownHarper, createHarperContext } from '@harperfast/integration-testing';
import { createApiClient } from './utils/client.mjs';

const SEED = [
	{ id: 1, name: 'alpha', qty: 10, tag: 'x' },
	{ id: 2, name: 'beta', qty: 20, tag: 'y' },
	{ id: 3, name: 'gamma', qty: 30, tag: 'x' },
	{ id: 4, name: 'delta', qty: 40, tag: 'y' },
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
			assert.deepEqual(newNorm, legacyNorm);
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
			assert.deepEqual(n, l);
		} catch {
			equal = false;
		}
		differences.push({ label: `STATE ${label}`, equal, new: n, legacy: l });
	}

	before(async () => {
		await startHarper(ctxNew, { config: {}, env: { HARPER_SQL_ENGINE: 'new' } });
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

	test('SELECT — aggregates', async () => {
		await diff('count', 'SELECT COUNT(*) AS n FROM dev.widget WHERE id >= 1');
		await diff('sum+group', 'SELECT tag, SUM(qty) AS total FROM dev.widget WHERE id >= 1 GROUP BY tag');
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
		await diffState('after updates', 'widget', [1, 3]);
	});

	test('DELETE — response + state parity', async () => {
		await diff('delete one', 'DELETE FROM dev.widget WHERE id = 4');
		await diff('delete none', 'DELETE FROM dev.widget WHERE id = 999');
		await diffState('after deletes', 'widget', [3, 4]);
	});

	// Runs last: fail if any comparison diverged (the after() hook prints details).
	test('new engine matches legacy across the battery', () => {
		const diverged = differences.filter((d) => !d.equal);
		assert.equal(
			diverged.length,
			0,
			`engine divergences: ${diverged.map((d) => d.label).join(', ')} (see summary above)`
		);
	});
});
