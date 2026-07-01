/**
 * P-135 / QA-181 — post-cap-saturation FIDELITY of the structon maxOwnStructures=256 cap.
 *
 * Background / premise under test
 * -------------------------------
 * QA-175 proved the structon `maxOwnStructures=256` cap BOUNDS MEMORY under key-set-
 * heterogeneous ingest: the per-encoder `typedStructs` dictionary plateaus at exactly
 * 256 instead of growing toward OOM (the real ~15,700-struct field incident). QA-181
 * probes the FLIP SIDE — FIDELITY.
 *
 * There was a historical defect family (#1282, the maxOwnStructures-dataloss bug, fixed
 * in structon >= 1.0.7) where records that minted a typed structure AFTER the cap
 * saturated could be silently LOST or WRONG-DECODED. The question this test answers:
 * with the cap in place (structon 1.0.7), are post-cap-saturation records still
 * round-tripped CORRECTLY?
 *
 * Design
 * ------
 * - One wide-open `@table(randomAccessFields: true)` table (id only, NOT @sealed) —
 *   engages the TYPED random-access struct path the cap governs (5.1 default = false,
 *   so the fixture sets it true).
 * - `makeRecord(id)` mints a DETERMINISTIC, recomputable record: the field-NAME set is
 *   a function of the shape index (== id), VALUES are a function of (id, fieldName) and
 *   span small int / string / boolean / float / large int. The shape index advances
 *   every record, so NOVEL field-sets keep appearing past record 256 — the cap
 *   saturates partway through and later records (#257..#N) hit the post-cap path.
 * - Bulk-load RECORD_COUNT (> 500) records, then read EVERY record back two ways:
 *     (a) REST GET by id   — /CapFidelity/<id>
 *     (b) full scan (SQL)  — SELECT * FROM data.CapFidelity
 *   and diff every attribute against the recomputed expected record. Extra attention is
 *   paid to post-cap records (shape >= the observed cap-saturation point).
 * - A `CapEncodeProbe` custom resource (resources.js) drives the inner randomAccess
 *   store's encoder IN-WORKER over the SAME shapes to CONFIRM typedStructs saturated at
 *   256 during the load — proving the post-cap records genuinely hit the fallback path.
 *   (An HTTP insert does not encode on the receiving worker, so the cap must be
 *   confirmed in-worker; but the FIDELITY assertion uses the real write->read round-trip
 *   through storage, which IS the encode path we want to verify.)
 *
 * Result is reported inline (see console output) and asserted: EXPECTED outcome is
 * full fidelity on every record incl. post-cap (a green #1282 regression guard); any
 * silent field loss / wrong value / missing attribute / decode error = DEFECT.
 *
 * structon version: 1.0.7 (ships the maxOwnStructures cap = the #1282 fix).
 * Harper SHA: 7aaa5a152
 *
 * Reproduction (rocksdb default):
 *   npm run test:integration -- "integrationTests/database/struct-cache-fidelity.test.ts"
 * Reproduction (lmdb):
 *   HARPER_STORAGE_ENGINE=lmdb npm run test:integration -- "integrationTests/database/struct-cache-fidelity.test.ts"
 */
import { suite, test, before, after } from 'node:test';
import { ok, deepStrictEqual } from 'node:assert/strict';
import { resolve } from 'node:path';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
// @ts-expect-error utils/client.mjs has no type declarations; runtime resolves fine
import { createApiClient } from '../apiTests/utils/client.mjs';
import { setTimeout as sleep } from 'node:timers/promises';

const FIXTURE_PATH = resolve(import.meta.dirname, 'struct-cache-fidelity');
const skipSuite = process.platform === 'win32';
const ENGINE = process.env.HARPER_STORAGE_ENGINE || 'rocksdb(default)';

const CAP = 256; // RecordEncoder pins maxOwnStructures = 256
// Enough past the cap so the cap saturates and we have post-cap records.
const RECORD_COUNT = 260;

// ---- deterministic shape generator — MUST mirror resources.js makeRecord ----------------
const POOL_SIZE = 90;
const fieldName = (j: number) => 'f' + j;
function fieldValue(id: number, j: number): number | string | boolean {
	const kind = j % 5;
	if (kind === 0) return id * 1000 + j; // small int
	if (kind === 1) return `s_${id}_${j}`; // string
	if (kind === 2) return id % 2 === 0; // boolean
	if (kind === 3) return (id + j) * 0.5 + 0.125; // float
	return id * 1_000_000_000 + j; // large int (> 32-bit)
}
function shapeFields(s: number): number[] {
	const size = 3 + (s % 11);
	const start = (s * 7) % POOL_SIZE;
	const stride = 1 + (s % 3);
	const fields: number[] = [];
	const seen = new Set<number>();
	for (let k = 0; k < size; k++) {
		const j = (start + k * stride) % POOL_SIZE;
		if (seen.has(j)) continue;
		seen.add(j);
		fields.push(j);
	}
	return fields;
}
// Stored primary key `id` is a STRING (the `id: ID` column requires string keys); the
// numeric idx still drives the deterministic field-set + values. So shape #257 == idx 257.
function makeRecord(idx: number): Record<string, unknown> {
	const rec: Record<string, unknown> = { id: String(idx) };
	for (const j of shapeFields(idx)) rec[fieldName(j)] = fieldValue(idx, j);
	return rec;
}
/** Canonical, order-independent expected attribute map for shape `idx`. */
function expectedAttrs(idx: number): Record<string, unknown> {
	return makeRecord(idx);
}

interface EncodeResult {
	maxOwnStructures: number | null;
	randomAccessStructure: boolean | null;
	typedStructsBefore: number | null;
	typedStructsAfter: number | null;
	firstCapHit: number | null;
	growthTrace: number[];
	encoded: number;
}

/** Distinct field-NAME sets across all shapes — confirms the load is genuinely heterogeneous. */
function countDistinctShapes(n: number): number {
	const set = new Set<string>();
	for (let id = 0; id < n; id++)
		set.add(
			shapeFields(id)
				.slice()
				.sort((a, b) => a - b)
				.join(',')
		);
	return set.size;
}

/** Compare actual record body to expected; return list of human-readable mismatches. */
function diffRecord(id: number, actual: Record<string, unknown> | undefined): string[] {
	const problems: string[] = [];
	if (!actual || typeof actual !== 'object') {
		return [`id=${id}: record MISSING from read-back (got ${JSON.stringify(actual)})`];
	}
	const exp = expectedAttrs(id);
	// Every expected attribute must be present and equal (silent field loss / wrong value).
	for (const [k, v] of Object.entries(exp)) {
		if (!(k in actual)) {
			problems.push(`id=${id}: MISSING attr "${k}" (expected ${JSON.stringify(v)})`);
			continue;
		}
		const a = actual[k];
		if (!Object.is(a, v) && JSON.stringify(a) !== JSON.stringify(v)) {
			problems.push(`id=${id}: attr "${k}" WRONG: expected ${JSON.stringify(v)} got ${JSON.stringify(a)}`);
		}
	}
	// No EXTRA non-system attributes (a wrong-decode could surface phantom fields).
	for (const k of Object.keys(actual)) {
		if (k.startsWith('__') || k === 'id') continue; // ignore harper system attrs (e.g. __updatedtime__)
		if (!(k in exp)) problems.push(`id=${id}: EXTRA/phantom attr "${k}"=${JSON.stringify(actual[k])}`);
	}
	return problems;
}

suite(`QA-181 post-cap fidelity [engine=${ENGINE}]`, { skip: skipSuite }, (ctx: ContextWithHarper) => {
	let client: ReturnType<typeof createApiClient>;

	before(async () => {
		await setupHarperWithFixture(ctx, FIXTURE_PATH, { config: {}, env: {} });
		client = createApiClient(ctx.harper);
		// Poll for route readiness (component is pre-installed; no restart needed)
		{
			const deadline = Date.now() + 120_000;
			while (Date.now() < deadline) {
				try {
					const probe = await client.reqRest('/CapFidelity/').timeout(2000);
					if (probe.status !== 404) break;
				} catch {
					/* not ready yet */
				}
				await sleep(250);
			}
		}
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	test('post-cap records round-trip with full fidelity (cap saturates at 256)', async () => {
		const distinctShapes = countDistinctShapes(RECORD_COUNT);
		ok(
			distinctShapes > CAP,
			`generator must produce > ${CAP} distinct field-sets to saturate the cap; got ${distinctShapes}`
		);

		// ---- 1. bulk-load every record (encoded on the storage/write path) ----
		const records = Array.from({ length: RECORD_COUNT }, (_, id) => makeRecord(id));
		await client
			.req()
			.send({ operation: 'insert', schema: 'data', table: 'CapFidelity', records })
			.timeout(60_000)
			.expect(200);

		// ---- 2. confirm the cap SATURATED at 256 in-worker over the same shapes ----
		const probeResp = await client.reqRest(`/CapEncodeProbe/?count=${RECORD_COUNT}`).timeout(60_000);
		const probe = probeResp.body as EncodeResult;
		const cap = probe.maxOwnStructures ?? CAP;
		const onTypedPath = probe.randomAccessStructure === true;
		const saturated = probe.typedStructsAfter === cap;
		// post-cap records are those whose shape index is >= where typedStructs first hit the cap
		const capHitAt = probe.firstCapHit;

		// ---- 3. read EVERY record back via REST GET by id; diff every field ----
		const allProblems: string[] = [];
		let postCapChecked = 0;
		let postCapClean = 0;
		for (let id = 0; id < RECORD_COUNT; id++) {
			const r = await client.reqRest(`/CapFidelity/${id}`).timeout(10_000);
			const body = r.status === 200 ? (r.body as Record<string, unknown>) : undefined;
			const problems = diffRecord(id, body);
			const isPostCap = capHitAt != null && id >= capHitAt;
			if (isPostCap) {
				postCapChecked++;
				if (problems.length === 0) postCapClean++;
			}
			if (problems.length) allProblems.push(...problems.map((p) => `[GET]   ${p}`));
		}

		// ---- 4. read EVERY record back via FULL SCAN; diff every field ----
		// NB: SQL `SELECT *` only projects the table's KNOWN columns and null-pads dynamic
		// schema-less attributes, so it cannot witness per-record dynamic-attr fidelity. We
		// instead use a batched `search_by_id` with get_attributes:['*'], which returns the
		// COMPLETE stored record (the real storage-decode path) for every id at once — a true
		// full scan of the data with no column projection.
		const allIds = Array.from({ length: RECORD_COUNT }, (_, id) => String(id));
		const scanResp = await client
			.req()
			.send({ operation: 'search_by_id', schema: 'data', table: 'CapFidelity', ids: allIds, get_attributes: ['*'] })
			.timeout(60_000)
			.expect(200);
		const scanRows = (scanResp.body as Array<Record<string, unknown>>) ?? [];
		const byId = new Map<number, Record<string, unknown>>();
		for (const row of scanRows) {
			const rid = typeof row.id === 'string' ? Number(row.id) : (row.id as number);
			byId.set(rid, row);
		}
		ok(
			scanRows.length === RECORD_COUNT,
			`full scan should return all ${RECORD_COUNT} rows, got ${scanRows.length} (missing rows = silent loss)`
		);
		for (let id = 0; id < RECORD_COUNT; id++) {
			const row = byId.get(id);
			if (!row) {
				allProblems.push(`[SCAN]  id=${id}: row absent from full-scan result (silent loss)`);
				continue;
			}
			// Reuse the same full-record diff used for GET — catches loss, wrong value, phantom attr.
			allProblems.push(...diffRecord(id, row).map((p) => `[SCAN]  ${p}`));
		}

		const sample = allProblems.slice(0, 25);
		console.log(
			`\n[QA-181 engine=${ENGINE}] records=${RECORD_COUNT}, distinct shapes=${distinctShapes}, cap=${cap}\n` +
				`  CAP CONFIRMATION (in-worker over same shapes):\n` +
				`     randomAccess typed path = ${onTypedPath}\n` +
				`     typedStructs ${probe.typedStructsBefore} -> ${probe.typedStructsAfter}  trace=[${probe.growthTrace?.join(', ')}]\n` +
				`     cap saturated (== ${cap})? ${saturated} ; first hit cap at shape/id = ${capHitAt}\n` +
				`  FIDELITY:\n` +
				`     post-cap records checked = ${postCapChecked}, clean = ${postCapClean}\n` +
				`     total fidelity problems (GET + SCAN) = ${allProblems.length}\n` +
				(sample.length ? `     sample:\n${sample.map((p) => '       - ' + p).join('\n')}\n` : '') +
				`  READ:\n` +
				`     ${
					allProblems.length === 0 && saturated && onTypedPath
						? '>>> FULL FIDELITY incl. post-cap — EXPECTED (green #1282 regression guard).'
						: allProblems.length > 0
							? '>>> FIDELITY FAILURES detected — possible #1282 regression (DEFECT). See sample above.'
							: '>>> INCONCLUSIVE — cap did not saturate / typed path not engaged; re-check fixture.'
				}`
		);

		// ---- assertions ----
		// Sanity: we genuinely exercised the typed/random-access struct path + saturated the cap.
		ok(onTypedPath, `probe must be on the randomAccess typed path; got ${probe.randomAccessStructure}`);
		ok(
			saturated,
			`typedStructs must saturate the cap (expected ${cap}, got ${probe.typedStructsAfter}); ` +
				`if << cap the post-cap fallback path was never exercised — test is inconclusive`
		);
		ok(
			capHitAt != null && capHitAt < RECORD_COUNT - 1,
			`cap must saturate BEFORE the last record so there ARE post-cap records to verify (firstCapHit=${capHitAt})`
		);
		ok(postCapChecked > 0, `must have verified at least one post-cap-saturation record (checked ${postCapChecked})`);

		// THE KEY ASSERTION — every record (esp. post-cap) round-trips with full fidelity.
		deepStrictEqual(
			allProblems,
			[],
			`expected ZERO fidelity problems (full round-trip incl. post-cap). ${allProblems.length} found; ` +
				`first 25: \n${sample.join('\n')}`
		);
	});
});
