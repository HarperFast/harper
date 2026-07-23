/**
 * QA-642 — the `restart_service` ops-API contract: what does a 200 actually promise?
 *
 * Background (established, not re-derived here): `restart_service` is served through the
 * generic async-job pattern (server/serverHelpers/serverUtilities.ts executeJob ->
 * server/jobs/jobRunner.ts parseMessage -> runJob -> launchJobThread). launchJobThread
 * (jobRunner.ts:133) spawns a dedicated "job" worker thread WITHOUT awaiting it, so the
 * operations-API response for the initial `restart_service` call returns as soon as that job
 * thread is *launched* (job status CREATED/IN_PROGRESS), not once workers have respawned.
 * A deploy script that treats that 200 as "restart complete" races the real respawn — this is
 * exactly what broke Harper's own CI.
 *
 * Three questions this test answers with hard evidence:
 *
 *  1. Is there ANY observable a client can poll to know the restart actually finished?
 *     `restart_service` returns a `job_id`. Code reading (bin/restart.ts:100-172,
 *     server/threads/manageThreads.js:412-595 restartWorkers) suggests the job-worker's call to
 *     restartService actually DOES await, via an ITC round trip to the main thread, the main
 *     thread's restartWorkers('http') call — which itself awaits every replacement worker
 *     signalling CHILD_STARTED and every old worker's 'exit' (Promise.all(waitingToFinish))
 *     before replying 'restart-complete'. So get_job's COMPLETE *should* correlate with real
 *     respawn, in contrast to the outer op response. We verify this empirically: poll
 *     system_information{attributes:['threads']} for the live HTTP worker threadId set,
 *     alongside get_job, and check whether the threadId set has ALREADY fully rotated to N new,
 *     disjoint ids by the moment get_job first reports COMPLETE.
 *
 *  2. What happens to REST reads/writes in the restart window? Concurrent clients hammer
 *     GET/PUT every ~20-50ms across the restart_service call. Every outcome is classified
 *     (200/other/ECONNREFUSED/ECONNRESET/timeout). Every PUT that got a 200 ack is read back
 *     after the instance settles — an acked-but-lost write would be the serious defect.
 *
 *  3. Bad input: restart_service with a misspelled service name — 400, or a silent success?
 *
 * Run:
 *   npm run test:integration -- "integrationTests/apiTests/restart-service-contract.test.ts"
 */
import { suite, test, before, after } from 'node:test';
import { ok, strictEqual, deepStrictEqual } from 'node:assert';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';

const FIXTURE_PATH = resolve(import.meta.dirname, 'restart-service-contract');
const WORKERS = 4; // threads.count -- need >1 for a real "respawn all of them" restart

// Skip on Windows: single HTTP worker only (no SO_REUSEPORT) -- restart_service http_workers
// is known-unreliable there (#549), and this whole scenario is about the multi-worker rotation.
const skipSuite = process.platform === 'win32';

function authHeader(ctx: ContextWithHarper) {
	return `Basic ${Buffer.from(`${ctx.harper.admin.username}:${ctx.harper.admin.password}`).toString('base64')}`;
}

interface Outcome {
	kind: 'get' | 'put';
	id: string;
	status?: number;
	ok: boolean;
	errCode?: string;
	t: number;
}

/** POST to the operations API with a fresh (non-pooled) connection and a bounded timeout. */
async function opsCall(ctx: ContextWithHarper, body: unknown, timeoutMs = 5000) {
	const t = Date.now();
	try {
		const res = await fetch(ctx.harper.operationsAPIURL, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', 'Authorization': authHeader(ctx), 'Connection': 'close' },
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(timeoutMs),
		});
		const text = await res.text();
		let json: any;
		try {
			json = JSON.parse(text);
		} catch {
			json = text;
		}
		return { status: res.status, body: json, t, errCode: undefined as string | undefined };
	} catch (err: any) {
		const code = err?.cause?.code ?? err?.code ?? (err?.name === 'TimeoutError' ? 'ETIMEDOUT' : err?.message);
		return { status: -1, body: undefined, t, errCode: String(code) };
	}
}

/** Live HTTP worker threadId set, via system_information{attributes:['threads']}. null on failure. */
async function httpThreadIds(ctx: ContextWithHarper): Promise<{ t: number; ids: number[] | null; errCode?: string }> {
	const r = await opsCall(ctx, { operation: 'system_information', attributes: ['threads'] }, 3000);
	if (r.status !== 200 || !Array.isArray(r.body?.threads))
		return { t: r.t, ids: null, errCode: r.errCode ?? `status ${r.status}` };
	const ids = r.body.threads.filter((w: any) => w.name === 'http').map((w: any) => w.threadId);
	return { t: r.t, ids };
}

function setsDisjoint(a: number[], b: number[]): boolean {
	const sb = new Set(b);
	return a.every((x) => !sb.has(x));
}

suite('QA-642 restart_service ops-API contract', { skip: skipSuite }, (ctx: ContextWithHarper) => {
	before(async () => {
		await setupHarperWithFixture(ctx, FIXTURE_PATH, {
			config: { threads: { count: WORKERS }, logging: { console: true, level: 'trace' } },
			env: {},
		});

		// Poll the probe route directly until it stops 404-ing. Deliberately NOT
		// restartHttpWorkers() -- that helper is itself fire-and-forget, which would make this
		// readiness wait race the very bug under test.
		const deadline = Date.now() + 120_000;
		while (Date.now() < deadline) {
			try {
				const res = await fetch(`${ctx.harper.httpURL}/Widget/`, {
					headers: { Authorization: authHeader(ctx) },
					signal: AbortSignal.timeout(2000),
				});
				if (res.status !== 404) break;
			} catch {
				/* not ready yet */
			}
			await sleep(150);
		}
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	test(
		'restart_service http_workers: job/thread-id observability + write durability across the restart window',
		{ timeout: 180_000 },
		async () => {
			// --- Guard: confirm we really have WORKERS distinct HTTP threads before touching anything ---
			const baseline = await httpThreadIds(ctx);
			ok(baseline.ids, `baseline system_information failed: ${baseline.errCode}`);
			strictEqual(
				baseline.ids!.length,
				WORKERS,
				`expected ${WORKERS} HTTP worker threads, got ${baseline.ids!.length}`
			);
			console.log(`[QA-642] baseline HTTP thread ids: ${JSON.stringify(baseline.ids)}`);

			// --- Start the request stream: CONCURRENCY clients, GET or PUT every 20-50ms, fresh conns ---
			const CONCURRENCY = 4;
			const outcomes: Outcome[] = [];
			let seq = 0;
			let streaming = true;

			async function putWidget(id: string): Promise<Outcome> {
				const t = Date.now();
				try {
					const res = await fetch(`${ctx.harper.httpURL}/Widget/${id}`, {
						method: 'PUT',
						headers: { 'Content-Type': 'application/json', 'Authorization': authHeader(ctx), 'Connection': 'close' },
						body: JSON.stringify({ id, value: `payload-${id}`, seq }),
						signal: AbortSignal.timeout(5000),
					});
					return { kind: 'put', id, status: res.status, ok: res.status >= 200 && res.status < 300, t };
				} catch (err: any) {
					const code = err?.cause?.code ?? err?.code ?? (err?.name === 'TimeoutError' ? 'ETIMEDOUT' : err?.message);
					return { kind: 'put', id, ok: false, errCode: String(code), t };
				}
			}

			async function getWidget(id: string): Promise<Outcome> {
				const t = Date.now();
				try {
					const res = await fetch(`${ctx.harper.httpURL}/Widget/${id}`, {
						headers: { Authorization: authHeader(ctx), Connection: 'close' },
						signal: AbortSignal.timeout(5000),
					});
					return { kind: 'get', id, status: res.status, ok: res.status === 200 || res.status === 404, t };
				} catch (err: any) {
					const code = err?.cause?.code ?? err?.code ?? (err?.name === 'TimeoutError' ? 'ETIMEDOUT' : err?.message);
					return { kind: 'get', id, ok: false, errCode: String(code), t };
				}
			}

			const ackedWrites = new Map<string, { value: string; t: number }>();

			const clientLoops = Array.from({ length: CONCURRENCY }, async (_v, clientIdx) => {
				while (streaming) {
					const id = `w-${clientIdx}-${seq++}`;
					const putOutcome = await putWidget(id);
					outcomes.push(putOutcome);
					if (putOutcome.ok && putOutcome.status !== undefined && putOutcome.status < 300) {
						ackedWrites.set(id, { value: `payload-${id}`, t: putOutcome.t });
					}
					const getOutcome = await getWidget(id);
					outcomes.push(getOutcome);
					await sleep(20 + Math.random() * 30);
				}
			});

			// --- Start the threadId poller (records the full respawn timeline) ---
			const threadSnapshots: Array<{ t: number; ids: number[] | null; errCode?: string }> = [];
			let pollingThreads = true;
			const threadPoller = (async () => {
				while (pollingThreads) {
					threadSnapshots.push(await httpThreadIds(ctx));
					await sleep(25);
				}
			})();

			// Warm-up so the stream is producing steady traffic before we touch anything.
			await sleep(500);
			ok(outcomes.length > 0, 'request stream produced no traffic during warm-up -- harness problem');

			// --- Trigger restart_service http_workers, capture the op response precisely ---
			const tBeforeRestart = Date.now();
			const restartResp = await opsCall(ctx, { operation: 'restart_service', service: 'http_workers' }, 30_000);
			const tAfterRestartResp = Date.now();
			strictEqual(
				restartResp.status,
				200,
				`restart_service should ack 200: ${restartResp.status} ${JSON.stringify(restartResp.body)}`
			);
			const jobId = restartResp.body?.job_id;
			ok(jobId, `restart_service response carried no job_id: ${JSON.stringify(restartResp.body)}`);
			console.log(
				`[QA-642] restart_service acked 200 in ${tAfterRestartResp - tBeforeRestart}ms, job_id=${jobId}, message=${JSON.stringify(restartResp.body?.message)}`
			);

			// --- Poll get_job to a terminal state, recording every status transition we observe ---
			const jobTransitions: Array<{ t: number; status: string }> = [];
			let lastStatus: string | undefined;
			let tJobComplete: number | undefined;
			let finalJob: any;
			{
				const deadline = Date.now() + 60_000;
				while (Date.now() < deadline) {
					const r = await opsCall(ctx, { operation: 'get_job', id: jobId }, 3000);
					const job = Array.isArray(r.body) ? r.body[0] : undefined;
					if (job?.status && job.status !== lastStatus) {
						lastStatus = job.status;
						jobTransitions.push({ t: Date.now(), status: job.status });
						console.log(`[QA-642] get_job(${jobId}) -> ${job.status} at t+${Date.now() - tBeforeRestart}ms`);
					}
					if (job?.status === 'COMPLETE' || job?.status === 'ERROR') {
						tJobComplete = Date.now();
						finalJob = job;
						break;
					}
					await sleep(20);
				}
			}
			ok(tJobComplete, `get_job(${jobId}) never reached a terminal status within 60s`);
			strictEqual(finalJob.status, 'COMPLETE', `restart job ended in ${finalJob.status}: ${JSON.stringify(finalJob)}`);

			// --- Immediately (same tick) check whether the HTTP thread ids are ALREADY fully rotated ---
			const immediatePostComplete = await httpThreadIds(ctx);

			// Keep observing a bit longer so we can see the full rotation timeline settle.
			await sleep(2000);
			pollingThreads = false;
			await threadPoller;

			// --- Let the stream run a little longer post-settle, then stop it ---
			await sleep(500);
			streaming = false;
			await Promise.all(clientLoops);

			// ================= ANALYSIS =================

			// (1) Fire-and-forget confirmation: the op response returns well before the job/restart
			// actually completes.
			ok(
				tAfterRestartResp < tJobComplete!,
				`expected the restart_service HTTP response (t=${tAfterRestartResp}) to return BEFORE the job reached COMPLETE (t=${tJobComplete}) -- if this fails, restart_service is no longer fire-and-forget`
			);
			console.log(
				`[QA-642] op response returned ${tJobComplete! - tAfterRestartResp}ms BEFORE get_job reported COMPLETE -- confirms the initial 200 is not "restart complete".`
			);

			// (2) Does get_job's COMPLETE correlate with the HTTP threads having actually rotated?
			// Find the first snapshot (if any) at/after tJobComplete showing a fully-rotated,
			// full-size, baseline-disjoint set.
			const fullyRotated = (ids: number[] | null) =>
				!!ids && ids.length === WORKERS && setsDisjoint(ids, baseline.ids!);
			const rotatedAtComplete = fullyRotated(immediatePostComplete.ids);
			const anyStaleAfterComplete = threadSnapshots.some((s) => s.t >= tJobComplete! && s.ids && !fullyRotated(s.ids));
			console.log(
				`[QA-642] immediate post-COMPLETE threadId snapshot: ${JSON.stringify(immediatePostComplete.ids)} (fullyRotated=${rotatedAtComplete})`
			);
			console.log(
				`[QA-642] any post-COMPLETE snapshot still showing stale/partial worker set: ${anyStaleAfterComplete}`
			);
			// Only the transitions — the raw per-poll series is ~160 entries and drowns CI output.
			const transitions = threadSnapshots.filter(
				(s, i) => i === 0 || JSON.stringify(s.ids) !== JSON.stringify(threadSnapshots[i - 1].ids)
			);
			console.log(
				`[QA-642] threadId rotation timeline (t relative to restart trigger, ms; transitions only): ${JSON.stringify(
					transitions.map((s) => ({ dt: s.t - tBeforeRestart, ids: s.ids }))
				)}`
			);

			ok(
				rotatedAtComplete,
				`get_job reported COMPLETE at t=${tJobComplete}, but the HTTP thread ids were NOT yet fully rotated to ${WORKERS} new ids at that moment (saw ${JSON.stringify(immediatePostComplete.ids)} vs baseline ${JSON.stringify(baseline.ids)}) -- get_job COMPLETE would be an unreliable "restart is done" signal`
			);

			// (3) Write durability: every acked write must be readable back with the correct value
			// after the instance has settled.
			const lostWrites: string[] = [];
			const mismatchedWrites: string[] = [];
			for (const [id, { value }] of ackedWrites) {
				const r = await getWidget(id);
				if (r.status === 404 || !r.ok) {
					lostWrites.push(id);
					continue;
				}
				const fresh = await fetch(`${ctx.harper.httpURL}/Widget/${id}`, {
					headers: { Authorization: authHeader(ctx) },
					signal: AbortSignal.timeout(5000),
				});
				const json = await fresh.json();
				if (json?.value !== value) mismatchedWrites.push(`${id}: expected ${value}, got ${JSON.stringify(json)}`);
			}
			console.log(
				`[QA-642] write durability: ${ackedWrites.size} acked writes checked, ${lostWrites.length} lost, ${mismatchedWrites.length} mismatched`
			);
			deepStrictEqual(
				lostWrites,
				[],
				`acknowledged (200) writes missing after restart settled -- ACK-THEN-LOSE DEFECT: ${lostWrites.join(', ')}`
			);
			deepStrictEqual(
				mismatchedWrites,
				[],
				`acknowledged writes read back with wrong value: ${mismatchedWrites.join('; ')}`
			);
			ok(ackedWrites.size > 0, 'no writes were acked during the run -- durability check would be vacuous');

			// (4) Outcome classification across the whole window (informational + sanity bounds).
			const buckets = new Map<string, number>();
			for (const o of outcomes) {
				const key = o.status !== undefined ? String(o.status) : `err:${o.errCode}`;
				buckets.set(key, (buckets.get(key) ?? 0) + 1);
			}
			console.log(
				`[QA-642] outcome classification (${outcomes.length} total requests): ${JSON.stringify(Object.fromEntries(buckets))}`
			);

			// No outcome should be an unclassified hang: every request resolved (success or a
			// concrete error code) inside its 5s timeout, i.e. nothing is missing from `outcomes`
			// relative to the number of loop iterations. We also assert we saw >0 successful requests
			// both before and after the restart trigger, proving the stream was live throughout.
			const before1 = outcomes.filter((o) => o.t < tBeforeRestart && o.ok).length;
			const after1 = outcomes.filter((o) => o.t > tJobComplete! && o.ok).length;
			ok(before1 > 0, 'no successful requests observed before the restart -- stream was not actually live');
			ok(after1 > 0, 'no successful requests observed after the restart settled -- instance did not recover');
		}
	);

	test('restart_service with an unknown service name: 400, not a silent restart', { timeout: 30_000 }, async () => {
		const beforeIds = await httpThreadIds(ctx);
		ok(beforeIds.ids, `pre-check system_information failed: ${beforeIds.errCode}`);

		const r = await opsCall(ctx, { operation: 'restart_service', service: 'htp_workerz' }, 10_000);
		console.log(`[QA-642 bad-input] restart_service{service:'htp_workerz'} -> ${r.status} ${JSON.stringify(r.body)}`);

		strictEqual(
			r.status,
			400,
			`expected 400 Bad Request for an unknown service, got ${r.status}: ${JSON.stringify(r.body)}`
		);
		const message = typeof r.body === 'string' ? r.body : (r.body?.error ?? r.body?.message ?? JSON.stringify(r.body));
		ok(/invalid service/i.test(String(message)), `expected an "Invalid service" error message, got: ${message}`);

		// No job_id should have been issued, and nothing should have restarted.
		ok(!r.body?.job_id, `bad-input response unexpectedly carried a job_id: ${JSON.stringify(r.body)}`);
		await sleep(500); // give a hypothetical stray restart a moment to show up
		const afterIds = await httpThreadIds(ctx);
		ok(afterIds.ids, `post-check system_information failed: ${afterIds.errCode}`);
		deepStrictEqual(
			afterIds.ids,
			beforeIds.ids,
			`HTTP worker thread ids changed after a rejected restart_service call -- something restarted despite the 400: before=${JSON.stringify(beforeIds.ids)} after=${JSON.stringify(afterIds.ids)}`
		);
	});
});
