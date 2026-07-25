/**
 * QA-720 (source:gh:595, extension of QA-717/F-208) — a complete per-path blob-reclamation
 * ledger for the bulk-removal surface.
 *
 * QA-717 already proved Table.clear() orphans every blob it wipes (Table.ts:4783, a bare
 * `primaryStore.clear()` with no `deleteBlobsInObject()` call) while per-record delete and TTL
 * eviction reclaim correctly (RecordEncoder.ts removeEntry(), ~line 905). QA-697 separately
 * characterized drop_table (GH#595) and drop_database against the on-demand sweeper. Those are
 * each ONE path each — this suite builds the rest of the map in one place, one instance,
 * threads.count:4, with a uniform before/after/after-settle ledger:
 *   (control) per-record delete           -- oracle-arming known-good path (from QA-717)
 *   (a) drop_table                        -- Table.ts:1182 dropTable()
 *   (b) drop_database                     -- resources/databases.ts:893 dropDatabase()
 *   (c) delete-by-search (SQL bulk DELETE, one request, many rows) -- sqlTranslator/deleteTranslator.ts
 *   (d) overwrite blob-bearing record with a NEW blob -- does the OLD file get reclaimed?
 *   (e) overwrite blob-bearing record with a NON-blob value (blob field removed)
 *
 * Code read (harper SHA b8c843a24):
 *   - resources/RecordEncoder.ts:773-786 (recordUpdater, the encode path under EVERY table.put())
 *     already deletes the prior row's blob files on overwrite -- except any fileId the NEW record
 *     still references (retainedFileIds, harper#641) -- so (d) and (e) are BOTH expected, per
 *     static read, to reclaim the old file via the ordinary put() path. Nobody had measured this
 *     empirically before.
 *   - resources/databases.ts:893 dropDatabase() ... :940 `await deleteRootBlobPathsForDB(rootStore)`
 *     unconditionally rimraf's the ENTIRE {dataRootDir}/blobs/{db} directory as its last (awaited)
 *     step, regardless of what's referenced -- so a full DB drop is expected to leave 0 files,
 *     synchronously by the time the op response returns.
 *   - resources/Table.ts:1182 dropTable() walks its OWN primaryStore (getRange({versions:true}))
 *     and calls deleteBlobsInObject() for every HAS_BLOBS entry BEFORE dropping the column family
 *     -- but deleteBlobsInObject -> deleteBlob() (blob.ts:854) only *schedules* the unlink via
 *     setTimeout(deletionDelay=500ms); GH#595 reports the blobs sit orphaned until the on-demand
 *     sweeper (cleanupOrphans, blob.ts:1871) runs. There is no background caller of
 *     cleanupOrphans/cleanup_orphan_blobs (dataLayer/schema.ts) -- it is a purely manual op.
 *   - dataLayer/harperBridge/ResourceBridge.ts deleteRecords() (the bulk "delete" op with many
 *     hash_values, and the target of SQL DELETE via deleteTranslator.ts convertDelete()) is a
 *     plain `for (const id of ids) await Table.delete(id, ...)` loop -- i.e. it fans out to the
 *     SAME per-record path as the control, just inside one HTTP request/transaction. Static read
 *     says (c) should reclaim exactly like the control; this suite measures it rather than
 *     assuming it.
 *
 * Per instructions: each arm's assertion encodes the CORRECT invariant (the removal path itself,
 * not a manual sweep, must reclaim its blobs; no dangling refs) and is allowed to fail if Harper
 * doesn't meet it -- that failure IS the finding. Where an arm's natural settle leaves files
 * behind, a diagnostic cleanup_orphan_blobs call (BEFORE the strict assert) records whether the
 * leak is sweeper-reclaimable or permanent, without using the sweep to launder the assertion.
 *
 * Reproduction:
 *   npm run test:integration -- "integrationTests/database/blob-reclaim-removal-paths.test.ts"
 *
 * Coverage anchored: axis B(blob) x removal-path (drop_table / drop_database / bulk-delete-by-search
 * / overwrite-with-new-blob / overwrite-with-non-blob) x threads.count:4. Promoted from QA-720
 * (P-495); qualifies GH#595 (blob reclamation is per-path, not sweeper-dependent) and bounds
 * F-208's Table.clear() leak as a one-path outlier rather than a systemic pattern.
 */
import { suite, test, before, after } from 'node:test';
import { ok, strictEqual, notStrictEqual } from 'node:assert';
import { resolve, join } from 'node:path';
import { readdir, stat } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import request from 'supertest';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
// @ts-expect-error utils/client.mjs has no type declarations; runtime resolves fine
import { createApiClient } from '../apiTests/utils/client.mjs';

const FIXTURE_PATH = resolve(import.meta.dirname, 'blob-reclaim-removal-paths');
const BLOB_SIZE = 32 * 1024; // 32KB -- well above FILE_STORAGE_THRESHOLD (8192 bytes), always file-backed
const skipSuite = process.platform === 'win32';

/** Recursively count files + bytes under a blob storage tree ({dataRootDir}/blobs/{db}/{p}/{p}/{fileId}). */
async function diskUsage(dir: string): Promise<{ files: number; bytes: number }> {
	let files = 0;
	let bytes = 0;
	async function walk(d: string) {
		let entries;
		try {
			entries = await readdir(d, { withFileTypes: true });
		} catch {
			return; // dir not created yet, or already removed
		}
		for (const e of entries) {
			const p = join(d, e.name);
			if (e.isDirectory()) await walk(p);
			else {
				try {
					bytes += (await stat(p)).size;
					files++;
				} catch {
					/* raced with unlink */
				}
			}
		}
	}
	await walk(dir);
	return { files, bytes };
}

/** Bounded convergence poll: sample `getUsage` until two consecutive reads agree, or time out. */
async function waitForSettle(
	getUsage: () => Promise<{ files: number; bytes: number }>,
	{ timeoutMs = 20_000, intervalMs = 500 }: { timeoutMs?: number; intervalMs?: number } = {}
): Promise<{ files: number; bytes: number; timedOut: boolean; waitedMs: number }> {
	const start = Date.now();
	const deadline = start + timeoutMs;
	let prev = await getUsage();
	while (Date.now() < deadline) {
		await sleep(intervalMs);
		const cur = await getUsage();
		if (cur.files === prev.files && cur.bytes === prev.bytes) {
			return { ...cur, timedOut: false, waitedMs: Date.now() - start };
		}
		prev = cur;
	}
	return { ...prev, timedOut: true, waitedMs: Date.now() - start }; // gave up converging -- caller asserts against this last reading
}

suite('QA-720 blob-reclamation ledger: drop_table / drop_database / bulk-delete / overwrite arms', { skip: skipSuite }, (ctx: ContextWithHarper) => {
	let client: ReturnType<typeof createApiClient>;
	let httpURL: string;
	let dataBlobRoot: string;
	let dropDbBlobRoot: string;
	const findings: string[] = [];
	const ledger: string[] = [];

	async function dataUsage() {
		return diskUsage(dataBlobRoot);
	}
	async function dropDbUsage() {
		return diskUsage(dropDbBlobRoot);
	}

	async function waitReady() {
		const deadline = Date.now() + 30_000;
		while (Date.now() < deadline) {
			try {
				const probe = await client.reqRest('/Doc/').timeout(3_000);
				if (probe.status !== 404) return;
			} catch {
				/* not ready */
			}
			await sleep(250);
		}
	}

	before(async () => {
		// threads.count:4 per QA-720 brief -- keeps this ledger directly comparable to QA-717/QA-697,
		// which found multi-worker cleanup races specifically matter for blob reclamation.
		await setupHarperWithFixture(ctx, FIXTURE_PATH, {
			config: { threads: { count: 4 } },
			env: {},
		});
		client = createApiClient(ctx.harper);
		httpURL = ctx.harper.httpURL;
		dataBlobRoot = join(ctx.harper.dataRootDir, 'blobs', 'data');
		dropDbBlobRoot = join(ctx.harper.dataRootDir, 'blobs', 'qa720db');
		await waitReady();
	});

	after(async () => {
		await teardownHarper(ctx);
		console.log('\n[QA-720] LEDGER (per-arm files before -> after-write -> after-settle)');
		for (const l of ledger) console.log('  ' + l);
		console.log('\n[QA-720] FINDINGS');
		for (const f of findings) console.log('  ' + f);
	});

	function op(body: Record<string, unknown>) {
		return request(httpURL).post('/Ops/').set(client.headers).send(body);
	}
	function opReq(body: Record<string, unknown>) {
		return client.req().timeout(60_000).send(body);
	}

	async function storeN(db: string, table: string, prefix: string, n: number, size = BLOB_SIZE): Promise<string[]> {
		const keys = Array.from({ length: n }, (_, i) => `${prefix}-${i}`);
		for (const key of keys) {
			const r = await op({ action: 'store', db, table, key, size, seed: key }).expect(200);
			strictEqual(r.body.match, true, `store ${db}.${table}/${key} mismatch: ${JSON.stringify(r.body)}`);
		}
		return keys;
	}

	// ── CONTROL: per-record delete (removeEntry -> deleteBlobsInObject), oracle-arming ──────────
	test('CONTROL: per-record delete reclaims blob files (oracle-arming, known-good path)', async () => {
		const before = await dataUsage();
		const N = 10;
		const keys = await storeN('data', 'Doc', 'ctl', N);
		const afterStore = await dataUsage();
		strictEqual(afterStore.files - before.files, N, 'setup: N files should land before delete');

		for (const key of keys) await op({ action: 'delete', db: 'data', table: 'Doc', key }).expect(200);
		const settled = await waitForSettle(dataUsage);
		ledger.push(`CONTROL delete: before=${before.files}f after-write=${afterStore.files}f after-settle=${settled.files}f (waited ${settled.waitedMs}ms) rows: wrote ${N}, target-rows-after=0`);

		for (const key of keys) {
			const v = await op({ action: 'verify', db: 'data', table: 'Doc', key }).expect(200);
			strictEqual(v.body.present, false, `${key} still present after delete`);
		}
		if (settled.files === before.files) {
			findings.push('CONTROL VERDICT: per-record delete reclaims blob files (EXPECTED, control confirmed) -- confidence HIGH');
		} else {
			findings.push(`CONTROL VERDICT: SURPRISE -- control path did not fully reclaim (left ${settled.files - before.files} extra) -- oracle may be miscalibrated, treat downstream arms with caution`);
		}
		strictEqual(settled.files, before.files, 'per-record delete (control) must unlink all backing blob files');
	});

	// ── Arm C: delete-by-search (SQL bulk DELETE, one request, many rows) ───────────────────────
	test('Arm C: SQL bulk DELETE (delete-by-search, one request, many rows) reclaims blob files', async () => {
		const before = await dataUsage();
		const M = 25;
		const keys = await storeN('data', 'Doc', 'bulk', M);
		const afterStore = await dataUsage();
		strictEqual(afterStore.files - before.files, M, 'setup: M files should land before bulk delete');

		const delRes = await opReq({ operation: 'sql', sql: "DELETE FROM data.Doc WHERE key LIKE 'bulk-%'" });
		strictEqual(delRes.status, 200, `bulk SQL DELETE failed: ${JSON.stringify(delRes.body)}`);

		const list = (await op({ action: 'list', db: 'data', table: 'Doc' }).expect(200)).body as Array<{ key: string }>;
		const remainingBulk = list.filter((r) => r.key.startsWith('bulk-'));
		strictEqual(remainingBulk.length, 0, `bulk SQL DELETE should remove all ${M} rows; ${remainingBulk.length} remain`);

		const settled = await waitForSettle(dataUsage);
		ledger.push(`Arm C bulk-delete-by-search: before=${before.files}f after-write=${afterStore.files}f after-settle=${settled.files}f (waited ${settled.waitedMs}ms) rows: wrote ${M}, target-rows-after=0, actual-rows-after=${remainingBulk.length}`);

		for (const key of keys) {
			const v = await op({ action: 'verify', db: 'data', table: 'Doc', key }).expect(200);
			strictEqual(v.body.present, false, `${key} still present after bulk delete`);
		}
		if (settled.files > before.files) {
			findings.push(`Arm C VERDICT: DEFECT -- SQL bulk DELETE (delete-by-search) left ${settled.files - before.files} blob file(s) orphaned on disk`);
		} else {
			findings.push('Arm C VERDICT: bulk delete-by-search reclaims blob files, matching the per-record control (EXPECTED, fans out to Table.delete()) -- confidence HIGH');
		}
		strictEqual(settled.files, before.files, 'bulk delete-by-search must reclaim all backing blob files, same as per-record delete');
	});

	// ── Arm D: overwrite a blob-bearing record with a NEW blob -- is the OLD file reclaimed? ───
	test('Arm D: overwriting a blob-bearing record with a NEW blob reclaims the OLD file', async () => {
		const key = 'ovw-new';
		const before = await dataUsage();
		const r1 = await op({ action: 'store', db: 'data', table: 'Doc', key, size: BLOB_SIZE, seed: 'blob-A' }).expect(200);
		strictEqual(r1.body.match, true, 'initial store mismatch');
		const afterFirst = await dataUsage();
		strictEqual(afterFirst.files - before.files, 1, 'setup: exactly 1 file should land for the initial blob');

		const r2 = await op({ action: 'store', db: 'data', table: 'Doc', key, size: BLOB_SIZE, seed: 'blob-B' }).expect(200);
		strictEqual(r2.body.match, true, 'overwrite store mismatch');
		const afterOverwrite = await dataUsage();

		const settled = await waitForSettle(dataUsage);
		ledger.push(`Arm D overwrite-with-new-blob: before=${before.files}f after-1st-write=${afterFirst.files}f after-2nd-write(pre-settle)=${afterOverwrite.files}f after-settle=${settled.files}f (waited ${settled.waitedMs}ms); expect net +1 (old reclaimed, only new remains)`);

		// Correctness: the record must now read blob-B content, never stale blob-A bytes.
		const v = await op({ action: 'verify', db: 'data', table: 'Doc', key }).expect(200);
		strictEqual(v.body.present, true, 'record should still be present after overwrite');
		strictEqual(v.body.dangling, false, `overwritten record must not reference a missing file: ${JSON.stringify(v.body)}`);
		strictEqual(v.body.match, true, `overwritten record content mismatch (stale/corrupt blob?): ${JSON.stringify(v.body)}`);
		strictEqual(v.body.storedSha, r2.body.expectedSha, 'record must reflect the SECOND (overwriting) blob, not the first');

		if (settled.files > before.files + 1) {
			findings.push(`Arm D VERDICT: DEFECT -- overwriting a blob-bearing record with a NEW blob leaked ${settled.files - (before.files + 1)} old blob file(s)`);
		} else {
			findings.push('Arm D VERDICT: overwrite-with-new-blob reclaims the OLD file (EXPECTED per RecordEncoder.ts:773-786 retainedFileIds path) -- confidence HIGH, first empirical measurement of this arm');
		}
		strictEqual(settled.files, before.files + 1, 'overwriting with a new blob must reclaim the OLD file (net +1 file: only the new blob remains)');
	});

	// ── Arm E: overwrite a blob-bearing record with a NON-blob value (blob field removed) ──────
	test('Arm E: overwriting a blob-bearing record with a NON-blob value reclaims the blob', async () => {
		const key = 'ovw-remove';
		const before = await dataUsage();
		const r1 = await op({ action: 'store', db: 'data', table: 'Doc', key, size: BLOB_SIZE, seed: 'blob-C' }).expect(200);
		strictEqual(r1.body.match, true, 'initial store mismatch');
		const afterStore = await dataUsage();
		strictEqual(afterStore.files - before.files, 1, 'setup: exactly 1 file should land for the initial blob');

		const r2 = await op({ action: 'overwriteNonBlob', db: 'data', table: 'Doc', key, tag: 'cleared' }).expect(200);
		strictEqual(r2.body.ok, true, `overwriteNonBlob failed: ${JSON.stringify(r2.body)}`);

		const settled = await waitForSettle(dataUsage);
		ledger.push(`Arm E overwrite-with-non-blob: before=${before.files}f after-write=${afterStore.files}f after-settle=${settled.files}f (waited ${settled.waitedMs}ms); expect net 0 (blob reclaimed, row survives without one)`);

		const v = await op({ action: 'verify', db: 'data', table: 'Doc', key }).expect(200);
		strictEqual(v.body.present, true, 'row must survive the overwrite (only the blob field was removed)');
		strictEqual(v.body.hasPayload, false, `blob field should be gone from the record: ${JSON.stringify(v.body)}`);

		if (settled.files > before.files) {
			findings.push(`Arm E VERDICT: DEFECT -- overwriting a blob-bearing record with a non-blob value leaked ${settled.files - before.files} blob file(s)`);
		} else {
			findings.push('Arm E VERDICT: overwrite-with-non-blob-value reclaims the orphaned blob (EXPECTED, unconditional deleteBlobsInObject when the new record has no retained fileIds) -- confidence HIGH, first empirical measurement of this arm');
		}
		strictEqual(settled.files, before.files, 'overwriting with a non-blob value must reclaim the now-unreferenced blob file');
	});

	// ── Arm A: drop_table ────────────────────────────────────────────────────────────────────────
	test('Arm A: drop_table reclaims its own table\'s blob files (no cleanup_orphan_blobs call needed)', async () => {
		const before = await dataUsage();
		const N = 12;
		const keys = await storeN('data', 'DropMeTable', 'dmt', N);
		const afterStore = await dataUsage();
		strictEqual(afterStore.files - before.files, N, 'setup: N files should land before drop_table');

		const dropRes = await opReq({ operation: 'drop_table', schema: 'data', table: 'DropMeTable' });
		strictEqual(dropRes.status, 200, `drop_table failed: ${JSON.stringify(dropRes.body)}`);
		const afterDropImmediate = await dataUsage();

		let settled = await waitForSettle(dataUsage, { timeoutMs: 30_000 });
		let sweepNote = 'not needed';
		if (settled.files > before.files) {
			// Diagnostic ONLY -- run before the strict assert (which targets natural reclaim, not the
			// sweep) so we still learn whether the leak is sweeper-reclaimable or permanent.
			const cleanupRes = await opReq({ operation: 'cleanup_orphan_blobs', database: 'data' });
			await sleep(3_000);
			const postSweep = await dataUsage();
			sweepNote = `cleanup_orphan_blobs status=${cleanupRes.status} body=${JSON.stringify(cleanupRes.body)} -> files after sweep=${postSweep.files} (${postSweep.files <= before.files ? 'sweeper reclaims it' : 'STILL leaked even after manual sweep'})`;
		}
		ledger.push(`Arm A drop_table: before=${before.files}f after-write=${afterStore.files}f immediately-after-drop=${afterDropImmediate.files}f after-settle=${settled.files}f (waited ${settled.waitedMs}ms, timedOut=${settled.timedOut}); sweep diagnostic: ${sweepNote}; rows: wrote ${N}, table dropped (0 rows, unreachable)`);

		if (settled.files > before.files) {
			findings.push(
				`Arm A VERDICT: DEFECT -- drop_table left ${settled.files - before.files} of ${N} blob file(s) orphaned on disk after natural settle (${sweepNote.includes('sweeper reclaims it') ? 'reclaimable via manual cleanup_orphan_blobs sweep only -- a real leak absent operator intervention, matching GH#595' : 'NOT reclaimed even by manual sweep -- permanent leak'})`
			);
		} else {
			findings.push('Arm A VERDICT: drop_table reclaims its own blob files without needing the sweeper (EXPECTED per Table.ts:1182 proactive walk) -- confidence MEDIUM (contradicts GH#595 field report; see ledger for exact timing)');
		}
		strictEqual(settled.files, before.files, 'drop_table must reclaim all of its table\'s backing blob files on its own, without a manual cleanup_orphan_blobs call');
	});

	// ── Arm B: drop_database ────────────────────────────────────────────────────────────────────
	test('Arm B: drop_database reclaims ALL blob files for that database (whole-directory rimraf)', async () => {
		const before = await dropDbUsage();
		const N = 10;
		await storeN('qa720db', 'DropDbDoc', 'ddb', N);
		const afterStore = await dropDbUsage();
		strictEqual(afterStore.files - before.files, N, 'setup: N files should land before drop_database');

		const dropRes = await opReq({ operation: 'drop_database', database: 'qa720db' });
		strictEqual(dropRes.status, 200, `drop_database failed: ${JSON.stringify(dropRes.body)}`);

		// dropDatabase() awaits deleteRootBlobPathsForDB() as its last step before returning, so the
		// whole-directory rimraf should already be complete by the time the op response lands -- poll
		// briefly anyway rather than assuming synchronous completion.
		const settled = await waitForSettle(dropDbUsage, { timeoutMs: 10_000 });
		ledger.push(`Arm B drop_database: before=${before.files}f after-write=${afterStore.files}f after-settle=${settled.files}f (waited ${settled.waitedMs}ms); rows: wrote ${N}, database dropped (0 rows, unreachable)`);

		if (settled.files === 0) {
			findings.push('Arm B VERDICT: drop_database reclaims all blob files (EXPECTED, whole-dir rimraf in databases.ts:940) -- confidence HIGH');
		} else {
			findings.push(`Arm B VERDICT: DEFECT -- drop_database left ${settled.files} blob file(s) behind (whole-directory rimraf should leave 0)`);
		}
		strictEqual(settled.files, 0, 'drop_database must remove every blob file for that database');
	});

	// ── Liveness control ──────────────────────────────────────────────────────────
	test('instance stayed alive throughout all arms', async () => {
		const r = await client.req().send({ operation: 'system_information', attributes: ['threads'] }).expect(200);
		ok(Array.isArray(r.body.threads), 'system_information should report threads (instance alive)');
		notStrictEqual(r.body.threads.length, 0, 'expected threads.count:4 to be reflected in system_information');
	});
});
