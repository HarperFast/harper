/**
 * Concurrent PATCH field-level merge correctness (collaborative document).
 *
 * Pins the invariant that Harper's commit-time re-read + delta merge produces correct
 * results when many clients PATCH different fields of the same record simultaneously.
 * Key behaviours asserted:
 *   (a) Disjoint-field concurrency: N clients each PATCH a DIFFERENT single field
 *       simultaneously → ALL N field updates must survive (0 lost updates).
 *   (a2/a3) Burst and stress variants to increase race probability.
 *   (b) Same-field concurrency: N clients PATCH the SAME field → exactly one value
 *       survives (LWW), other fields are untouched (no side-effect clobber).
 *   (c) PATCH merges vs PUT replaces: serial baseline confirming semantics.
 *   (c2) Concurrent PATCH vs PUT race: either may win, but the record must be one of the
 *       two serial outcomes.
 *
 * Both RocksDB (default) and LMDB engines are tested via HARPER_STORAGE_ENGINE=lmdb.
 */

import { suite, test, before, after } from 'node:test';
import { ok, strictEqual } from 'node:assert';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
// @ts-expect-error no type declarations
import { createApiClient } from '../apiTests/utils/client.mjs';

const FIXTURE_PATH = resolve(import.meta.dirname, 'patch-disjoint-field-merge');
const ENGINE = process.env.HARPER_STORAGE_ENGINE === 'lmdb' ? 'lmdb' : 'rocksdb';

const findings: string[] = [];
function log(line: string) {
	process.stdout.write(line + '\n');
	findings.push(line);
}

// The set of disjoint fields we will concurrently PATCH
const DISJOINT_FIELDS = ['title', 'body', 'status', 'viewCount', 'lastEditedBy', 'tag', 'priority', 'notes', 'extra'];
const N_DISJOINT = DISJOINT_FIELDS.length; // 9

suite(`concurrent PATCH field-level merge — ${ENGINE}`, (ctx: ContextWithHarper) => {
	let httpURL: string;
	let auth: string;

	before(async () => {
		await setupHarperWithFixture(ctx, FIXTURE_PATH, {
			config: {
				storage: { engine: ENGINE },
				threads: { count: 4 },
			},
			env: {},
		});

		const client = createApiClient(ctx.harper);
		httpURL = ctx.harper.httpURL;
		auth = client.headers.Authorization;

		// Readiness poll — wait until CollabDoc endpoint responds (not 404)
		const deadline = Date.now() + 30_000;
		while (Date.now() < deadline) {
			try {
				const probe = await fetch(`${httpURL}/CollabDoc/`, {
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
		console.log(`\n[patch-merge:${ENGINE}] FINDINGS MATRIX`);
		for (const line of findings) console.log(line);
	});

	// ── helpers ──────────────────────────────────────────────────────────────────

	async function putDoc(id: string, doc: Record<string, unknown>): Promise<Response> {
		return fetch(`${httpURL}/CollabDoc/${encodeURIComponent(id)}`, {
			method: 'PUT',
			headers: { 'Content-Type': 'application/json', 'Authorization': auth },
			body: JSON.stringify(doc),
			signal: AbortSignal.timeout(10_000),
		});
	}

	async function patchDoc(id: string, partial: Record<string, unknown>): Promise<Response> {
		return fetch(`${httpURL}/CollabDoc/${encodeURIComponent(id)}`, {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json', 'Authorization': auth },
			body: JSON.stringify(partial),
			signal: AbortSignal.timeout(10_000),
		});
	}

	async function getDoc(id: string): Promise<Record<string, unknown> | null> {
		const res = await fetch(`${httpURL}/CollabDoc/${encodeURIComponent(id)}`, {
			headers: { Authorization: auth },
			signal: AbortSignal.timeout(5_000),
		});
		if (res.status === 404) return null;
		return res.json() as Promise<Record<string, unknown>>;
	}

	// ── (c) PATCH vs PUT semantics: baseline confirm ───────────────────────────
	// Serial baseline confirming merge vs replace semantics before the concurrency probes.
	test('(c) PATCH-merge vs PUT-replace: serial baseline', async () => {
		const id = `patch-merge-c-${ENGINE}-${Date.now()}`;

		await putDoc(id, {
			id,
			title: 'original-title',
			body: 'original-body',
			status: 'draft',
		});

		const patchRes = await patchDoc(id, { title: 'patched-title' });
		log(`[c] PATCH title status=${patchRes.status}`);

		const afterPatch = await getDoc(id);
		log(`[c] after PATCH: title=${afterPatch?.title} body=${afterPatch?.body} status=${afterPatch?.status}`);

		const patchMerges =
			afterPatch?.title === 'patched-title' && afterPatch?.body === 'original-body' && afterPatch?.status === 'draft';

		if (patchMerges) {
			log(`[c] PATCH MERGES correctly: patched field updated, untouched fields preserved`);
		} else {
			log(
				`[c] >>> PATCH does NOT merge: body=${afterPatch?.body} status=${afterPatch?.status} (expected preserved) <<<`
			);
		}

		await putDoc(id, { id, title: 'put-title' });
		const afterPut = await getDoc(id);
		log(`[c] after PUT: title=${afterPut?.title} body=${afterPut?.body} status=${afterPut?.status}`);

		const putReplaces = afterPut?.title === 'put-title' && (afterPut?.body == null || afterPut?.body === '');
		if (putReplaces) {
			log(`[c] PUT REPLACES correctly: body dropped after partial PUT`);
		} else {
			log(`[c] PUT did NOT replace fully: body=${afterPut?.body} (expected null/undefined/empty)`);
		}

		ok(patchMerges, `PATCH should merge fields; got: ${JSON.stringify(afterPatch)}`);
		ok(putReplaces, `PUT should replace the record, dropping unspecified fields; got: ${JSON.stringify(afterPut)}`);
	});

	// ── (a) Disjoint-field concurrency: N clients each PATCH a DIFFERENT field ──
	// Core regression: ALL N field updates must survive (0 lost updates).
	test('(a) Disjoint-field concurrency: N clients PATCH different fields simultaneously', async () => {
		const id = `patch-merge-a-${ENGINE}-${Date.now()}`;
		const RUNS = 5;
		const runResults: Array<{ survived: number; lost: string[] }> = [];

		for (let run = 0; run < RUNS; run++) {
			const runId = `${id}-r${run}`;
			await putDoc(runId, { id: runId });

			const patches = DISJOINT_FIELDS.map((field) => {
				const value =
					field === 'viewCount' || field === 'priority'
						? run * 100 + DISJOINT_FIELDS.indexOf(field) + 1
						: `${field}-value-run${run}`;
				return patchDoc(runId, { [field]: value });
			});

			const responses = await Promise.all(patches);
			const statuses = responses.map((r) => r.status);
			log(`[a:${run}] PATCH statuses: ${statuses.join(',')}`);

			await sleep(50);

			const doc = await getDoc(runId);
			const lost: string[] = [];
			let survived = 0;

			for (let i = 0; i < DISJOINT_FIELDS.length; i++) {
				const field = DISJOINT_FIELDS[i];
				const expected = field === 'viewCount' || field === 'priority' ? run * 100 + i + 1 : `${field}-value-run${run}`;
				const actual = doc?.[field];

				if (actual === expected || (typeof expected === 'number' && Number(actual) === expected)) {
					survived++;
				} else {
					lost.push(`${field}(expected=${expected},got=${actual})`);
				}
			}

			log(`[a:run${run}] survived=${survived}/${N_DISJOINT} lost=[${lost.join(', ')}]`);
			runResults.push({ survived, lost });
		}

		const allSurvived = runResults.every((r) => r.survived === N_DISJOINT);
		const minSurvived = Math.min(...runResults.map((r) => r.survived));
		const totalLost = runResults.reduce((s, r) => s + (N_DISJOINT - r.survived), 0);

		if (allSurvived) {
			log(`[a] ALL DISJOINT-FIELD PATCHes SURVIVED in all ${RUNS} runs on ${ENGINE}. Merge is CORRECT.`);
		} else {
			log(
				`[a] >>> LOST UPDATES DETECTED [${ENGINE}]: minSurvived=${minSurvived}/${N_DISJOINT} across ${RUNS} runs; totalLost=${totalLost} <<<`
			);
			for (let i = 0; i < runResults.length; i++) {
				if (runResults[i].lost.length > 0) {
					log(`[a] run${i} lost: ${runResults[i].lost.join(' | ')}`);
				}
			}
		}

		ok(
			allSurvived,
			`Disjoint-field PATCH lost updates on ${ENGINE}: minSurvived=${minSurvived}/${N_DISJOINT}. Lost: ${runResults.flatMap((r) => r.lost).join('; ')}`
		);
	});

	// ── (a2) Disjoint-field concurrency: higher concurrency burst ───────────────
	test('(a2) Disjoint-field concurrency: burst of 20 rapid PATCH rounds', async () => {
		const id = `patch-merge-a2-${ENGINE}-${Date.now()}`;
		const BURST_ROUNDS = 20;
		let totalRuns = 0;
		let lostRuns = 0;
		let totalLostFields = 0;

		for (let round = 0; round < BURST_ROUNDS; round++) {
			const runId = `${id}-b${round}`;
			await putDoc(runId, { id: runId });

			const patches = DISJOINT_FIELDS.map((field, i) => {
				const value = field === 'viewCount' || field === 'priority' ? round * 1000 + i + 1 : `${field}-burst${round}`;
				return patchDoc(runId, { [field]: value });
			});

			await Promise.all(patches);
			await sleep(20);

			const doc = await getDoc(runId);
			const lost: string[] = [];
			for (let i = 0; i < DISJOINT_FIELDS.length; i++) {
				const field = DISJOINT_FIELDS[i];
				const expected =
					field === 'viewCount' || field === 'priority' ? round * 1000 + i + 1 : `${field}-burst${round}`;
				const actual = doc?.[field];
				const matches = actual === expected || (typeof expected === 'number' && Number(actual) === expected);
				if (!matches) lost.push(field);
			}

			totalRuns++;
			if (lost.length > 0) {
				lostRuns++;
				totalLostFields += lost.length;
			}
		}

		log(
			`[a2] burst summary [${ENGINE}]: ${lostRuns}/${totalRuns} rounds had lost fields; totalLostFields=${totalLostFields}`
		);

		if (lostRuns === 0) {
			log(`[a2] ALL ${BURST_ROUNDS} burst rounds: disjoint-field PATCH merge CORRECT on ${ENGINE}`);
		} else {
			log(
				`[a2] >>> LOST UPDATES: ${lostRuns}/${BURST_ROUNDS} rounds, ${totalLostFields} total field losses [${ENGINE}] <<<`
			);
		}

		ok(
			lostRuns === 0,
			`Burst disjoint-field PATCH lost updates on ${ENGINE}: ${lostRuns}/${BURST_ROUNDS} rounds had losses`
		);
	});

	// ── (b) Same-field concurrency: N clients PATCH the SAME field ───────────────
	// LWW expected: exactly one value survives, other fields must be untouched.
	test('(b) Same-field concurrency: N clients PATCH same field — LWW, no corruption', async () => {
		const id = `patch-merge-b-${ENGINE}-${Date.now()}`;
		const CONC = 20;

		await putDoc(id, {
			id,
			title: 'original',
			body: 'should-survive',
			status: 'initial',
			viewCount: 0,
		});

		const values = Array.from({ length: CONC }, (_, i) => `title-v${i}`);
		const patches = values.map((v) => patchDoc(id, { title: v }));
		const responses = await Promise.all(patches);
		const statuses = responses.map((r) => r.status);
		log(`[b] ${CONC} concurrent same-field PATCH statuses: ${[...new Set(statuses)].join(',')}`);

		await sleep(50);

		const doc = await getDoc(id);
		const storedTitle = doc?.title as string;
		const isOneOfSubmitted = values.includes(storedTitle);
		const bodyPreserved = doc?.body === 'should-survive';
		const statusPreserved = doc?.status === 'initial';

		log(`[b] stored title="${storedTitle}" (one of submitted: ${isOneOfSubmitted})`);
		log(`[b] other fields preserved: body=${bodyPreserved} status=${statusPreserved}`);

		if (isOneOfSubmitted && bodyPreserved) {
			log(`[b] Same-field PATCH: LWW correct (one survivor from submitted set), other fields preserved`);
		} else if (!isOneOfSubmitted) {
			log(`[b] >>> CORRUPTION: stored title "${storedTitle}" not in submitted value set <<<`);
		} else if (!bodyPreserved) {
			log(`[b] >>> SIDE-EFFECT: same-field PATCH clobbered unrelated field body (got: ${doc?.body}) <<<`);
		}

		ok(isOneOfSubmitted, `Same-field LWW: stored "${storedTitle}" not in submitted values`);
		ok(bodyPreserved, `Same-field PATCH clobbered unrelated body field: got "${doc?.body}"`);
	});

	// ── (c2) Concurrent PATCH vs PUT race: either may win, but serially ──────────
	test('(c2) Concurrent PATCH vs PUT race ends in one of the two serial outcomes', async () => {
		const id = `patch-merge-c2-${ENGINE}-${Date.now()}`;
		const ROUNDS = 5;

		for (let round = 0; round < ROUNDS; round++) {
			const runId = `${id}-r${round}`;
			await putDoc(runId, { id: runId, title: 'original-title', body: 'original-body' });

			const [patchRes, putRes] = await Promise.all([
				patchDoc(runId, { title: `patch-title-r${round}` }),
				putDoc(runId, { id: runId, body: `put-body-r${round}` }),
			]);

			await sleep(30);
			const doc = await getDoc(runId);

			log(
				`[c2:r${round}] PUT.status=${putRes.status} PATCH.status=${patchRes.status} title="${doc?.title}" body="${doc?.body}"`
			);
			strictEqual(patchRes.status, 204, `[c2:r${round}] PATCH`);
			strictEqual(putRes.status, 204, `[c2:r${round}] PUT`);
			strictEqual(doc?.body, `put-body-r${round}`, `[c2:r${round}] body must be the PUT's: ${JSON.stringify(doc)}`);
			ok(
				doc?.title == null || doc.title === `patch-title-r${round}`,
				`[c2:r${round}] title must be absent (PATCH first) or the PATCH's (PUT first): ${JSON.stringify(doc)}`
			);
		}
	});

	// ── (a3) Stress: repeated rapid concurrent disjoint PATCH ─────────────────
	test('(a3) Stress: repeated rapid concurrent disjoint PATCH — no lost update', async () => {
		const id = `patch-merge-a3-${ENGINE}-${Date.now()}`;
		const ROUNDS = 10;
		let lostAny = false;
		const lossReport: string[] = [];

		for (let round = 0; round < ROUNDS; round++) {
			const runId = `${id}-s${round}`;
			await putDoc(runId, { id: runId });

			const wave1 = DISJOINT_FIELDS.map((field, i) => {
				const v = field === 'viewCount' || field === 'priority' ? round * 10000 + i + 1 : `${field}-stress-${round}`;
				return patchDoc(runId, { [field]: v });
			});
			await Promise.all(wave1);

			// Immediate second wave with same values (idempotent re-apply)
			const wave2 = DISJOINT_FIELDS.map((field, i) => {
				const v = field === 'viewCount' || field === 'priority' ? round * 10000 + i + 1 : `${field}-stress-${round}`;
				return patchDoc(runId, { [field]: v });
			});
			await Promise.all(wave2);

			await sleep(30);

			const doc = await getDoc(runId);
			const lost: string[] = [];
			for (let i = 0; i < DISJOINT_FIELDS.length; i++) {
				const field = DISJOINT_FIELDS[i];
				const expected =
					field === 'viewCount' || field === 'priority' ? round * 10000 + i + 1 : `${field}-stress-${round}`;
				const actual = doc?.[field];
				const ok_ = actual === expected || (typeof expected === 'number' && Number(actual) === expected);
				if (!ok_) lost.push(`${field}(exp=${expected},got=${actual})`);
			}

			if (lost.length > 0) {
				lostAny = true;
				lossReport.push(`round${round}: ${lost.join(' | ')}`);
			}
		}

		if (!lostAny) {
			log(`[a3] STRESS: All ${ROUNDS} rounds × ${N_DISJOINT} fields: NO LOST UPDATES on ${ENGINE}`);
		} else {
			log(`[a3] >>> STRESS LOST UPDATES [${ENGINE}]: ${lossReport.length}/${ROUNDS} rounds affected <<<`);
			for (const r of lossReport) log(`  ${r}`);
		}

		ok(!lostAny, `Stress disjoint-field PATCH had lost updates on ${ENGINE}: ${lossReport.join('; ')}`);
	});
});
