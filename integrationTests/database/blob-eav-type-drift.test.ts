/**
 * QA-597 — EAV substrate x Blob-valued attribute x type-drift on the same value slot.
 *
 * Product-catalog EAV: one generic `value` slot per attribute row (Attribute table,
 * `value: Any`), holding whatever that attribute happens to be. Most rows are scalars
 * (a price, a title); some rows are LARGE binary payloads (spec sheet, hero image)
 * that exceed the 8KB inline threshold and get externalized to Harper's blob store.
 * The interesting property of EAV is that the SAME value slot is heterogeneously typed
 * across rows, and can DRIFT type over its own lifetime — this probes whether the
 * encoder<->blob-store seam stays correct across every drift direction, asserting
 * NATURAL reclamation (the ordinary put()/delete() path — RecordEncoder.ts's
 * deleteBlobsInObject -> blob.ts's scheduleReclamation, ~2s default delay) at every
 * step, rather than deferring judgment to a later manual sweep:
 *
 *   T1 marathon: one id cycles blob -> scalar-string -> scalar-number -> blob -> blob
 *      (replace) -> scalar-string -> DELETE. Round-trip fidelity (sha256 for blobs,
 *      exact value for scalars) is checked after every step, both via the internal
 *      resource-layer read and via REST (dot-notation `.value` sub-attribute GET) —
 *      including that a dot-notation GET on a now-scalar slot never serves stale
 *      blob bytes — and each blob->X transition asserts the OLD file is reclaimed
 *      before the step is considered done.
 *   T2: scalar -> blob (clean externalization of a previously-scalar slot).
 *   T3: blob -> DELETE the row entirely while still blob-valued.
 *   T4: blob -> blob -> blob -> blob, a pure replace chain (no scalar involved), to
 *      stress old-file reclamation across several generations.
 *   T5: `cleanup_orphan_blobs` (blob.ts's `cleanupOrphans`) is a DIFFERENT mechanism
 *      from the above — it only reconciles files that are NOT in the current
 *      process's in-memory pending-reclamation queue (e.g. surviving a crash/restart
 *      before their scheduled unlink ran); it explicitly skips any path still
 *      `pendingReclamation`. T1-T4's per-step assertions already prove the live floor
 *      is exactly 3 files through natural reclamation alone, so T5 asserts that floor
 *      directly and then runs cleanup_orphan_blobs only as a safety/idempotency
 *      diagnostic — it must be a no-op here, since nothing this suite creates is a
 *      genuine cleanup_orphan_blobs-class orphan (that needs its own crash/restart
 *      fixture; see the dispatch task's Findings).
 *
 * Live-blob accounting: `ctrl` (never touched, blob throughout), `s2b` (ends as blob),
 * `replaceChain` (ends as blob) are expected to survive; `sku1-spec` and `b2delete`
 * are expected to be fully gone (row deleted) by the end of the run — expected live
 * blob-file floor is exactly 3, reached through natural reclamation alone.
 *
 * Originating QA-id: QA-597. Promoted from the qa-explorer promote-candidates snapshot (P-384)
 * after a cold gate rerun on main. Held back from PR #1833 (which promoted QA-593/595/596) as
 * a distinct-theme follow-up; unlike those three, this suite has no `sourcedFrom`/cache
 * resolver involved — it targets the EAV-substrate/blob-store seam directly. Reworked during
 * promotion, per independent pre-push review, to assert natural reclamation at each step
 * instead of deferring judgment to a post-sweep count (which let a broken sweeper still pass,
 * since natural reclamation had already reached the live floor before T5 ran it), to remove a
 * race between T2's before/after count and T1's still-draining reclamation queue, and to gate
 * the scalar REST oracle on status/value instead of only on "does it look blob-shaped".
 */
import { suite, test, before, after } from 'node:test';
import { ok } from 'node:assert';
import { resolve, join } from 'node:path';
import { readdir, stat } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import request from 'supertest';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
// @ts-expect-error utils/client.mjs has no type declarations
import { createApiClient } from '../apiTests/utils/client.mjs';
// @ts-expect-error utils/lifecycle.mjs has no type declarations
import { restartHttpWorkers } from '../apiTests/utils/lifecycle.mjs';

const FIXTURE_PATH = resolve(import.meta.dirname, 'blob-eav-type-drift');
const skipSuite = process.platform === 'win32' || process.env.HARPER_RUNTIME === 'bun';
const BLOB_DATABASE = 'data'; // this fixture never creates a second database

function sha256hex(buf: Buffer): string {
	return createHash('sha256').update(buf).digest('hex');
}

/** Recursively count leaf files (blob files live at the bottom of a fan-out dir tree). */
async function countFiles(dir: string): Promise<number> {
	let n = 0;
	async function walk(d: string) {
		let entries;
		try {
			entries = await readdir(d, { withFileTypes: true });
		} catch (err: any) {
			if (err?.code === 'ENOENT') return; // dir not created yet, or already removed
			throw err; // EMFILE/EACCES/etc must not be reported as "no files"
		}
		for (const e of entries) {
			const p = join(d, e.name);
			if (e.isDirectory()) await walk(p);
			else {
				try {
					await stat(p);
					n++;
				} catch (err: any) {
					if (err?.code !== 'ENOENT') throw err; // only a real unlink race is expected here
				}
			}
		}
	}
	await walk(dir);
	return n;
}

/**
 * Wait until `countFiles(dir)` reaches `expectedCount` (natural reclamation landed), or — if it
 * never gets there — until the count plateaus for `minStableMs` (well past blob.ts's ~2s default
 * reclamation delay) so a genuine mismatch is reported promptly instead of spinning for the full
 * budget. This is the gate that makes each step's reclamation assertion real instead of deferring
 * it to a later count taken after everything has had time to settle anyway.
 */
async function waitForSettle(
	dir: string,
	expectedCount: number,
	{ timeoutMs = 20_000, intervalMs = 250, minStableMs = 5_000 } = {}
): Promise<{ count: number; timedOut: boolean; waitedMs: number }> {
	const start = Date.now();
	const deadline = start + timeoutMs;
	let cur = await countFiles(dir);
	let stableSince = start;
	while (cur !== expectedCount && Date.now() < deadline) {
		await sleep(intervalMs);
		const next = await countFiles(dir);
		if (next !== cur) stableSince = Date.now();
		cur = next;
		if (Date.now() - stableSince >= minStableMs) break; // plateaued short of target — real mismatch, report now
	}
	return { count: cur, timedOut: cur !== expectedCount, waitedMs: Date.now() - start };
}

suite('QA-597 EAV substrate x Blob-valued attribute x type-drift', { skip: skipSuite }, (ctx: ContextWithHarper) => {
	let client: ReturnType<typeof createApiClient>;
	let httpURL: string;
	let authHeader: string;
	let mainBlobDir: string;
	const findings: string[] = [];
	const mismatches: string[] = []; // hard-fail gate: any byte-exact/content mismatch anywhere
	const staleBytesSuspects: string[] = []; // hard-fail gate: scalar read that looks like leftover blob bytes

	function op(body: Record<string, unknown>) {
		return request(client.restURL ?? (ctx.harper as any).httpURL)
			.post('/AttrOps/')
			.set(client.headers)
			.send(body)
			.timeout(30_000);
	}

	async function opOk(body: Record<string, unknown>) {
		const r = await op(body);
		ok(r.status === 200 && r.body.ok, `AttrOps ${JSON.stringify(body)} failed: ${r.status} ${JSON.stringify(r.body)}`);
		return r;
	}

	/** Raw fetch with full access to status, headers, and response body as Buffer. */
	async function rawGet(path: string): Promise<{ status: number; headers: Record<string, string>; body: Buffer }> {
		const res = await fetch(`${httpURL}${path}`, { headers: { Authorization: authHeader } });
		const ab = await res.arrayBuffer();
		const headers: Record<string, string> = {};
		res.headers.forEach((v, k) => {
			headers[k.toLowerCase()] = v;
		});
		return { status: res.status, headers, body: Buffer.from(ab) };
	}

	/**
	 * Write a blob-valued row, verify round-trip fidelity via internal read + REST dot-notation,
	 * and assert the live blob-file count settles to `expectedLiveCount` (the write's own file,
	 * plus reclamation of whatever it superseded — or lack thereof if nothing did).
	 */
	async function writeBlobAndVerify(id: string, size: number, seed: string, label: string, expectedLiveCount: number) {
		const w = await opOk({ action: 'write', id, kind: 'blob', size, seed });
		const declaredSha = w.body.sha256;
		ok(declaredSha, `${label}: write did not return sha256`);

		const vs = await opOk({ action: 'verifyServer', id });
		if (vs.body.kind !== 'blob' || vs.body.sha256 !== declaredSha) {
			mismatches.push(`${label}: internal verifyServer mismatch after blob write: ${JSON.stringify(vs.body)}`);
		}

		const rg = await rawGet(`/Attribute/${id}.value`);
		if (rg.status !== 200) {
			mismatches.push(`${label}: dot-notation GET .value returned ${rg.status} for a live blob row`);
		} else {
			const actualSha = sha256hex(rg.body);
			if (actualSha !== declaredSha || rg.body.length !== size) {
				mismatches.push(
					`${label}: dot-notation GET byte mismatch: expected sha=${declaredSha} len=${size}, got sha=${actualSha} len=${rg.body.length}`
				);
			}
		}

		const settled = await waitForSettle(mainBlobDir, expectedLiveCount);
		findings.push(
			`${label}: disk files settled to ${settled.count} (expected ${expectedLiveCount}, waited ${settled.waitedMs}ms)`
		);
		if (settled.timedOut) {
			mismatches.push(
				`${label}: live blob-file count did not settle to ${expectedLiveCount}, stuck at ${settled.count} in ${mainBlobDir}`
			);
		}
		return declaredSha;
	}

	/**
	 * Overwrite a row with a scalar, verify it reads back clean via the internal layer AND real
	 * REST dot-notation (status + exact value, not merely "not blob-shaped"), and assert the live
	 * blob-file count settles to `expectedLiveCount` (the superseded blob, if any, reclaimed).
	 */
	async function writeScalarAndVerify(
		id: string,
		kind: 'scalar-string' | 'scalar-number',
		seed: string | number,
		label: string,
		expectedLiveCount: number,
		priorSha?: string
	) {
		await opOk({ action: 'write', id, kind, seed });

		const vs = await opOk({ action: 'verifyServer', id });
		const expected = kind === 'scalar-number' ? Number(seed) : String(seed);
		if (vs.body.kind === 'blob' || vs.body.scalarValue !== expected) {
			mismatches.push(`${label}: internal verifyServer mismatch after scalar write: ${JSON.stringify(vs.body)}`);
		}

		const rg = await rawGet(`/Attribute/${id}.value`);
		const contentType = rg.headers['content-type'] ?? '';
		if (/octet-stream/i.test(contentType)) {
			staleBytesSuspects.push(
				`${label}: dot-notation GET on scalar slot returned Content-Type ${contentType} (blob-shaped response for a scalar value)`
			);
		}
		if (priorSha && rg.status === 200) {
			const bodySha = sha256hex(rg.body);
			if (bodySha === priorSha) {
				staleBytesSuspects.push(
					`${label}: dot-notation GET on scalar slot returned bytes matching the PRIOR blob's sha256 (${priorSha}) — stale blob bytes served`
				);
			}
		}
		// The round-trip-fidelity gate the header claims: REST dot-notation must return the
		// CURRENT scalar value on success, not merely fail to look blob-shaped.
		if (rg.status !== 200) {
			mismatches.push(`${label}: dot-notation GET .value returned ${rg.status} for a live scalar slot`);
		} else {
			let restValue: unknown;
			try {
				restValue = JSON.parse(rg.body.toString('utf8'));
			} catch (e) {
				mismatches.push(`${label}: dot-notation GET .value body is not valid JSON: ${(e as Error).message}`);
			}
			if (restValue !== expected) {
				mismatches.push(
					`${label}: dot-notation GET .value mismatch: expected ${JSON.stringify(expected)}, got ${JSON.stringify(restValue)}`
				);
			}
		}
		findings.push(
			`${label}: dot-notation GET on scalar slot -> status=${rg.status} content-type=${contentType} bodyLen=${rg.body.length}`
		);

		const settled = await waitForSettle(mainBlobDir, expectedLiveCount);
		findings.push(
			`${label}: disk files settled to ${settled.count} (expected ${expectedLiveCount}, waited ${settled.waitedMs}ms)`
		);
		if (settled.timedOut) {
			mismatches.push(
				`${label}: live blob-file count did not settle to ${expectedLiveCount}, stuck at ${settled.count} in ${mainBlobDir}`
			);
		}
	}

	before(async () => {
		await setupHarperWithFixture(ctx, FIXTURE_PATH, {
			config: { threads: { count: 4 }, logging: { root: 'log', level: 'info' } },
			env: {},
		});
		client = createApiClient(ctx.harper);
		httpURL = client.restURL ?? (ctx.harper as any).httpURL;
		authHeader = client.headers.Authorization;

		const cfg = await client.req().send({ operation: 'get_configuration' }).expect(200);
		const rootPath = cfg.body.rootPath;
		ok(rootPath, 'get_configuration must return rootPath');
		mainBlobDir = join(rootPath, 'blobs', BLOB_DATABASE);

		// Workers register REST routes async after "started" — poll before asserting.
		await restartHttpWorkers(client, '/Attribute/', 120_000);
	});

	after(async () => {
		await teardownHarper(ctx);
		console.log('\n[QA-597] FINDINGS');
		for (const f of findings) console.log('  ' + f);
		if (mismatches.length) {
			console.log('  MISMATCHES:');
			for (const m of mismatches) console.log('    ' + m);
		}
		if (staleBytesSuspects.length) {
			console.log('  STALE-BYTES SUSPECTS:');
			for (const s of staleBytesSuspects) console.log('    ' + s);
		}
	});

	test('setup: seed control blob', async () => {
		const startCount = mismatches.length;
		const ctrlSha = await writeBlobAndVerify('ctrl', 30_000, 'ctrl-v1', 'ctrl (seed)', 1);
		findings.push(`ctrl seeded, sha256=${ctrlSha}, blob dir under test: ${mainBlobDir}`);
		ok(mismatches.length === startCount, `DEFECT(S) during setup:\n${mismatches.slice(startCount).join('\n')}`);
	});

	test('T1: single-slot marathon — blob -> scalar -> scalar -> blob -> blob(replace) -> scalar -> delete', async () => {
		const startCount = mismatches.length;
		const id = 'sku1-spec';
		const shaV1 = await writeBlobAndVerify(id, 24_000, 'm-v1', 'T1 step1 (blob v1)', 2);

		await writeScalarAndVerify(id, 'scalar-string', 'small-text-value', 'T1 step2 (blob->scalar-string)', 1, shaV1);

		await writeScalarAndVerify(id, 'scalar-number', 42, 'T1 step3 (scalar-string->scalar-number)', 1);

		const shaV2 = await writeBlobAndVerify(id, 36_000, 'm-v2', 'T1 step4 (scalar->blob v2)', 2);

		const shaV3 = await writeBlobAndVerify(id, 48_000, 'm-v3', 'T1 step5 (blob v2 -> blob v3, replace)', 2);
		ok(shaV3 !== shaV2, 'T1 step5: v3 sha should differ from v2 (sanity on the generator, not the product)');

		await writeScalarAndVerify(id, 'scalar-string', 'final-scalar', 'T1 step6 (blob v3 -> scalar)', 1, shaV3);

		await opOk({ action: 'delete', id });
		const vsAfterDelete = await opOk({ action: 'verifyServer', id });
		if (vsAfterDelete.body.present)
			mismatches.push(`T1 step7: row '${id}' still present after delete: ${JSON.stringify(vsAfterDelete.body)}`);
		findings.push(`T1 after step7 (delete, no blob to reclaim): disk files=${await countFiles(mainBlobDir)}`);

		ok(
			mismatches.length === startCount && staleBytesSuspects.length === 0,
			`DEFECT(S) during T1:\n${[...mismatches.slice(startCount), ...staleBytesSuspects].join('\n')}`
		);
	});

	test('T2: scalar -> blob (clean externalization)', async () => {
		const startCount = mismatches.length;
		const id = 's2b';
		await writeScalarAndVerify(id, 'scalar-string', 'init-value', 'T2 step1 (write scalar)', 1);
		const sha = await writeBlobAndVerify(id, 40_000, 's2b-v1', 'T2 step2 (scalar->blob)', 2);
		findings.push(`T2 clean externalization sha=${sha}`);

		ok(mismatches.length === startCount, `DEFECT(S) during T2:\n${mismatches.slice(startCount).join('\n')}`);
	});

	test('T3: blob -> delete row entirely while still blob-valued', async () => {
		const startCount = mismatches.length;
		const id = 'b2delete';
		await writeBlobAndVerify(id, 20_000, 'b2d-v1', 'T3 step1 (write blob)', 3);

		await opOk({ action: 'delete', id });
		const vs = await opOk({ action: 'verifyServer', id });
		if (vs.body.present) mismatches.push(`T3: row '${id}' still present after delete: ${JSON.stringify(vs.body)}`);

		// Per-record delete reclaims its blob the same way an overwrite does (RecordEncoder's
		// removeEntry -> deleteBlobsInObject), so the deleted row's file must settle away too.
		const settled = await waitForSettle(mainBlobDir, 2);
		findings.push(`T3 after delete: disk files settled to ${settled.count} (expected 2, waited ${settled.waitedMs}ms)`);
		if (settled.timedOut) {
			mismatches.push(`T3: deleted row '${id}'s blob file was not reclaimed, stuck at ${settled.count} live files`);
		}

		ok(mismatches.length === startCount, `DEFECT(S) during T3:\n${mismatches.slice(startCount).join('\n')}`);
	});

	test('T4: blob -> blob -> blob -> blob (pure replace chain, no scalar)', async () => {
		const startCount = mismatches.length;
		const id = 'replaceChain';
		let lastSha = '';
		// First write introduces a new live file (3 -> 3, since T3's row is already gone); each
		// replacement after that reclaims the prior generation, net zero change.
		for (let i = 1; i <= 4; i++) {
			lastSha = await writeBlobAndVerify(id, 16_000, `rc-v${i}`, `T4 replace ${i}/4`, 3);
		}
		findings.push(`T4 final sha=${lastSha}`);

		ok(mismatches.length === startCount, `DEFECT(S) during T4:\n${mismatches.slice(startCount).join('\n')}`);
	});

	test('T5: live-floor reached by natural reclamation alone; cleanup_orphan_blobs is a safe no-op', async () => {
		// Everything currently expected LIVE: ctrl (blob, untouched), s2b (ended as blob),
		// replaceChain (ended as blob). sku1-spec and b2delete are fully deleted rows.
		const expectedLiveIds = ['ctrl', 's2b', 'replaceChain'];
		const EXPECTED_LIVE_COUNT = expectedLiveIds.length;

		// The substantive assertion: T1-T4 already drove every drift step to settle via NATURAL
		// reclamation (the ordinary put()/delete() path), so the live floor must already be exact
		// BEFORE cleanup_orphan_blobs ever runs — crediting the sweep with work the queue already
		// did would let a broken sweeper still pass.
		const preCleanup = await countFiles(mainBlobDir);
		findings.push(`T5 pre-cleanup disk file count: ${preCleanup} (expected ${EXPECTED_LIVE_COUNT})`);
		ok(
			preCleanup === EXPECTED_LIVE_COUNT,
			`DEFECT: live blob-file count is ${preCleanup} before cleanup_orphan_blobs even ran, expected ${EXPECTED_LIVE_COUNT} from natural reclamation alone`
		);

		// cleanup_orphan_blobs targets a DIFFERENT class of file (one lost from the in-memory
		// pending-reclamation queue, e.g. across a crash/restart) — nothing this suite creates
		// qualifies, so it must be a safe no-op here. Run it as a diagnostic, not as the gate.
		const cleanupResp = await client.req().send({ operation: 'cleanup_orphan_blobs', database: BLOB_DATABASE });
		findings.push(
			`T5 cleanup_orphan_blobs invoked (database=${BLOB_DATABASE}): status=${cleanupResp.status} body=${JSON.stringify(cleanupResp.body)}`
		);
		ok(
			cleanupResp.status === 200,
			`cleanup_orphan_blobs request failed: ${cleanupResp.status} ${JSON.stringify(cleanupResp.body)}`
		);

		const postCleanup = await waitForSettle(mainBlobDir, EXPECTED_LIVE_COUNT, { timeoutMs: 8_000, minStableMs: 3_000 });
		findings.push(
			`T5 post-cleanup disk file count: ${postCleanup.count} (waited ${postCleanup.waitedMs}ms, expected unchanged at ${EXPECTED_LIVE_COUNT})`
		);

		// Orphaned-ref cross-check: cleanup must not have touched any file a live record still
		// points to. Re-verify every surviving blob byte-exact.
		for (const id of expectedLiveIds) {
			const vs = await opOk({ action: 'verifyServer', id });
			if (!vs.body.present || vs.body.kind !== 'blob' || vs.body.readError) {
				mismatches.push(
					`T5: '${id}' unreadable/corrupted after cleanup_orphan_blobs (ORPHANED-REF): ${JSON.stringify(vs.body)}`
				);
				continue;
			}
			const rg = await rawGet(`/Attribute/${id}.value`);
			const actualSha = rg.status === 200 ? sha256hex(rg.body) : null;
			if (actualSha !== vs.body.sha256) {
				mismatches.push(
					`T5: '${id}' REST dot-notation read after cleanup_orphan_blobs mismatches internal sha (internal=${vs.body.sha256}, rest=${actualSha}, status=${rg.status})`
				);
			}
			findings.push(`T5 post-cleanup live check '${id}': OK, sha256=${vs.body.sha256}`);
		}

		// Deleted rows must stay gone.
		for (const id of ['sku1-spec', 'b2delete']) {
			const r = await rawGet(`/Attribute/${id}`);
			if (r.status !== 404 && r.status !== 410) {
				mismatches.push(
					`T5: deleted row '${id}' unexpectedly resurfaced after cleanup_orphan_blobs: status=${r.status}`
				);
			}
		}

		if (postCleanup.count === EXPECTED_LIVE_COUNT) {
			findings.push(
				'T5 VERDICT: natural reclamation already reached the exact live floor; cleanup_orphan_blobs was a clean no-op'
			);
		} else if (postCleanup.count > EXPECTED_LIVE_COUNT) {
			findings.push(
				`T5 VERDICT: DEFECT CANDIDATE — cleanup_orphan_blobs left ${postCleanup.count} files, expected ${EXPECTED_LIVE_COUNT} unchanged`
			);
		} else {
			findings.push(
				`T5 VERDICT: DEFECT CANDIDATE — cleanup_orphan_blobs over-reclaimed to ${postCleanup.count} files, expected ${EXPECTED_LIVE_COUNT} unchanged (a LIVE blob's file may have been deleted)`
			);
		}

		// ── Hard assertions (true defect gates) ──────────────────────────────────
		ok(mismatches.length === 0, `DATA-LOSS/CORRUPTION DEFECT(S):\n${mismatches.join('\n')}`);
		ok(staleBytesSuspects.length === 0, `STALE-BYTES DEFECT(S):\n${staleBytesSuspects.join('\n')}`);
		ok(
			postCleanup.count === EXPECTED_LIVE_COUNT,
			`cleanup_orphan_blobs must be a no-op here: expected ${EXPECTED_LIVE_COUNT} unchanged, found ${postCleanup.count} in ${mainBlobDir}`
		);
	});
});
