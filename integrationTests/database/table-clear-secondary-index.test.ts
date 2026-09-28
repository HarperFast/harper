/**
 * Regression anchor for harper#1906 ("fix(resources): Table.clear() also clears secondary index
 * dbis", merged 2026-07-27). Before that fix `Table.clear()` wiped only the primary store, so
 * every secondary-index entry of the cleared rows survived as a dangling reference; a later
 * indexed query could then resolve to rows that no longer exist, and re-populating the table
 * left stale pre-clear entries beside the new ones.
 *
 * The PR's own unit test (unitTests/resources/tableClearSecondaryIndex.test.js) covers the
 * single-indexed-attribute happy path through a query-level oracle. This spec pins the corners
 * that test cannot see, on both storage engines (rerun with HARPER_STORAGE_ENGINE=lmdb):
 *   - clear() on a table with MULTIPLE @indexed attributes, one of which is null/absent on some
 *     rows (the null-keyed index-entry shape).
 *   - clear() racing the TTL/expiration background sweep (both deleting concurrently).
 *   - writes AFTER clear() -- the re-populated table indexes cleanly, nothing resurfaces.
 *
 * Oracle: DIRECT raw-store reads only -- never search_by_value or an indexed REST query, which
 * join through the primary record and by construction SKIP any index entry whose primary row is
 * gone, so they can never observe a dangling entry. IndexDump reads index.getRange({start:null})
 * (an unqualified getRange() on LMDB starts AFTER null and silently skips null-keyed entries);
 * Dump reads the raw primaryStore. Q0 first PLANTS a dangling entry directly into the index dbi
 * and confirms IndexDump reports it, so a later "0 dangling" result is evidence rather than
 * blindness.
 *
 * Fails-on-base: with the #1906 hunk absent, Q0's post-clear check, Q2 and Q3 go red (index
 * entries survive clear()).
 *
 * Originating QA scenario: QA-678 (promote candidate P-455).
 */
import { suite, test, before, after } from 'node:test';
import { strictEqual } from 'node:assert';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
// @ts-expect-error utils/client.mjs has no type declarations; runtime resolves fine
import { createApiClient } from '../apiTests/utils/client.mjs';

const FIXTURE_PATH = resolve(import.meta.dirname, 'table-clear-secondary-index');
const ENGINE = process.env.HARPER_STORAGE_ENGINE === 'lmdb' ? 'lmdb' : 'rocksdb';
const skipSuite = process.platform === 'win32';

interface BaseRow {
	id: string;
	tagA: string;
	tagB: string | null | undefined;
}
interface IndexRow {
	indexedValue: unknown;
	primaryKey: string;
}

const matrix: Array<Record<string, unknown>> = [];

function ids(prefix: string, n: number): string[] {
	return Array.from({ length: n }, (_, i) => `${prefix}-${String(i).padStart(4, '0')}`);
}

suite(`Table.clear() clears secondary indexes (#1906) [${ENGINE}]`, { skip: skipSuite }, (ctx: ContextWithHarper) => {
	let httpURL: string;
	let auth: string;

	before(async () => {
		await setupHarperWithFixture(ctx, FIXTURE_PATH, {
			config: {
				threads: { count: 1 },
				logging: { console: true, level: 'error' },
				...(ENGINE === 'lmdb' ? { storage: { engine: 'lmdb' } } : {}),
			},
			env: {},
		});
		const client = createApiClient(ctx.harper);
		httpURL = ctx.harper.httpURL;
		auth = client.headers.Authorization;

		// Poll first REST route until it stops 404ing (no restartHttpWorkers() against a
		// pre-installed fixture).
		const deadline = Date.now() + 120_000;
		while (Date.now() < deadline) {
			try {
				const probe = await fetch(`${httpURL}/Dump/?table=IdxTable`, {
					headers: { Authorization: auth },
					signal: AbortSignal.timeout(3_000),
				});
				if (probe.status !== 404) break;
			} catch {
				/* not ready yet */
			}
			await sleep(250);
		}
	});

	after(async () => {
		await teardownHarper(ctx);
		console.log(`\n[table-clear MATRIX ${ENGINE}]\n${JSON.stringify(matrix, null, 2)}`);
	});

	async function getJSON(path: string): Promise<any> {
		const r = await fetch(`${httpURL}${path}`, {
			headers: { Authorization: auth },
			signal: AbortSignal.timeout(30_000),
		});
		if (r.status !== 200) {
			const text = await r.text().catch(() => '');
			throw new Error(`${path} should return 200, got ${r.status}: ${text}`);
		}
		return r.json();
	}
	async function post(path: string, body: unknown, timeoutMs = 30_000): Promise<any> {
		const r = await fetch(`${httpURL}${path}`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', 'Authorization': auth },
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(timeoutMs),
		});
		if (r.status !== 200) {
			const text = await r.text().catch(() => '');
			throw new Error(`POST ${path} should return 200, got ${r.status}: ${text}`);
		}
		return r.json();
	}
	async function dump(table: string): Promise<BaseRow[]> {
		return getJSON(`/Dump/?table=${table}`);
	}
	async function indexDump(table: string, attr: string): Promise<IndexRow[]> {
		return getJSON(`/IndexDump/?table=${table}&attr=${attr}`);
	}

	function report(label: string, extra: Record<string, unknown>) {
		console.log(`[table-clear ${ENGINE}] ${label}: ${JSON.stringify(extra)}`);
		matrix.push({ label, engine: ENGINE, ...extra });
	}

	// ---- Q0: prove the oracle is NOT blind before trusting any "0 dangling" result later --------
	test(
		'Q0 oracle self-proof: a planted dangling index entry IS visible via IndexDump',
		{ timeout: 15_000 },
		async () => {
			// Table is empty at this point. Write directly into the raw tagA index dbi with no
			// corresponding primary row -- a manufactured F-149-style dangling entry.
			await post('/PlantDangling/', { table: 'IdxTable', attr: 'tagA', value: 'PLANTED', key: 'ghost-0' });
			const idx = await indexDump('IdxTable', 'tagA');
			report('Q0 planted-dangling', { indexCount: idx.length, entries: idx });
			strictEqual(idx.length, 1, 'IndexDump must see the planted dangling entry (oracle is not blind)');
			strictEqual(idx[0].primaryKey, 'ghost-0');
			strictEqual(idx[0].indexedValue, 'PLANTED');

			// Reset to a clean slate for Q1 using clear() itself -- also an early smoke check that
			// clear() removes even a manually-planted stray entry.
			await post('/ClearTable/', { table: 'IdxTable' });
			const idxAfter = await indexDump('IdxTable', 'tagA');
			strictEqual(idxAfter.length, 0, 'clear() should wipe the planted dangling entry too');
		}
	);

	// ---- Q1: load multi-indexed rows, one attribute null/absent on some rows ---------------------
	test('Q1 load 30 rows across 2 indexed attrs (tagB null/absent on some)', { timeout: 15_000 }, async () => {
		// 12 rows: tagA=A1, tagB='B1' (real value on both indexed attrs)
		await post('/Load/', { table: 'IdxTable', ids: ids('real', 12), tagA: 'A1', tagB: 'B1' });
		// 9 rows: tagA=A1, tagB=null (EXPLICIT null -> F-175 null-keyed index entry)
		await post('/Load/', { table: 'IdxTable', ids: ids('null', 9), tagA: 'A1', tagB: null });
		// 9 rows: tagA=A2, tagB ABSENT (property never set -> not indexed at all, distinct corner)
		await post('/Load/', { table: 'IdxTable', ids: ids('absent', 9), tagA: 'A2' });

		const base = await dump('IdxTable');
		const idxA = await indexDump('IdxTable', 'tagA');
		const idxB = await indexDump('IdxTable', 'tagB');
		const nullKeyedB = idxB.filter((e) => e.indexedValue === null);
		report('Q1 pre-clear', {
			baseCount: base.length,
			idxACount: idxA.length,
			idxBCount: idxB.length,
			nullKeyedB: nullKeyedB.length,
		});

		strictEqual(base.length, 30, 'all 30 rows present pre-clear');
		strictEqual(idxA.length, 30, 'tagA indexed on all 30 rows');
		strictEqual(idxB.length, 21, 'tagB indexed on the 12 real + 9 null rows only (21), absent rows not indexed');
		strictEqual(nullKeyedB.length, 9, 'exactly 9 null-keyed tagB index entries pre-clear');
	});

	// ---- Q2: clear() must wipe BOTH primary store and BOTH secondary indexes, including nulls ---
	test(
		'Q2 clear(): primary AND both secondary indexes (incl. null-keyed) must be empty',
		{ timeout: 15_000 },
		async () => {
			await post('/ClearTable/', { table: 'IdxTable' });

			const base = await dump('IdxTable');
			const idxA = await indexDump('IdxTable', 'tagA');
			const idxB = await indexDump('IdxTable', 'tagB');
			report('Q2 post-clear', { baseCount: base.length, idxACount: idxA.length, idxBCount: idxB.length });

			strictEqual(base.length, 0, 'primary store empty after clear()');
			strictEqual(idxA.length, 0, `tagA index should be fully empty after clear(), got ${idxA.length}`);
			strictEqual(
				idxB.length,
				0,
				`tagB index (incl. null-keyed entries) should be fully empty after clear(), got ${idxB.length}: ${JSON.stringify(idxB)}`
			);
		}
	);

	// ---- Q3: writes AFTER clear() must not resurrect stale pre-clear index entries ---------------
	test('Q3 post-clear writes: no stale pre-clear entries resurface', { timeout: 15_000 }, async () => {
		// New rows, DIFFERENT tagA/tagB values than pre-clear, plus a fresh null/absent split.
		await post('/Load/', { table: 'IdxTable', ids: ids('new-real', 5), tagA: 'A3', tagB: 'B2' });
		await post('/Load/', { table: 'IdxTable', ids: ids('new-null', 5), tagA: 'A3', tagB: null });
		await post('/Load/', { table: 'IdxTable', ids: ids('new-absent', 5), tagA: 'A3' });

		const base = await dump('IdxTable');
		const idxA = await indexDump('IdxTable', 'tagA');
		const idxB = await indexDump('IdxTable', 'tagB');
		const staleA1orA2 = idxA.filter((e) => e.indexedValue === 'A1' || e.indexedValue === 'A2');
		const staleB1 = idxB.filter((e) => e.indexedValue === 'B1');
		const nullKeyedB = idxB.filter((e) => e.indexedValue === null);

		report('Q3 post-clear-write', {
			baseCount: base.length,
			idxACount: idxA.length,
			idxBCount: idxB.length,
			staleA1orA2: staleA1orA2.length,
			staleB1: staleB1.length,
			nullKeyedB: nullKeyedB.length,
		});

		strictEqual(base.length, 15, 'all 15 new rows present');
		strictEqual(idxA.length, 15, 'tagA indexed on all 15 new rows, nothing stale');
		strictEqual(staleA1orA2.length, 0, 'no stale pre-clear tagA=A1/A2 entries resurfaced');
		strictEqual(idxB.length, 10, 'tagB indexed on the 5 real + 5 null new rows (10); absent not indexed');
		strictEqual(staleB1.length, 0, 'no stale pre-clear tagB=B1 entries resurfaced');
		strictEqual(nullKeyedB.length, 5, 'exactly 5 fresh null-keyed tagB entries, not the old 9');
	});

	// ---- Q4: clear() racing the TTL/expiration background sweep -----------------------------------
	test('Q4 clear() concurrent with an active TTL eviction sweep', { timeout: 30_000 }, async () => {
		const ttlIds = ids('ttl', 20);
		await post('/Load/', { table: 'TtlTable', ids: ttlIds, tagA: 'T1' });
		const baseBefore = await dump('TtlTable');
		strictEqual(baseBefore.length, 20, 'all 20 TTL rows present pre-expiry');

		// expiration:3s, scanInterval:1s. Wait into the window where the sweep is actively
		// evicting (some rows gone, some not), THEN fire clear() concurrently with the sweep
		// still running -- the race the PR's unit test cannot exercise. The assertions below do not
		// depend on the race being won either way: after clear() plus settle, both stores must be
		// empty regardless of how far the sweep got.
		await sleep(3_200);
		await post('/ClearTable/', { table: 'TtlTable' });

		// Let any in-flight sweep eviction txns settle: poll the raw stores until both are empty
		// (bounded), then take the final reading that the assertions below judge.
		let base = await dump('TtlTable');
		let idxA = await indexDump('TtlTable', 'tagA');
		const settleDeadline = Date.now() + 15_000;
		while ((base.length > 0 || idxA.length > 0) && Date.now() < settleDeadline) {
			await sleep(250);
			base = await dump('TtlTable');
			idxA = await indexDump('TtlTable', 'tagA');
		}
		report('Q4 post-clear-vs-sweep-race', { baseCount: base.length, idxACount: idxA.length });

		strictEqual(
			base.length,
			0,
			`TtlTable primary store should be empty after clear()+sweep settle, got ${base.length}`
		);
		strictEqual(
			idxA.length,
			0,
			`TtlTable tagA index should be fully empty after clear()+sweep settle, got ${idxA.length}: ${JSON.stringify(idxA)}`
		);
	});
});
