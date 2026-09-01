/**
 * QA-597 — EAV substrate x Blob-valued attribute x type-drift on the same value slot.
 *
 * Product-catalog EAV: one generic `value` slot per attribute row (Attribute table,
 * `value: Any`), holding whatever that attribute happens to be. Most rows are scalars
 * (a price, a title); some rows are LARGE binary payloads (spec sheet, hero image)
 * that exceed the 8KB inline threshold and get externalized to Harper's blob store.
 * The interesting property of EAV is that the SAME value slot is heterogeneously typed
 * across rows, and can DRIFT type over its own lifetime — this probes whether the
 * encoder<->blob-store seam stays correct across every drift direction:
 *
 *   T1 marathon: one id cycles blob -> scalar-string -> scalar-number -> blob -> blob
 *      (replace) -> scalar-string -> DELETE. Round-trip fidelity (sha256) is checked
 *      after every step, both via the internal resource-layer read and via REST
 *      (dot-notation `.value` sub-attribute GET). Also checks that a dot-notation GET
 *      on a now-scalar slot never serves stale/leftover blob bytes.
 *   T2: scalar -> blob (clean externalization of a previously-scalar slot).
 *   T3: blob -> DELETE the row entirely while still blob-valued.
 *   T4: blob -> blob -> blob -> blob, a pure replace chain (no scalar involved), to
 *      stress old-file reclamation across several generations before any cleanup runs.
 *   T5 (decisive): per QA-592/D-139, Harper has NO background orphan sweep — orphaned
 *      files sitting on disk after settle are EXPECTED BY DESIGN, not a leak. T5 records
 *      the raw pre-cleanup disk-file count as a finding only, then runs
 *      `cleanup_orphan_blobs` and polls disk state until it converges (or gives up),
 *      and only THEN judges reclamation. It also re-verifies every still-live blob is
 *      byte-exact post-cleanup (orphaned-ref cross-check: cleanup must reclaim
 *      unreferenced files without ever touching a referenced one).
 *
 * Live-blob accounting: `ctrl` (never touched, blob throughout), `s2b` (ends as blob),
 * `replaceChain` (ends as blob) are expected to survive; `sku1-spec` and `b2delete`
 * are expected to be fully gone (row deleted) by the end of the run — expected live
 * blob-file floor after cleanup is exactly 3.
 *
 * Originating QA-id: QA-597. Promoted from the qa-explorer promote-candidates snapshot (P-384)
 * after a cold gate rerun on main. Held back from PR #1833 (which promoted QA-593/595/596) as
 * a distinct-theme follow-up; unlike those three, this suite has no `sourcedFrom`/cache
 * resolver involved — it targets the EAV-substrate/blob-store seam directly.
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

const SETTLE_STEP_MS = 2_000;
const SETTLE_MAX_STEPS = 20; // up to 40s of polling for cleanup_orphan_blobs to converge

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
		} catch {
			return;
		}
		for (const e of entries) {
			const p = join(d, e.name);
			if (e.isDirectory()) await walk(p);
			else {
				try {
					await stat(p);
					n++;
				} catch {
					/* raced with unlink */
				}
			}
		}
	}
	await walk(dir);
	return n;
}

/** Poll `fn` until it returns `target` or the budget runs out; returns the observed trajectory. */
async function pollUntil(
	fn: () => Promise<number>,
	target: number,
	stepMs: number,
	maxSteps: number
): Promise<number[]> {
	const trajectory: number[] = [await fn()];
	for (let i = 0; i < maxSteps && trajectory[trajectory.length - 1] !== target; i++) {
		await sleep(stepMs);
		trajectory.push(await fn());
	}
	return trajectory;
}

suite('QA-597 EAV substrate x Blob-valued attribute x type-drift', { skip: skipSuite }, (ctx: ContextWithHarper) => {
	let client: ReturnType<typeof createApiClient>;
	let httpURL: string;
	let authHeader: string;
	let blobsRoot: string;
	let mainBlobDir: string;
	let dbName: string;
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

	/** Write a blob-valued row and verify round-trip fidelity via internal read + REST dot-notation. */
	async function writeBlobAndVerify(id: string, size: number, seed: string, label: string) {
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
		return declaredSha;
	}

	/** Overwrite a row with a scalar and verify it reads back clean — including via dot-notation. */
	async function writeScalarAndVerify(
		id: string,
		kind: 'scalar-string' | 'scalar-number',
		seed: string | number,
		label: string,
		priorSha?: string
	) {
		await opOk({ action: 'write', id, kind, seed });

		const vs = await opOk({ action: 'verifyServer', id });
		const expected = kind === 'scalar-number' ? Number(seed) : String(seed);
		if (vs.body.kind === 'blob' || vs.body.scalarValue !== expected) {
			mismatches.push(`${label}: internal verifyServer mismatch after scalar write: ${JSON.stringify(vs.body)}`);
		}

		// The decisive stale-bytes check: dot-notation GET on a now-scalar slot must not
		// serve raw octet-stream bytes reminiscent of a prior blob (content-type AND, if a
		// prior blob sha is known, the response body must not hash to it).
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
		findings.push(
			`${label}: dot-notation GET on scalar slot -> status=${rg.status} content-type=${contentType} bodyLen=${rg.body.length}`
		);
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
		blobsRoot = join(rootPath, 'blobs');

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

	test('setup: seed control blob, discover blob store dir', async () => {
		const ctrlSha = await writeBlobAndVerify('ctrl', 30_000, 'ctrl-v1', 'ctrl (seed)');
		findings.push(`ctrl seeded, sha256=${ctrlSha}`);
		await sleep(500);

		const dbDirs = (await readdir(blobsRoot, { withFileTypes: true })).filter((e) => e.isDirectory());
		ok(
			dbDirs.length >= 1,
			`expected a default-database blob dir under ${blobsRoot}, found: ${JSON.stringify(dbDirs.map((e) => e.name))}`
		);
		dbName = dbDirs[0].name;
		mainBlobDir = join(blobsRoot, dbName);
		findings.push(`blob dir under test: ${mainBlobDir} (database: ${dbName})`);
	});

	test('T1: single-slot marathon — blob -> scalar -> scalar -> blob -> blob(replace) -> scalar -> delete', async () => {
		const id = 'sku1-spec';
		const shaV1 = await writeBlobAndVerify(id, 24_000, 'm-v1', 'T1 step1 (blob v1)');
		findings.push(`T1 after step1 (blob v1): disk files=${await countFiles(mainBlobDir)}`);

		await writeScalarAndVerify(id, 'scalar-string', 'small-text-value', 'T1 step2 (blob->scalar-string)', shaV1);
		findings.push(`T1 after step2 (-> scalar-string): disk files=${await countFiles(mainBlobDir)}`);

		await writeScalarAndVerify(id, 'scalar-number', 42, 'T1 step3 (scalar-string->scalar-number)');
		findings.push(`T1 after step3 (-> scalar-number): disk files=${await countFiles(mainBlobDir)}`);

		const shaV2 = await writeBlobAndVerify(id, 36_000, 'm-v2', 'T1 step4 (scalar->blob v2)');
		findings.push(`T1 after step4 (-> blob v2): disk files=${await countFiles(mainBlobDir)}`);

		const shaV3 = await writeBlobAndVerify(id, 48_000, 'm-v3', 'T1 step5 (blob v2 -> blob v3, replace)');
		ok(shaV3 !== shaV2, 'T1 step5: v3 sha should differ from v2 (sanity on the generator, not the product)');
		findings.push(`T1 after step5 (-> blob v3, replace): disk files=${await countFiles(mainBlobDir)}`);

		await writeScalarAndVerify(id, 'scalar-string', 'final-scalar', 'T1 step6 (blob v3 -> scalar)', shaV3);
		findings.push(`T1 after step6 (-> scalar again): disk files=${await countFiles(mainBlobDir)}`);

		await opOk({ action: 'delete', id });
		const vsAfterDelete = await opOk({ action: 'verifyServer', id });
		if (vsAfterDelete.body.present)
			mismatches.push(`T1 step7: row '${id}' still present after delete: ${JSON.stringify(vsAfterDelete.body)}`);
		findings.push(`T1 after step7 (delete): disk files=${await countFiles(mainBlobDir)}`);
	});

	test('T2: scalar -> blob (clean externalization)', async () => {
		const id = 's2b';
		await writeScalarAndVerify(id, 'scalar-string', 'init-value', 'T2 step1 (write scalar)');
		const before = await countFiles(mainBlobDir);
		const sha = await writeBlobAndVerify(id, 40_000, 's2b-v1', 'T2 step2 (scalar->blob)');
		const after = await countFiles(mainBlobDir);
		findings.push(
			`T2 clean externalization: disk files before=${before} after=${after} (expect after > before), sha=${sha}`
		);
		if (after <= before)
			mismatches.push(
				`T2: disk file count did not increase after scalar->blob write (before=${before}, after=${after})`
			);
	});

	test('T3: blob -> delete row entirely while still blob-valued', async () => {
		const id = 'b2delete';
		await writeBlobAndVerify(id, 20_000, 'b2d-v1', 'T3 step1 (write blob)');
		await opOk({ action: 'delete', id });
		const vs = await opOk({ action: 'verifyServer', id });
		if (vs.body.present) mismatches.push(`T3: row '${id}' still present after delete: ${JSON.stringify(vs.body)}`);
		findings.push(
			`T3 after delete: disk files=${await countFiles(mainBlobDir)} (row gone; file reclamation judged after cleanup_orphan_blobs in T5)`
		);
	});

	test('T4: blob -> blob -> blob -> blob (pure replace chain, no scalar)', async () => {
		const id = 'replaceChain';
		let lastSha = '';
		for (let i = 1; i <= 4; i++) {
			lastSha = await writeBlobAndVerify(id, 16_000, `rc-v${i}`, `T4 replace ${i}/4`);
			findings.push(`T4 after replace ${i}/4: disk files=${await countFiles(mainBlobDir)}`);
		}
		(ctx as any).__replaceChainFinalSha = lastSha;
	});

	test('T5 (decisive): cleanup_orphan_blobs reconciliation and post-cleanup fidelity', async () => {
		// Everything currently expected LIVE: ctrl (blob, untouched), s2b (ended as blob),
		// replaceChain (ended as blob). sku1-spec and b2delete are fully deleted rows.
		const expectedLiveIds = ['ctrl', 's2b', 'replaceChain'];
		const EXPECTED_LIVE_COUNT = expectedLiveIds.length;

		// Pre-cleanup, RAW disk state — recorded as a finding only. Per QA-592/D-139, Harper
		// has NO background orphan sweep; leftover files here are EXPECTED BY DESIGN, not a
		// defect on their own. Judgement is deferred to after cleanup_orphan_blobs runs.
		const preCleanup = await countFiles(mainBlobDir);
		findings.push(
			`T5 pre-cleanup raw disk file count: ${preCleanup} (expected live count after cleanup: ${EXPECTED_LIVE_COUNT})`
		);

		const cleanupResp = await client.req().send({ operation: 'cleanup_orphan_blobs', database: dbName });
		findings.push(
			`T5 cleanup_orphan_blobs invoked (database=${dbName}): status=${cleanupResp.status} body=${JSON.stringify(cleanupResp.body)}`
		);
		ok(
			cleanupResp.status === 200,
			`cleanup_orphan_blobs request failed: ${cleanupResp.status} ${JSON.stringify(cleanupResp.body)}`
		);

		const trajectory = await pollUntil(
			() => countFiles(mainBlobDir),
			EXPECTED_LIVE_COUNT,
			SETTLE_STEP_MS,
			SETTLE_MAX_STEPS
		);
		const postCleanup = trajectory[trajectory.length - 1];
		findings.push(
			`T5 disk files after cleanup_orphan_blobs, sampled every ${SETTLE_STEP_MS}ms: ${trajectory.join(' -> ')} (expected to converge to ${EXPECTED_LIVE_COUNT})`
		);

		// Orphaned-ref cross-check: cleanup must reclaim unreferenced files WITHOUT touching
		// any file a live record still points to. Re-verify every surviving blob byte-exact.
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

		// Deleted rows must stay gone (REST full-record GET => 404/410).
		for (const id of ['sku1-spec', 'b2delete']) {
			const r = await rawGet(`/Attribute/${id}`);
			if (r.status !== 404 && r.status !== 410) {
				mismatches.push(
					`T5: deleted row '${id}' unexpectedly resurfaced after cleanup_orphan_blobs: status=${r.status}`
				);
			}
		}

		if (postCleanup === EXPECTED_LIVE_COUNT) {
			findings.push(
				`T5 VERDICT: cleanup_orphan_blobs converged EXACTLY to the expected live count (${EXPECTED_LIVE_COUNT}) — clean reclamation, no genuine leak`
			);
		} else if (postCleanup > EXPECTED_LIVE_COUNT) {
			findings.push(
				`T5 VERDICT: DEFECT CANDIDATE — ${postCleanup} files remain after cleanup_orphan_blobs, expected ${EXPECTED_LIVE_COUNT} (genuine leak: unreferenced files survived on-demand reclamation)`
			);
		} else {
			findings.push(
				`T5 VERDICT: DEFECT CANDIDATE — only ${postCleanup} files remain after cleanup_orphan_blobs, expected ${EXPECTED_LIVE_COUNT} (cleanup over-reclaimed: a LIVE blob's file may have been deleted)`
			);
		}

		// ── Hard assertions (true defect gates) ──────────────────────────────────
		ok(mismatches.length === 0, `DATA-LOSS/CORRUPTION DEFECT(S):\n${mismatches.join('\n')}`);
		ok(staleBytesSuspects.length === 0, `STALE-BYTES DEFECT(S):\n${staleBytesSuspects.join('\n')}`);
		ok(
			postCleanup === EXPECTED_LIVE_COUNT,
			`ORPHANED-FILE DEFECT: expected exactly ${EXPECTED_LIVE_COUNT} blob file(s) after cleanup_orphan_blobs, found ${postCleanup} in ${mainBlobDir}`
		);
	});
});
