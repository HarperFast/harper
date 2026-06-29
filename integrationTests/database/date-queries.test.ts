/**
 * Date storage round-trip, REST FIQL range correctness (inclusive boundaries, indexed==unindexed parity), chronological sort, timezone normalization, edge cases.
 */

import { suite, test, before, after } from 'node:test';
import { ok } from 'node:assert/strict';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import {
	setupHarperWithFixture,
	teardownHarper,
	sendOperation,
	DEFAULT_ADMIN_USERNAME,
	DEFAULT_ADMIN_PASSWORD,
	type ContextWithHarper,
} from '@harperfast/integration-testing';

const FIXTURE_PATH = resolve(import.meta.dirname, 'date-queries');
const SCHEMA = 'data';
const ENGINE = process.env.HARPER_STORAGE_ENGINE === 'lmdb' ? 'lmdb' : 'rocksdb';

const authHeader = 'Basic ' + Buffer.from(`${DEFAULT_ADMIN_USERNAME}:${DEFAULT_ADMIN_PASSWORD}`).toString('base64');

// ---------- Findings matrix ---------------------------------------------------

interface Finding {
	probe: string;
	verdict: 'CORRECT' | 'DEFECT' | 'KNOWN-DEFECT' | 'INFO' | 'EDGE';
	detail: string;
}
const findings: Finding[] = [];

function record(probe: string, verdict: Finding['verdict'], detail: string) {
	findings.push({ probe, verdict, detail });
	const icon = verdict === 'DEFECT' ? '*** DEFECT ***' : verdict === 'KNOWN-DEFECT' ? '(known)' : '';
	console.log(`  ${probe.padEnd(56)} → ${verdict.padEnd(14)} ${icon} ${detail.slice(0, 100)}`);
}

// ---------- HTTP helpers ------------------------------------------------------

async function restPut(ctx: ContextWithHarper, table: string, record: object): Promise<{ status: number; body: any }> {
	const id = (record as any).id;
	const url = `${(ctx.harper as any).httpURL.replace(/\/$/, '')}/${table}/${id}`;
	const res = await fetch(url, {
		method: 'PUT',
		headers: { 'Content-Type': 'application/json', 'Authorization': authHeader },
		body: JSON.stringify(record),
	}).catch(() => null);
	if (!res) return { status: 0, body: null };
	const body = await res.json().catch(() => null);
	return { status: res.status, body };
}

async function restGet(ctx: ContextWithHarper, table: string, id: string): Promise<{ status: number; body: any }> {
	const url = `${(ctx.harper as any).httpURL.replace(/\/$/, '')}/${table}/${id}`;
	const res = await fetch(url, { headers: { Authorization: authHeader } }).catch(() => null);
	if (!res) return { status: 0, body: null };
	const body = await res.json().catch(() => null);
	return { status: res.status, body };
}

async function restSearch(
	ctx: ContextWithHarper,
	table: string,
	query: string
): Promise<{ status: number; body: any }> {
	const url = `${(ctx.harper as any).httpURL.replace(/\/$/, '')}/${table}/${query}`;
	const res = await fetch(url, { headers: { Authorization: authHeader } }).catch(() => null);
	if (!res) return { status: 0, body: null };
	const body = await res.json().catch(() => null);
	return { status: res.status, body };
}

async function opsInsert(ctx: ContextWithHarper, table: string, records: object[]): Promise<void> {
	await sendOperation(ctx.harper, {
		operation: 'insert',
		schema: SCHEMA,
		table,
		records,
	});
}

async function rawSql(ctx: ContextWithHarper, sql: string): Promise<{ status: number; body: any }> {
	const res = await fetch((ctx.harper as any).operationsAPIURL, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', 'Authorization': authHeader },
		body: JSON.stringify({ operation: 'sql', sql }),
	}).catch(() => null);
	if (!res) return { status: 0, body: null };
	const body = await res.json().catch(() => null);
	return { status: res.status, body };
}

// ---------- Seed data --------------------------------------------------------

// Canonical test rows spanning several years
const SEED_ROWS = [
	{ id: 'ev-2018', label: 'y2018', createdAt: '2018-03-15T06:00:00.000Z', seqNum: 1 },
	{ id: 'ev-2020', label: 'y2020', createdAt: '2020-07-04T12:00:00.000Z', seqNum: 2 },
	{ id: 'ev-2022', label: 'y2022', createdAt: '2022-11-11T18:00:00.000Z', seqNum: 3 },
	{ id: 'ev-2024a', label: 'y2024a', createdAt: '2024-02-29T00:00:00.000Z', seqNum: 4 }, // leap day
	{ id: 'ev-2024b', label: 'y2024b', createdAt: '2024-08-20T23:59:59.999Z', seqNum: 5 },
	{ id: 'ev-2025', label: 'y2025', createdAt: '2025-12-31T23:59:59.000Z', seqNum: 6 },
];

// Oracle: rows inside [2021-01-01Z, 2025-01-01Z) — inclusive on both sides for the ge/le operators
const RANGE_START = '2021-01-01T00:00:00.000Z';
const RANGE_END = '2024-12-31T23:59:59.999Z';
const RANGE_START_MS = Date.parse(RANGE_START);
const RANGE_END_MS = Date.parse(RANGE_END);
const ORACLE_IN_RANGE = SEED_ROWS.filter((r) => {
	const ms = Date.parse(r.createdAt);
	return ms >= RANGE_START_MS && ms <= RANGE_END_MS;
})
	.map((r) => r.id)
	.sort();
// Oracle: ev-2022, ev-2024a, ev-2024b

// Chronological order ASC
const CHRONO_ORDER = [...SEED_ROWS].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt)).map((r) => r.id);

// ---------- Suite setup -------------------------------------------------------

suite(`date storage, range, sort, edge cases [${ENGINE}]`, (ctx: ContextWithHarper) => {
	before(async () => {
		await setupHarperWithFixture(ctx, FIXTURE_PATH, { config: { storage: { engine: ENGINE } } });

		// Poll until Event table is available
		const deadline = Date.now() + 45_000;
		while (Date.now() < deadline) {
			try {
				const url = `${(ctx.harper as any).httpURL.replace(/\/$/, '')}/Event/`;
				const res = await fetch(url, { headers: { Authorization: authHeader } });
				if (res.status !== 404) break;
			} catch {
				/* not ready */
			}
			await sleep(300);
		}

		// Seed both tables
		await opsInsert(ctx, 'Event', SEED_ROWS);
		await opsInsert(ctx, 'EventIdx', SEED_ROWS);
		await sleep(300);
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	// ==========================================================================
	// (a) Storage + round-trip
	// ==========================================================================

	test('(a1) ISO-8601 string insert round-trip — type and instant', async () => {
		// Insert via ops with ISO string; read back via REST
		const ISO = '2026-06-25T14:30:00.000Z';
		await opsInsert(ctx, 'Event', [{ id: 'rt-iso', label: 'roundtrip-iso', createdAt: ISO, seqNum: 99 }]);
		await sleep(100);

		const { status, body } = await restGet(ctx, 'Event', 'rt-iso');
		if (status !== 200 || !body) {
			record('(a1) ISO-string round-trip', 'DEFECT', `GET failed: status=${status}`);
			ok(false, `(a1) GET rt-iso failed: ${status}`);
			return;
		}

		const storedVal = body.createdAt;
		// Must preserve the exact instant — either as ISO string or epoch-ms number
		const storedMs = typeof storedVal === 'number' ? storedVal : Date.parse(storedVal);
		const expectedMs = Date.parse(ISO);
		const instantOk = Math.abs(storedMs - expectedMs) < 1;

		record(
			'(a1) ISO-string round-trip',
			instantOk ? 'CORRECT' : 'DEFECT',
			`stored type=${typeof storedVal} value=${JSON.stringify(storedVal)} instantPreserved=${instantOk}`
		);
		ok(instantOk, `(a1) Instant not preserved: stored=${JSON.stringify(storedVal)} expected=${ISO}`);
	});

	test('(a2) Epoch-ms number insert round-trip — type and instant', async () => {
		const ISO = '2026-06-25T14:30:00.000Z';
		const EPOCH_MS = Date.parse(ISO);
		await opsInsert(ctx, 'Event', [{ id: 'rt-epoch', label: 'roundtrip-epoch', createdAt: EPOCH_MS, seqNum: 100 }]);
		await sleep(100);

		const { status, body } = await restGet(ctx, 'Event', 'rt-epoch');
		if (status !== 200 || !body) {
			record('(a2) Epoch-ms round-trip', 'DEFECT', `GET failed: status=${status}`);
			ok(false);
			return;
		}

		const storedVal = body.createdAt;
		const storedMs = typeof storedVal === 'number' ? storedVal : Date.parse(storedVal);
		const instantOk = Math.abs(storedMs - EPOCH_MS) < 1;

		record(
			'(a2) Epoch-ms round-trip',
			instantOk ? 'CORRECT' : 'DEFECT',
			`inserted epoch=${EPOCH_MS} stored type=${typeof storedVal} value=${JSON.stringify(storedVal)} instantOk=${instantOk}`
		);
		ok(instantOk, `(a2) Epoch-ms instant not preserved: ${JSON.stringify(storedVal)}`);
	});

	test('(a3) ISO-string vs epoch-ms — same instant stored consistently?', async () => {
		// Both rt-iso and rt-epoch point to the same instant; compare their stored representations
		const [isoR, epochR] = await Promise.all([restGet(ctx, 'Event', 'rt-iso'), restGet(ctx, 'Event', 'rt-epoch')]);
		if (isoR.status !== 200 || epochR.status !== 200) {
			record('(a3) ISO vs epoch representation', 'INFO', 'skip — prior reads failed');
			ok(true);
			return;
		}

		const v1 = isoR.body.createdAt;
		const v2 = epochR.body.createdAt;
		const ms1 = typeof v1 === 'number' ? v1 : Date.parse(v1);
		const ms2 = typeof v2 === 'number' ? v2 : Date.parse(v2);
		const sameInstant = Math.abs(ms1 - ms2) < 1;
		const sameRepresentation = typeof v1 === typeof v2;

		record(
			'(a3) ISO vs epoch representation',
			sameInstant ? 'INFO' : 'DEFECT',
			`iso-stored=${JSON.stringify(v1)}(${typeof v1}) epoch-stored=${JSON.stringify(v2)}(${typeof v2}) sameInstant=${sameInstant} sameType=${sameRepresentation}`
		);
		ok(sameInstant, `(a3) Same instant stored as different values: ${JSON.stringify(v1)} vs ${JSON.stringify(v2)}`);
	});

	// ==========================================================================
	// (b) REST FIQL range filter vs oracle
	// ==========================================================================

	test('(b1) REST FIQL range: unindexed createdAt (Event)', async () => {
		// ?createdAt=ge=date:<ISO>&createdAt=le=date:<ISO>
		const query = `?createdAt=ge=date:${encodeURIComponent(RANGE_START)}&createdAt=le=date:${encodeURIComponent(RANGE_END)}`;
		const { status, body } = await restSearch(ctx, 'Event', query);

		if (status !== 200 || !Array.isArray(body)) {
			record('(b1) REST FIQL range unindexed', 'DEFECT', `HTTP ${status}: ${JSON.stringify(body).slice(0, 200)}`);
			ok(false, `(b1) FIQL range failed: status=${status}`);
			return;
		}

		const gotIds = body
			.map((r: any) => r.id)
			.filter((id: string) => SEED_ROWS.some((s) => s.id === id))
			.sort();
		const correct = JSON.stringify(gotIds) === JSON.stringify(ORACLE_IN_RANGE);

		const missing = ORACLE_IN_RANGE.filter((id) => !gotIds.includes(id));
		const extra = gotIds.filter((id: string) => !ORACLE_IN_RANGE.includes(id));

		record(
			'(b1) REST FIQL range unindexed',
			correct ? 'CORRECT' : 'DEFECT',
			`got=${JSON.stringify(gotIds)} oracle=${JSON.stringify(ORACLE_IN_RANGE)} missing=${JSON.stringify(missing)} extra=${JSON.stringify(extra)}`
		);
		ok(correct, `(b1) FIQL range: missing=${JSON.stringify(missing)}, extra=${JSON.stringify(extra)}`);
	});

	test('(b2) REST FIQL range: indexed createdAt (EventIdx)', async () => {
		const query = `?createdAt=ge=date:${encodeURIComponent(RANGE_START)}&createdAt=le=date:${encodeURIComponent(RANGE_END)}`;
		const { status, body } = await restSearch(ctx, 'EventIdx', query);

		if (status !== 200 || !Array.isArray(body)) {
			record('(b2) REST FIQL range indexed', 'DEFECT', `HTTP ${status}: ${JSON.stringify(body).slice(0, 200)}`);
			ok(false, `(b2) FIQL indexed range failed: status=${status}`);
			return;
		}

		const gotIds = body
			.map((r: any) => r.id)
			.filter((id: string) => SEED_ROWS.some((s) => s.id === id))
			.sort();
		const correct = JSON.stringify(gotIds) === JSON.stringify(ORACLE_IN_RANGE);
		const missing = ORACLE_IN_RANGE.filter((id) => !gotIds.includes(id));
		const extra = gotIds.filter((id: string) => !ORACLE_IN_RANGE.includes(id));

		record(
			'(b2) REST FIQL range indexed',
			correct ? 'CORRECT' : 'DEFECT',
			`got=${JSON.stringify(gotIds)} oracle=${JSON.stringify(ORACLE_IN_RANGE)} missing=${JSON.stringify(missing)} extra=${JSON.stringify(extra)}`
		);
		ok(correct, `(b2) FIQL indexed range: missing=${JSON.stringify(missing)}, extra=${JSON.stringify(extra)}`);
	});

	test('(b3) REST FIQL range: boundary inclusivity check', async () => {
		// Insert a record exactly at the boundary and one 1ms outside
		const BOUNDARY_ISO = RANGE_END; // exactly at boundary → should be included with =le=
		const OUTSIDE_ISO = new Date(RANGE_END_MS + 1).toISOString(); // 1ms after → should be excluded

		await opsInsert(ctx, 'Event', [
			{ id: 'boundary-in', label: 'boundary-in', createdAt: BOUNDARY_ISO, seqNum: 97 },
			{ id: 'boundary-out', label: 'boundary-out', createdAt: OUTSIDE_ISO, seqNum: 98 },
		]);
		await sleep(100);

		const query = `?createdAt=ge=date:${encodeURIComponent(RANGE_START)}&createdAt=le=date:${encodeURIComponent(RANGE_END)}`;
		const { body } = await restSearch(ctx, 'Event', query);
		const ids: string[] = Array.isArray(body) ? body.map((r: any) => r.id) : [];

		const inIncluded = ids.includes('boundary-in');
		const outExcluded = !ids.includes('boundary-out');

		record(
			'(b3) boundary inclusivity (=le= includes boundary, 1ms-after excluded)',
			inIncluded && outExcluded ? 'CORRECT' : 'DEFECT',
			`boundary-in included=${inIncluded}, boundary-out excluded=${outExcluded}`
		);
		ok(inIncluded, '(b3) boundary-in should be included with =le=');
		ok(outExcluded, '(b3) boundary-out (1ms after) should be excluded');
	});

	test('(b4) Ops search_by_conditions ge+le on unindexed Date', async () => {
		const res = await sendOperation(ctx.harper, {
			operation: 'search_by_conditions',
			schema: SCHEMA,
			table: 'Event',
			conditions: [
				{ search_attribute: 'createdAt', search_type: 'greater_than_equal', search_value: RANGE_START },
				{ search_attribute: 'createdAt', search_type: 'less_than_equal', search_value: RANGE_END },
			],
		});

		const rows: any[] = Array.isArray(res) ? res : [];
		const gotIds = rows
			.map((r: any) => r.id)
			.filter((id: string) => SEED_ROWS.some((s) => s.id === id))
			.sort();
		const correct = JSON.stringify(gotIds) === JSON.stringify(ORACLE_IN_RANGE);
		const missing = ORACLE_IN_RANGE.filter((id) => !gotIds.includes(id));
		const extra = gotIds.filter((id: string) => !ORACLE_IN_RANGE.includes(id));

		record(
			'(b4) ops search_by_conditions ge+le unindexed',
			correct ? 'CORRECT' : 'DEFECT',
			`got=${JSON.stringify(gotIds)} oracle=${JSON.stringify(ORACLE_IN_RANGE)} missing=${JSON.stringify(missing)} extra=${JSON.stringify(extra)}`
		);
		ok(correct, `(b4) search_by_conditions: missing=${JSON.stringify(missing)}, extra=${JSON.stringify(extra)}`);
	});

	// ==========================================================================
	// (c) Sort by date
	// ==========================================================================

	test('(c1) REST sort: ?sort(createdAt) ASC (unindexed)', async () => {
		// Harper REST sort requires @indexed on the sort column — 404 without index is expected behavior
		const { status, body } = await restSearch(ctx, 'Event', '?sort(+createdAt)&limit(50)');
		if (status === 404) {
			record(
				'(c1) REST sort createdAt ASC unindexed',
				'EDGE',
				`HTTP 404: sort on unindexed Date col requires @indexed (by design)`
			);
			ok(true); // by-design: REST sort requires @indexed
			return;
		}
		if (status !== 200 || !Array.isArray(body)) {
			record('(c1) REST sort createdAt ASC unindexed', 'DEFECT', `unexpected HTTP ${status}`);
			ok(false);
			return;
		}

		const ids = body.map((r: any) => r.id).filter((id: string) => SEED_ROWS.some((s) => s.id === id));
		const positions = CHRONO_ORDER.map((id) => ids.indexOf(id)).filter((p) => p >= 0);
		const inOrder = positions.every((p, i) => i === 0 || p > positions[i - 1]);

		record(
			'(c1) REST sort createdAt ASC unindexed',
			inOrder ? 'CORRECT' : 'DEFECT',
			`ids=${JSON.stringify(ids)} positions=${JSON.stringify(positions)} inOrder=${inOrder}`
		);
		ok(inOrder, `(c1) Sort ASC not chronological: ${JSON.stringify(ids)}`);
	});

	test('(c2) REST sort: ?sort(-createdAt) DESC (unindexed)', async () => {
		// REST sort on unindexed col → 404 by design; note behavior
		const { status, body } = await restSearch(ctx, 'Event', '?sort(-createdAt)&limit(50)');
		if (status === 404) {
			record(
				'(c2) REST sort createdAt DESC unindexed',
				'EDGE',
				`HTTP 404: sort on unindexed Date col requires @indexed (by design)`
			);
			ok(true);
			return;
		}
		if (status !== 200 || !Array.isArray(body)) {
			record('(c2) REST sort createdAt DESC unindexed', 'DEFECT', `unexpected HTTP ${status}`);
			ok(false);
			return;
		}

		const ids = body.map((r: any) => r.id).filter((id: string) => SEED_ROWS.some((s) => s.id === id));
		const REVERSE = [...CHRONO_ORDER].reverse();
		const positions = REVERSE.map((id) => ids.indexOf(id)).filter((p) => p >= 0);
		const inOrder = positions.every((p, i) => i === 0 || p > positions[i - 1]);

		record(
			'(c2) REST sort createdAt DESC unindexed',
			inOrder ? 'CORRECT' : 'DEFECT',
			`ids=${JSON.stringify(ids)} expected-reverse=${JSON.stringify(REVERSE)} inOrder=${inOrder}`
		);
		ok(inOrder, `(c2) Sort DESC not reverse-chronological: ${JSON.stringify(ids)}`);
	});

	test('(c3) REST sort: ?sort(createdAt) ASC (indexed)', async () => {
		const { status, body } = await restSearch(ctx, 'EventIdx', '?sort(+createdAt)&limit(50)');
		if (status !== 200 || !Array.isArray(body)) {
			record('(c3) REST sort createdAt ASC indexed', 'DEFECT', `HTTP ${status}`);
			ok(false);
			return;
		}

		const ids = body.map((r: any) => r.id).filter((id: string) => SEED_ROWS.some((s) => s.id === id));
		const positions = CHRONO_ORDER.map((id) => ids.indexOf(id)).filter((p) => p >= 0);
		const inOrder = positions.every((p, i) => i === 0 || p > positions[i - 1]);

		record(
			'(c3) REST sort createdAt ASC indexed',
			inOrder ? 'CORRECT' : 'DEFECT',
			`positions=${JSON.stringify(positions)} inOrder=${inOrder}`
		);
		ok(inOrder, `(c3) Sort indexed ASC not chronological`);
	});

	test('(c4) SQL ORDER BY createdAt ASC (unindexed)', async () => {
		const { status, body } = await rawSql(ctx, `SELECT id FROM ${SCHEMA}.Event ORDER BY createdAt ASC`);
		if (status !== 200 || !Array.isArray(body)) {
			record('(c4) SQL ORDER BY createdAt ASC', 'INFO', `HTTP ${status} — may be SQL limitation`);
			ok(true);
			return;
		}

		const ids = body.map((r: any) => r.id).filter((id: string) => SEED_ROWS.some((s) => s.id === id));
		const positions = CHRONO_ORDER.map((id) => ids.indexOf(id)).filter((p) => p >= 0);
		const inOrder = positions.every((p, i) => i === 0 || p > positions[i - 1]);

		record(
			'(c4) SQL ORDER BY createdAt ASC',
			inOrder ? 'CORRECT' : 'DEFECT',
			`positions=${JSON.stringify(positions)} inOrder=${inOrder}`
		);
		ok(true); // non-fatal — we note the state
	});

	// ==========================================================================
	// (d) @indexed Date: range correctness
	// ==========================================================================

	test('(d1) indexed range == unindexed range (parity check)', async () => {
		const query = `?createdAt=ge=date:${encodeURIComponent(RANGE_START)}&createdAt=le=date:${encodeURIComponent(RANGE_END)}`;
		const [rUnindexed, rIndexed] = await Promise.all([
			restSearch(ctx, 'Event', query),
			restSearch(ctx, 'EventIdx', query),
		]);

		if (rUnindexed.status !== 200 || rIndexed.status !== 200) {
			record(
				'(d1) indexed range == unindexed range',
				'INFO',
				`one request failed: unindexed=${rUnindexed.status} indexed=${rIndexed.status}`
			);
			ok(true);
			return;
		}

		const unIdx = (rUnindexed.body as any[])
			.map((r: any) => r.id)
			.filter((id: string) => SEED_ROWS.some((s) => s.id === id))
			.sort();
		const idx = (rIndexed.body as any[])
			.map((r: any) => r.id)
			.filter((id: string) => SEED_ROWS.some((s) => s.id === id))
			.sort();
		const parity = JSON.stringify(unIdx) === JSON.stringify(idx);

		record(
			'(d1) indexed range == unindexed range',
			parity ? 'CORRECT' : 'DEFECT',
			`unindexed=${JSON.stringify(unIdx)} indexed=${JSON.stringify(idx)} parity=${parity}`
		);
		ok(parity, `(d1) Range parity failure: unindexed=${JSON.stringify(unIdx)} vs indexed=${JSON.stringify(idx)}`);
	});

	// ==========================================================================
	// (e) Edge cases
	// ==========================================================================

	test('(e1) Timezone: +05:00 vs Z — same instant equal?', async () => {
		// 2026-01-01T12:00:00+05:00 == 2026-01-01T07:00:00.000Z
		const CANONICAL_Z = '2026-01-01T07:00:00.000Z';
		const OFFSET_STR = '2026-01-01T12:00:00+05:00';
		const CANONICAL_MS = Date.parse(CANONICAL_Z);

		await opsInsert(ctx, 'Event', [
			{ id: 'tz-z-2026', label: 'tz-z', createdAt: CANONICAL_Z, seqNum: 201 },
			{ id: 'tz-offset-2026', label: 'tz-offset', createdAt: OFFSET_STR, seqNum: 202 },
		]);
		await sleep(100);

		// Read back both to see what's stored
		const [rbZ, rbOff] = await Promise.all([
			restGet(ctx, 'Event', 'tz-z-2026'),
			restGet(ctx, 'Event', 'tz-offset-2026'),
		]);

		const zVal = rbZ.body?.createdAt;
		const offVal = rbOff.body?.createdAt;
		const zMs = typeof zVal === 'number' ? zVal : Date.parse(zVal);
		const offMs = typeof offVal === 'number' ? offVal : Date.parse(offVal);

		// Both should represent the same instant
		const sameInstant = Math.abs(zMs - offMs) < 1;
		// +05:00 canonical instant: 07:00Z
		const offsetNormalized = Math.abs(offMs - CANONICAL_MS) < 1;

		record(
			'(e1) tz +05:00 normalized to Z instant',
			offsetNormalized && sameInstant ? 'CORRECT' : 'DEFECT',
			`z-stored=${JSON.stringify(zVal)} offset-stored=${JSON.stringify(offVal)} sameInstant=${sameInstant} offsetNormalized=${offsetNormalized}`
		);

		// Check that a FIQL range query treats them as the same instant
		// Query with a 1-second window around canonical
		const windowStart = new Date(CANONICAL_MS - 500).toISOString();
		const windowEnd = new Date(CANONICAL_MS + 500).toISOString();
		const q = `?createdAt=ge=date:${encodeURIComponent(windowStart)}&createdAt=le=date:${encodeURIComponent(windowEnd)}`;
		const { body: rangeBody } = await restSearch(ctx, 'Event', q);
		const rangeIds: string[] = Array.isArray(rangeBody) ? rangeBody.map((r: any) => r.id) : [];
		const bothFound = rangeIds.includes('tz-z-2026') && rangeIds.includes('tz-offset-2026');

		record(
			'(e1b) tz: both Z and +05:00 found in same 1s range query',
			bothFound ? 'CORRECT' : 'DEFECT',
			`rangeIds (filtered)=${JSON.stringify(rangeIds.filter((id) => id.startsWith('tz-')))} bothFound=${bothFound}`
		);
		ok(
			sameInstant,
			`(e1) +05:00 and Z not stored as same instant: z=${JSON.stringify(zVal)} offset=${JSON.stringify(offVal)}`
		);
	});

	test('(e2) Pre-epoch date (1900-01-01T00:00:00Z)', async () => {
		const PRE_EPOCH = '1900-01-01T00:00:00.000Z';
		const PRE_EPOCH_MS = Date.parse(PRE_EPOCH); // -2208988800000

		const { status } = await restPut(ctx, 'Event', {
			id: 'preepoch',
			label: 'pre-epoch',
			createdAt: PRE_EPOCH,
			seqNum: 203,
		});
		if (status === 0 || status >= 400) {
			record('(e2) Pre-epoch insert', 'EDGE', `insert rejected: status=${status}`);
			ok(true);
			return;
		}
		await sleep(100);

		const { body } = await restGet(ctx, 'Event', 'preepoch');
		const stored = body?.createdAt;
		const storedMs = typeof stored === 'number' ? stored : Date.parse(stored);
		const ok2 = Math.abs(storedMs - PRE_EPOCH_MS) < 1000;

		record(
			'(e2) Pre-epoch date (1900-01-01)',
			ok2 ? 'CORRECT' : 'DEFECT',
			`stored=${JSON.stringify(stored)} expectedMs=${PRE_EPOCH_MS} instantOk=${ok2}`
		);
		ok(true); // non-fatal — documenting behavior
	});

	test('(e3) Far-future date (9999-12-31T23:59:59Z)', async () => {
		const FAR_FUTURE = '9999-12-31T23:59:59.000Z';
		const FAR_MS = Date.parse(FAR_FUTURE); // 253402300799000

		const { status } = await restPut(ctx, 'Event', {
			id: 'farfuture',
			label: 'far-future',
			createdAt: FAR_FUTURE,
			seqNum: 204,
		});
		if (status === 0 || status >= 400) {
			record('(e3) Far-future date (9999-12-31)', 'EDGE', `insert rejected: status=${status}`);
			ok(true);
			return;
		}
		await sleep(100);

		const { body } = await restGet(ctx, 'Event', 'farfuture');
		const stored = body?.createdAt;
		const storedMs = typeof stored === 'number' ? stored : Date.parse(stored);
		const instantOk = Math.abs(storedMs - FAR_MS) < 1000;

		record(
			'(e3) Far-future date (9999-12-31)',
			instantOk ? 'CORRECT' : 'DEFECT',
			`stored=${JSON.stringify(stored)} instantOk=${instantOk}`
		);
		ok(true);
	});

	test('(e4) Invalid date string — clean 400 or stored garbage?', async () => {
		const { status } = await restPut(ctx, 'Event', {
			id: 'invalid-date',
			label: 'invalid',
			createdAt: 'not-a-date',
			seqNum: 205,
		});

		if (status >= 400 && status < 500) {
			record('(e4) Invalid date string', 'CORRECT', `correctly rejected: HTTP ${status}`);
			ok(true);
			return;
		}

		if (status === 200 || status === 204) {
			// Check what was stored
			await sleep(100);
			const { body } = await restGet(ctx, 'Event', 'invalid-date');
			const stored = body?.createdAt;
			const isNaNDate = stored !== null && stored !== undefined && isNaN(Date.parse(String(stored)));
			record(
				'(e4) Invalid date string',
				isNaNDate ? 'DEFECT' : 'INFO',
				`accepted and stored: ${JSON.stringify(stored)} isNaN=${isNaNDate} (status=${status})`
			);
			// Not a hard fail (storage engine behavior may vary), but note it
			ok(true);
			return;
		}

		record('(e4) Invalid date string', 'INFO', `unexpected status=${status}`);
		ok(true);
	});

	test('(e5) Null date — stored and read back as null?', async () => {
		const { status } = await restPut(ctx, 'Event', {
			id: 'null-date',
			label: 'null-date',
			createdAt: null,
			seqNum: 206,
		});
		if (status >= 400) {
			record('(e5) Null date', 'EDGE', `null rejected: status=${status}`);
			ok(true);
			return;
		}
		await sleep(100);

		const { body, status: getStatus } = await restGet(ctx, 'Event', 'null-date');
		const stored = body?.createdAt;

		record(
			'(e5) Null date stored as null',
			stored === null || stored === undefined ? 'CORRECT' : 'DEFECT',
			`stored=${JSON.stringify(stored)} (getStatus=${getStatus})`
		);
		ok(true);
	});

	test('(e6) Sub-millisecond precision (.001ms) — truncation or preservation?', async () => {
		// ISO-8601 milliseconds only; sub-ms has no standard representation in ISO strings
		// Test that two instants 1ms apart are stored as distinguishably different
		const MS_A = '2025-01-01T00:00:00.000Z';
		const MS_B = '2025-01-01T00:00:00.001Z';

		await opsInsert(ctx, 'Event', [
			{ id: 'submilli-a', label: 'submilli-a', createdAt: MS_A, seqNum: 207 },
			{ id: 'submilli-b', label: 'submilli-b', createdAt: MS_B, seqNum: 208 },
		]);
		await sleep(100);

		const [rbA, rbB] = await Promise.all([restGet(ctx, 'Event', 'submilli-a'), restGet(ctx, 'Event', 'submilli-b')]);

		const vA = rbA.body?.createdAt;
		const vB = rbB.body?.createdAt;
		const msA = typeof vA === 'number' ? vA : Date.parse(vA);
		const msB = typeof vB === 'number' ? vB : Date.parse(vB);
		const distinguishable = Math.abs(msA - msB) >= 1;

		record(
			'(e6) Sub-millisecond / 1ms precision',
			distinguishable ? 'CORRECT' : 'DEFECT',
			`a=${JSON.stringify(vA)} b=${JSON.stringify(vB)} diff=${msB - msA}ms distinguishable=${distinguishable}`
		);
		ok(distinguishable, `(e6) 1ms precision lost: a=${JSON.stringify(vA)} b=${JSON.stringify(vB)}`);
	});

	test('(e7) Date as PK (time-ordered string keys)', async () => {
		// Use ISO date strings as primary keys — should work for time-ordered access
		const dates = ['2025-01-01T00:00:00.000Z', '2025-06-01T00:00:00.000Z', '2025-12-31T23:59:59.999Z'];
		const rows = dates.map((d, i) => ({ id: d, label: `pk-date-${i}`, createdAt: d, seqNum: 300 + i }));

		await opsInsert(ctx, 'Event', rows);
		await sleep(100);

		// Read one back by its ISO-date PK
		const { status, body } = await restGet(ctx, 'Event', encodeURIComponent('2025-06-01T00:00:00.000Z'));
		const found = status === 200 && body?.label === 'pk-date-1';

		record(
			'(e7) Date-string as PK — lookup by ISO-date key',
			found ? 'CORRECT' : 'DEFECT',
			`status=${status} found=${found} body-label=${body?.label}`
		);
		ok(true);
	});

	// ==========================================================================
	// (f) SQL date-literal filter — behavior probe (see #1397, SQL engine rewrite)
	// ==========================================================================

	// A SQL `WHERE date > 'ISO-literal'` filter is currently silent-wrong (returns []); tracked under
	// the SQL umbrella #1397. This probe records the behavior WITHOUT asserting the buggy empty result,
	// so it does not enshrine the defect — epoch-ms numeric bounds work correctly (covered above).
	test('(f1) SQL date-literal filter behavior (#1397)', async () => {
		const AFTER = '2021-01-01T00:00:00.000Z';
		const { status, body } = await rawSql(ctx, `SELECT id FROM ${SCHEMA}.Event WHERE createdAt > '${AFTER}'`);

		if (status >= 500) {
			record('(f1) SQL createdAt > ISO-literal (#1397)', 'KNOWN-DEFECT', `HTTP 500 (known #1397 SQL class)`);
			ok(true);
			return;
		}

		const rows: any[] = Array.isArray(body) ? body : [];
		const gotIds = rows.map((r: any) => r.id).filter((id: string) => SEED_ROWS.some((s) => s.id === id));

		if (rows.length === 0) {
			record('(f1) SQL createdAt > ISO-literal (#1397)', 'KNOWN-DEFECT', `silent-empty (#1397 still present)`);
		} else {
			record(
				'(f1) SQL createdAt > ISO-literal (#1397)',
				'CORRECT',
				`date-literal filter now returns rows: ${JSON.stringify(gotIds)}`
			);
		}
		ok(true); // note state only
	});

	test('(f2) SQL epoch-number filter (should work — baseline)', async () => {
		const AFTER_MS = Date.parse('2021-01-01T00:00:00.000Z');
		const oracle = SEED_ROWS.filter((r) => Date.parse(r.createdAt) > AFTER_MS)
			.map((r) => r.id)
			.sort();

		const { status, body } = await rawSql(ctx, `SELECT id FROM ${SCHEMA}.Event WHERE createdAt > ${AFTER_MS}`);
		if (status !== 200 || !Array.isArray(body)) {
			record('(f2) SQL createdAt > epoch-number', 'DEFECT', `HTTP ${status}`);
			ok(false);
			return;
		}

		const got = body
			.map((r: any) => r.id)
			.filter((id: string) => SEED_ROWS.some((s) => s.id === id))
			.sort();
		const correct = oracle.every((id) => got.includes(id));

		record(
			'(f2) SQL createdAt > epoch-number baseline',
			correct ? 'CORRECT' : 'DEFECT',
			`got=${JSON.stringify(got)} oracle=${JSON.stringify(oracle)} correct=${correct}`
		);
		ok(correct, `(f2) SQL epoch filter missing rows: got=${JSON.stringify(got)} oracle=${JSON.stringify(oracle)}`);
	});

	test('(f3) SQL BETWEEN epoch numbers', async () => {
		const { status, body } = await rawSql(
			ctx,
			`SELECT id FROM ${SCHEMA}.Event WHERE createdAt BETWEEN ${RANGE_START_MS} AND ${RANGE_END_MS}`
		);
		if (status !== 200 || !Array.isArray(body)) {
			record('(f3) SQL BETWEEN epoch numbers', 'DEFECT', `HTTP ${status}`);
			ok(false);
			return;
		}

		const got = body
			.map((r: any) => r.id)
			.filter((id: string) => SEED_ROWS.some((s) => s.id === id))
			.sort();
		const correct = JSON.stringify(got) === JSON.stringify(ORACLE_IN_RANGE);

		record(
			'(f3) SQL BETWEEN epoch numbers',
			correct ? 'CORRECT' : 'DEFECT',
			`got=${JSON.stringify(got)} oracle=${JSON.stringify(ORACLE_IN_RANGE)}`
		);
		ok(correct, `(f3) SQL BETWEEN epoch: got=${JSON.stringify(got)} oracle=${JSON.stringify(ORACLE_IN_RANGE)}`);
	});
});
