/**
 * QA-726 — [single-node] audit/time-travel reads onto a superseded record whose Blob file has
 * already been reclaimed (axis B(blob) x audit/time-travel x F(reclaim-lifecycle)).
 *
 * App concept: a document-versioning service stores rendered PDFs as Blob-valued attributes on
 * an audited table. Editors overwrite a document repeatedly and later want to read "the version
 * as of last Tuesday" via the audit log / getRecordAtTime. Prior QA (qa406, qa477 @ 228eacc0f)
 * established that overwriting a blob-valued record reclaims the old blob file promptly, and
 * that a GC'd-blob history read comes back as a clean 404/ENOENT (not wrong bytes, not a hang).
 * This run re-verifies that at HEAD (b8c843a24) and extends coverage the prior run didn't have:
 *   - a many-version LEAK check (does audit retention pin old blob files -> unbounded growth?)
 *   - the raw ops-API `read_audit_log` HTTP surface (not just the in-process
 *     getHistoryOfRecord()/Blob.bytes() path qa477 used) to see what a real client gets back
 *   - delete-then-time-travel-read
 *   - an explicit threads:{count:4} arm
 *
 * Each arm gets its OWN database (qa726a/b/c/d) because blob files partition per-DATABASE, not
 * per-table (per-DB partitioning would otherwise let one arm's writes contaminate another arm's
 * file-count diffs within the same Harper instance).
 *
 * Harper SHA: b8c843a24
 * Reproduction:
 *   cd /home/kzyp/dev/harper
 *   timeout 900 npm run test:integration -- "integrationTests/qa-scratch/qa726-audit-blob.test.ts" \
 *     > /home/kzyp/dev/tmp/qa726.log 2>&1; tail -120 /home/kzyp/dev/tmp/qa726.log
 * Results: /home/kzyp/dev/tmp/qa726-results.txt
 */
import { suite, test, before, after } from 'node:test';
import { ok, strictEqual, notStrictEqual } from 'node:assert';
import { resolve, join } from 'node:path';
import { readdir } from 'node:fs/promises';
import { writeFileSync, mkdirSync } from 'node:fs';
import { createHash, createHmac } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import request from 'supertest';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
// @ts-expect-error no type declarations
import { createApiClient } from '../apiTests/utils/client.mjs';

const FIXTURE_PATH = resolve(import.meta.dirname, 'audit-blob-reclaim');
const RESULTS_FILE = '/home/kzyp/dev/tmp/qa726-results.txt';
const HARPER_SHA = 'b8c843a24';

const skipSuite = process.platform === 'win32' || process.env.HARPER_RUNTIME === 'bun';

// ── Results log ──────────────────────────────────────────────────────────────
const findings: string[] = [];
function log(line: string) {
	process.stdout.write(line + '\n');
	findings.push(line);
}
function flushResults() {
	mkdirSync('/home/kzyp/dev/tmp', { recursive: true });
	writeFileSync(RESULTS_FILE, findings.join('\n') + '\n');
}

// ── Shared helpers (mirrors resources.js's byte pattern so the pre-flight oracle check below
//    is testing the SAME comparator the app-level assertions rely on) ─────────────────────────
function patternBuffer(seed: string, size: number): Buffer {
	const out = Buffer.allocUnsafe(size);
	let off = 0;
	let counter = 0;
	while (off < size) {
		const block = createHmac('sha256', String(seed)).update(String(counter++)).digest();
		const n = Math.min(block.length, size - off);
		block.copy(out, off, 0, n);
		off += n;
	}
	return out;
}
function sha256hex(buf: Buffer): string {
	return createHash('sha256').update(buf).digest('hex');
}

// ── Disk walker: full set of file paths under a dir ───────────────────────────
async function fileSet(dir: string): Promise<Set<string>> {
	const out = new Set<string>();
	async function walk(d: string) {
		let entries;
		try {
			entries = await readdir(d, { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entries) {
			const p = join(d, e.name);
			if (e.isDirectory()) await walk(p);
			else out.add(p);
		}
	}
	await walk(dir);
	return out;
}

// ── Oracle arming (pre-flight, no Harper needed) ───────────────────────────────
// Prove the sha256 comparator this whole test relies on (1) DOES flag known-different content
// as different, and (2) does NOT flag identical content as different (a comparator that always
// reports "mismatch" would make every DEFECT classification below vacuous).
test('QA-726 oracle arming: comparator distinguishes known-different content, agrees on identical content', () => {
	const bufA = patternBuffer('ORACLE-ARM-A', 4096);
	const bufB = patternBuffer('ORACLE-ARM-B', 4096);
	const bufAAgain = patternBuffer('ORACLE-ARM-A', 4096);
	const shaA = sha256hex(bufA);
	const shaB = sha256hex(bufB);
	const shaAAgain = sha256hex(bufAAgain);
	notStrictEqual(shaA, shaB, 'oracle must flag known-different content as different');
	strictEqual(shaA, shaAAgain, 'oracle must NOT flag identical content as different (no false-positive mismatches)');
	strictEqual(bufA.equals(bufB), false, 'raw byte comparison sanity: A and B must actually differ');
	log(`\n=== QA-726 oracle arming ===`);
	log(`ORACLE ARMED: shaA=${shaA.slice(0, 12)} != shaB=${shaB.slice(0, 12)} (different content correctly flagged)`);
	log(
		`ORACLE ARMED: shaA=${shaA.slice(0, 12)} == shaAAgain=${shaAAgain.slice(0, 12)} (identical content correctly matched)`
	);
	log(`Oracle is NON-BLIND: proceeding with byte-distinguishable version content for all arms below.`);
});

suite(
	`QA-726 audit/time-travel onto GC'd blob [harper ${HARPER_SHA}, threads:1]`,
	{ skip: skipSuite },
	(ctx: ContextWithHarper) => {
		let client: ReturnType<typeof createApiClient>;
		let rootPath: string;

		function op(body: Record<string, unknown>) {
			return request(client.restURL ?? (ctx.harper as any).httpURL)
				.post('/DocOp/')
				.set(client.headers)
				.send(body)
				.expect((r: any) => {
					if (r.status >= 400)
						log(
							`[DEBUG op ${JSON.stringify(body).slice(0, 120)}] status=${r.status} body=${JSON.stringify(r.body)} text=${r.text?.slice(0, 500)}`
						);
				});
		}

		function blobDir(db: string) {
			return join(rootPath, 'blobs', db);
		}

		async function waitReady(maxMs = 90_000) {
			const deadline = Date.now() + maxMs;
			while (Date.now() < deadline) {
				try {
					const probe = await op({ action: 'currentGet', table: 'qa726a', id: 'ready-probe' }).timeout(3_000);
					if (probe.status !== 404) return;
				} catch {
					/* not ready */
				}
				await sleep(400);
			}
			throw new Error('Harper did not become ready in time');
		}

		before(async () => {
			log(`\n=== QA-726 suite [threads:1] harper ${HARPER_SHA} ===`);
			await setupHarperWithFixture(ctx, FIXTURE_PATH, {
				config: { threads: { count: 1 } },
				env: {},
			});
			client = createApiClient(ctx.harper);
			await waitReady();

			const cfgResp = await client.req().send({ operation: 'get_configuration' }).expect(200);
			rootPath = cfgResp.body.rootPath;
			ok(rootPath, 'get_configuration must return rootPath');
			log(`rootPath: ${rootPath}`);
		});

		after(async () => {
			flushResults();
			await teardownHarper(ctx);
		});

		test('overwrite arm (qa726a): v1(A)->v2(B)->v3(C); blob reclaim + in-process history + raw read_audit_log', async () => {
			const db = 'qa726a';
			const id = 'doc-overwrite-1';
			const dir = blobDir(db);

			const files0 = await fileSet(dir);
			log(`\n[overwrite] files before any write: ${files0.size}`);

			const r1 = await op({ action: 'write', table: db, id, seed: 'BLOB-A-MARKER', size: 20 * 1024 }).expect(200);
			const shaA = r1.body.sha;
			await sleep(300);
			const filesV1 = await fileSet(dir);
			log(`[overwrite] v1 written: sha=${shaA.slice(0, 12)}; files=${filesV1.size}`);
			ok(filesV1.size > files0.size, 'v1 write must create at least one blob file');

			const r2 = await op({ action: 'write', table: db, id, seed: 'BLOB-B-MARKER', size: 20 * 1024 }).expect(200);
			const shaB = r2.body.sha;
			notStrictEqual(shaA, shaB, 'sanity: blob A and blob B must be byte-distinct');
			await sleep(2000); // past default blob deletionDelay, with margin for GC
			const filesV2 = await fileSet(dir);
			const removedAfterV2 = [...filesV1].filter((f) => !filesV2.has(f));
			log(
				`[overwrite] v2 written: sha=${shaB.slice(0, 12)}; files=${filesV2.size}; removed=${JSON.stringify(removedAfterV2)}`
			);
			ok(removedAfterV2.length > 0, 'QA-406 premise: blob A file must be reclaimed on overwrite');

			const r3 = await op({ action: 'write', table: db, id, seed: 'BLOB-C-MARKER', size: 20 * 1024 }).expect(200);
			const shaC = r3.body.sha;
			notStrictEqual(shaB, shaC, 'sanity: blob B and blob C must be byte-distinct');
			notStrictEqual(shaA, shaC, 'sanity: blob A and blob C must be byte-distinct');
			await sleep(2000);
			const filesV3 = await fileSet(dir);
			const removedAfterV3 = [...filesV2].filter((f) => !filesV3.has(f));
			log(
				`[overwrite] v3 written: sha=${shaC.slice(0, 12)}; files=${filesV3.size}; removed=${JSON.stringify(removedAfterV3)}`
			);
			ok(removedAfterV3.length > 0, 'blob B file must be reclaimed on second overwrite');
			// With 3 live versions ever written and 2 reclaims, exactly 1 blob file should remain live.
			strictEqual(filesV3.size, 1, 'exactly the current (v3/C) blob file should remain on disk');

			const cur = await op({ action: 'currentGet', table: db, id }).expect(200);
			strictEqual(cur.body.sha, shaC, 'current record must read back as blob C');

			// In-process time-travel via getHistoryOfRecord (the surface behind read_audit_log/getRecordAtTime).
			const hist = await op({ action: 'history', table: db, id, timeoutMs: 5000 }).expect(200);
			log(`[overwrite] history entries: ${hist.body.count}`);
			log(`[overwrite] history raw: ${JSON.stringify(hist.body.results, null, 2)}`);
			ok(hist.body.count >= 3, 'expect at least 3 audit entries (v1, v2, v3 puts)');

			// isThisVersionCurrent: the entry being classified IS the live/current version (its own
			// sha correctly equalling currentSha is expected-ok, not a defect); only entries for a
			// SUPERSEDED version reading back as currentSha are the wrong-bytes-as-history defect.
			function classify(entry: any, currentSha: string, staleShas: string[], isThisVersionCurrent: boolean): string {
				if (isThisVersionCurrent && entry.outcome.ok && entry.outcome.sha === currentSha)
					return 'expected-ok-current-version-reads-as-current';
				if (entry.outcome.ok && entry.outcome.sha === currentSha) return 'wrong-bytes-served-CURRENT-as-history';
				if (entry.outcome.ok && staleShas.includes(entry.outcome.sha))
					return 'stale-blob-still-readable(unexpected-if-GCd)';
				if (entry.outcome.ok) return `unknown-bytes(sha=${entry.outcome.sha})`;
				if (entry.outcome.isTimeout) return `HANG(${entry.outcome.elapsedMs}ms)`;
				if (entry.outcome.statusCode === 404 || entry.outcome.code === 'ENOENT') return `clean-404-ENOENT`;
				if (entry.outcome.statusCode === 500) return `ENOENT-as-500(${entry.outcome.error})`;
				return `unclassified(${JSON.stringify(entry.outcome)})`;
			}

			const v1Entry = hist.body.results[0];
			const v2Entry = hist.body.results[1];
			const v3Entry = hist.body.results[hist.body.results.length - 1];
			const v1Class = classify(v1Entry, shaC, [shaA], false);
			const v2Class = classify(v2Entry, shaC, [shaB], false);
			const v3Class = classify(v3Entry, shaC, [], true);
			log(`\n>>> v1(GC'd blob A) history classification: ${v1Class}`);
			log(`>>> v2(GC'd blob B) history classification: ${v2Class}`);
			log(`>>> v3(current, blob C) history classification: ${v3Class}`);
			ok(
				v3Entry.outcome.ok && v3Entry.outcome.sha === shaC,
				'current-version history entry must read as current blob C'
			);
			if (v1Class === 'wrong-bytes-served-CURRENT-as-history' || v2Class === 'wrong-bytes-served-CURRENT-as-history') {
				log(`!!! DEFECT: wrong-bytes-as-history observed on the overwrite arm !!!`);
			}

			// Raw ops-API read_audit_log HTTP surface: what does a real client actually receive for
			// a Blob-valued attribute in a JSON audit-log response?
			const auditResp = await client
				.req()
				.send({
					operation: 'read_audit_log',
					schema: db,
					table: 'Document',
					search_type: 'hash_value',
					search_values: [id],
				})
				.expect(200);
			const auditTxns = auditResp.body[id] || auditResp.body[String(id)] || [];
			log(
				`\n[overwrite] read_audit_log(hash_value=${id}) txn count: ${Array.isArray(auditTxns) ? auditTxns.length : 'n/a'}`
			);
			log(`[overwrite] read_audit_log raw body: ${JSON.stringify(auditResp.body, null, 2).slice(0, 4000)}`);
			if (Array.isArray(auditTxns) && auditTxns.length) {
				const contentShapes = auditTxns
					.map((t: any) =>
						t.records?.map((r: any) => (typeof r.content === 'object' ? r.content : `[non-object:${typeof r.content}]`))
					)
					.flat();
				log(`[overwrite] read_audit_log Blob attribute shapes seen: ${JSON.stringify(contentShapes)}`);
				log(
					`>>> OPS-API SURFACE FINDING: read_audit_log's plain JSON response ${
						contentShapes.some((c: any) => c && c.description)
							? 'returns a PLACEHOLDER description object for the Blob attribute (never attempts a file read, so it can neither serve stale bytes nor surface an ENOENT for a reclaimed file via this surface)'
							: 'did not show the expected placeholder shape — see raw body above'
					}`
				);
			}
		});

		test('leak-check arm (qa726b): N sequential overwrites — does audit retention pin old blob files?', async () => {
			const db = 'qa726b';
			const id = 'doc-leak-1';
			const dir = blobDir(db);
			const N = 8;
			const counts: number[] = [];

			for (let i = 1; i <= N; i++) {
				await op({ action: 'write', table: db, id, seed: `LEAK-V${i}`, size: 20 * 1024 }).expect(200);
				await sleep(600); // allow inline GC of the just-superseded blob to settle
				const files = await fileSet(dir);
				counts.push(files.size);
				log(`[leak-check] after write v${i}: live blob files=${files.size}`);
			}

			log(`[leak-check] file-count series across ${N} versions: ${JSON.stringify(counts)}`);
			const maxCount = Math.max(...counts);
			const finalCount = counts[counts.length - 1];
			// If audit retention pinned every historical blob, count would grow ~linearly to N.
			// Expect it to stay bounded at (or very near) 1 live file per record.
			ok(
				finalCount <= 2,
				`blob file count must stay bounded, not grow with version count N=${N} (final=${finalCount})`
			);
			if (maxCount >= N) {
				log(
					`!!! DEFECT-CANDIDATE: blob file count (${maxCount}) tracks version count (${N}) — possible audit-pin leak !!!`
				);
			} else {
				log(
					`>>> LEAK-CHECK RESULT: bounded (max=${maxCount}, final=${finalCount}) across ${N} versions — audit retention does NOT pin reclaimed blob files.`
				);
			}
		});

		test('delete-then-reinsert arm (qa726c): pre-delete blob GC + time-travel read of pre-delete version', async () => {
			const db = 'qa726c';
			const id = 'doc-delreinsert-1';
			const dir = blobDir(db);

			const r1 = await op({ action: 'write', table: db, id, seed: 'BLOB-DEL-A-MARKER', size: 20 * 1024 }).expect(200);
			const shaA = r1.body.sha;
			log(`\n[del-reinsert] v1 written: sha=${shaA.slice(0, 12)}`);
			const filesAfterV1 = await fileSet(dir);

			await op({ action: 'delete', table: db, id }).expect(200);
			await sleep(2000);
			const filesAfterDelete = await fileSet(dir);
			const removedOnDelete = [...filesAfterV1].filter((f) => !filesAfterDelete.has(f));
			log(`[del-reinsert] files removed on delete: ${JSON.stringify(removedOnDelete)}`);
			ok(removedOnDelete.length > 0, 'delete must reclaim the blob file');

			const r2 = await op({ action: 'write', table: db, id, seed: 'BLOB-DEL-C-MARKER', size: 20 * 1024 }).expect(200);
			const shaC = r2.body.sha;
			notStrictEqual(shaA, shaC, 'sanity: pre-delete and reinsert blobs must be byte-distinct');
			await sleep(300);

			// Delete-then-time-travel-read: history should show put(A) / delete / put(C).
			const hist = await op({ action: 'history', table: db, id, timeoutMs: 5000 }).expect(200);
			log(`[del-reinsert] history entries: ${hist.body.count}`);
			log(`[del-reinsert] history raw: ${JSON.stringify(hist.body.results, null, 2)}`);
			ok(hist.body.count >= 3, 'expect put(A), delete, put(C) in history');

			const preDeleteEntry = hist.body.results.find((r: any) => r.type === 'put' && r.title === 'BLOB-DEL-A-MARKER');
			const deleteEntry = hist.body.results.find((r: any) => r.type === 'delete');
			ok(deleteEntry, 'a delete-type audit entry must be present');
			strictEqual(deleteEntry.outcome.noBody, true, 'delete entry must carry no body (not a dangling blob ref)');

			let classification: string;
			if (!preDeleteEntry) {
				classification = 'no pre-delete entry found — inspect raw dump';
			} else if (preDeleteEntry.outcome.ok && preDeleteEntry.outcome.sha === shaC) {
				classification = 'DEFECT-wrong-bytes-as-history (pre-delete read returned reinserted blob C bytes)';
			} else if (preDeleteEntry.outcome.ok && preDeleteEntry.outcome.sha === shaA) {
				classification = 'ANOMALY-blobA-still-readable (contradicts confirmed GC of blob A file)';
			} else if (preDeleteEntry.outcome.isTimeout) {
				classification = `DEFECT-hang (${preDeleteEntry.outcome.elapsedMs}ms)`;
			} else if (preDeleteEntry.outcome.statusCode === 404 || preDeleteEntry.outcome.code === 'ENOENT') {
				classification = `EXPECTED-OK clean typed error (statusCode=${preDeleteEntry.outcome.statusCode})`;
			} else if (preDeleteEntry.outcome.statusCode === 500) {
				classification = `medium ENOENT-as-500 (${preDeleteEntry.outcome.error})`;
			} else {
				classification = `unclassified: ${JSON.stringify(preDeleteEntry.outcome)}`;
			}
			log(`\n>>> DELETE-REINSERT VARIANT CLASSIFICATION: ${classification}`);
		});
	}
);

suite(
	`QA-726 audit/time-travel onto GC'd blob [harper ${HARPER_SHA}, threads:4]`,
	{ skip: skipSuite },
	(ctx: ContextWithHarper) => {
		let client: ReturnType<typeof createApiClient>;

		function op(body: Record<string, unknown>) {
			return request(client.restURL ?? (ctx.harper as any).httpURL)
				.post('/DocOp/')
				.set(client.headers)
				.send(body)
				.expect((r: any) => {
					if (r.status >= 400)
						log(
							`[DEBUG op ${JSON.stringify(body).slice(0, 120)}] status=${r.status} body=${JSON.stringify(r.body)} text=${r.text?.slice(0, 500)}`
						);
				});
		}

		async function waitReady(maxMs = 90_000) {
			const deadline = Date.now() + maxMs;
			while (Date.now() < deadline) {
				try {
					const probe = await op({ action: 'currentGet', table: 'qa726d', id: 'ready-probe' }).timeout(3_000);
					if (probe.status !== 404) return;
				} catch {
					/* not ready */
				}
				await sleep(400);
			}
			throw new Error('Harper did not become ready in time');
		}

		before(async () => {
			log(`\n=== QA-726 suite [threads:4] harper ${HARPER_SHA} ===`);
			await setupHarperWithFixture(ctx, FIXTURE_PATH, {
				config: { threads: { count: 4 } },
				env: {},
			});
			client = createApiClient(ctx.harper);
			await waitReady();
		});

		after(async () => {
			flushResults();
			await teardownHarper(ctx);
		});

		test('threads:4 arm (qa726d): overwrite + reclaim + time-travel under concurrency', async () => {
			const db = 'qa726d';
			const id = 'doc-t4-1';

			const cfgResp = await client.req().send({ operation: 'get_configuration' }).expect(200);
			const rootPath: string = cfgResp.body.rootPath;
			const dir = join(rootPath, 'blobs', db);

			const r1 = await op({ action: 'write', table: db, id, seed: 'T4-BLOB-A', size: 20 * 1024 }).expect(200);
			const shaA = r1.body.sha;
			await sleep(300);
			const filesV1 = await fileSet(dir);

			const r2 = await op({ action: 'write', table: db, id, seed: 'T4-BLOB-B', size: 20 * 1024 }).expect(200);
			const shaB = r2.body.sha;
			notStrictEqual(shaA, shaB, 'sanity: blob A and blob B byte-distinct');
			await sleep(2500); // extra margin: 4 worker threads means GC may be scheduled on a different thread
			const filesV2 = await fileSet(dir);
			const removed = [...filesV1].filter((f) => !filesV2.has(f));
			log(
				`\n[threads:4] files after v1: ${filesV1.size}; after v2+GC: ${filesV2.size}; removed=${JSON.stringify(removed)}`
			);
			ok(removed.length > 0, 'blob A file must be reclaimed on overwrite even under threads:4');

			const cur = await op({ action: 'currentGet', table: db, id }).expect(200);
			strictEqual(cur.body.sha, shaB, 'current record must read back as blob B under threads:4');

			const hist = await op({ action: 'history', table: db, id, timeoutMs: 5000 }).expect(200);
			log(`[threads:4] history entries: ${hist.body.count}`);
			log(`[threads:4] history raw: ${JSON.stringify(hist.body.results, null, 2)}`);
			const v1Entry = hist.body.results[0];
			let classification: string;
			if (v1Entry.outcome.ok && v1Entry.outcome.sha === shaB) {
				classification = 'DEFECT-wrong-bytes-as-history (threads:4)';
			} else if (v1Entry.outcome.ok && v1Entry.outcome.sha === shaA) {
				classification = 'ANOMALY-blobA-still-readable (threads:4)';
			} else if (v1Entry.outcome.isTimeout) {
				classification = `DEFECT-hang (threads:4, ${v1Entry.outcome.elapsedMs}ms)`;
			} else if (v1Entry.outcome.statusCode === 404 || v1Entry.outcome.code === 'ENOENT') {
				classification = `EXPECTED-OK clean typed error (threads:4, statusCode=${v1Entry.outcome.statusCode})`;
			} else {
				classification = `unclassified (threads:4): ${JSON.stringify(v1Entry.outcome)}`;
			}
			log(`\n>>> THREADS:4 ARM CLASSIFICATION: ${classification}`);
		});
	}
);
