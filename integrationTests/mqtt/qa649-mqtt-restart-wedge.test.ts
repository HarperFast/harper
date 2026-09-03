/**
 * Promoted from qa-explorer (QA-649 / P-425): pins that an MQTT connect attempt, on any
 * transport, never wedges (neither completes nor errors) across an `http_workers` restart —
 * the MQTT-side companion to the REST-side restart contract in
 * deploy-restart-topic-availability.test.ts.
 *
 * QA-649 — does an MQTT connect wedge (neither complete nor error) across an HTTP-worker
 * restart, as seen in a prior cluster experiment where `mqtt.connect()` over the WebSocket
 * `/mqtt` endpoint, fired right after `restart_service {service:'http_workers'}`, sat forever
 * (600s+) with no `connectTimeout` firing and no further connection attempts in the log?
 *
 * Background established by QA-642 (integrationTests/qa-scratch/qa642-restart-contract.test.ts):
 * `restart_service`'s initial HTTP 200 is launch-only (job CREATED/IN_PROGRESS), not "restart
 * complete" — but `get_job` reaching COMPLETE DOES correlate with the HTTP worker threadIds
 * having actually, fully rotated. So `get_job` COMPLETE is the correct completion signal to poll
 * for; the outer 200 is not. This test reuses that idiom (poll get_job, never the fire-and-forget
 * `restartHttpWorkers()` shared helper, which discards the job id and would race the very window
 * under test).
 *
 * Method: fire MQTT connect attempts on a fixed cadence (WS /mqtt every 50ms; raw TCP :1883 every
 * 100ms; TLS :8883 every 200ms — coarser cadences on the contrast surfaces purely to bound total
 * concurrent client count, not because they matter less) spanning [1s warm-up] -> [restart_service
 * trigger] -> [get_job poll to COMPLETE] -> [2s tail]. Every attempt is bounded: mqtt.js
 * `connectTimeout` + our own wall-clock cap (WALL_CLOCK_MS) via a manual timer, so a real wedge is
 * *measured* (kind: 'wedged') rather than hanging the test. Every attempt is fully accounted for:
 * exactly one of completed / refused / wedged.
 *
 * Oracle, both sides:
 *   - client side: did 'connect' fire (completed), 'error'/'close' fire pre-connack (refused), or
 *     neither within the bounded window (wedged)?
 *   - server side: hdb.log at logging.level 'trace' in the harness's per-suite log directory
 *     (`ctx.harper.logDir`, always populated -- the test runner sets
 *     HARPER_INTEGRATION_TEST_LOG_DIR itself when the caller hasn't) — server/mqtt.ts logs
 *     `Received WebSocket connection for MQTT from` / `Received TCP connection for MQTT from` /
 *     `Received SSL connection for MQTT from` at the moment the TRANSPORT (WS upgrade / raw
 *     socket) is accepted, BEFORE the MQTT CONNECT packet is even parsed. If the whole-run count
 *     of these "accepted" log lines exceeds the whole-run count of client-accounted-for
 *     (completed + refused) outcomes for the same surface (beyond the +1 the baseline usability
 *     probe below deliberately contributes and excludes), that is server-side proof of an accept
 *     the client never accounted for at all — evidence independent of, and complementary to, the
 *     client-side wedge count `assertNoWedge` pins to zero (a past QA finding was retracted for
 *     exactly this kind of one-sided evidence). `refused` counts on the client side because the
 *     server logs "accepted" several ms before CONNACK — a worker torn down inside that gap
 *     during the rolling restart is a legitimate accept-then-reset, not a wedge. This is asserted,
 *     not just logged.
 */
import { suite, test, before, after } from 'node:test';
import { ok, strictEqual } from 'node:assert';
import { resolve, join } from 'node:path';
import { readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';

import mqtt, { type IClientOptions, type MqttClient } from 'mqtt';

import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';

const FIXTURE_PATH = resolve(import.meta.dirname, 'qa649-mqtt-restart-wedge');
const WORKERS = 4; // need >1 for a real "rotate them all" restart, matching QA-642's rationale

// mqtt.js's WebSocket transport doesn't complete CONNACK on Bun, and `restart_service` crashes
// the instance on Windows (harper#549) — the same skips the sibling MQTT and restart suites carry.
const skipSuite = process.env.HARPER_RUNTIME === 'bun' || process.platform === 'win32';

// Per-attempt bounds. WALL_CLOCK_MS is the hard measurement cap: an attempt that hits this without
// 'connect'/'error'/'close' is classified 'wedged'. mqtt.js's own connectTimeout is set shorter so
// mqtt.js's internal watchdog gets a chance to fire first if it's going to — if it DOESN'T fire and
// we still hit WALL_CLOCK_MS, that's itself an interesting sub-finding (mqtt.js's own timeout is
// wedged too, matching the "no connectTimeout fired" detail from the prior cluster report).
const MQTT_JS_CONNECT_TIMEOUT_MS = 6000;
const WALL_CLOCK_MS = 10_000;
const LATE_GRACE_MS = 5000; // extra observation window on a capped subset of wedged clients, to see if they self-heal
const LATE_WATCH_CAP = 6; // per surface

const WARMUP_MS = 1000;
const TAIL_MS = 2000;
// Ceiling on the post-COMPLETE condition-wait for every surface to serve a fresh connect again.
const POST_RESTART_RECOVERY_MS = 30_000;

interface AttemptResult {
	surface: 'ws' | 'tcp' | 'tls';
	seq: number;
	launchedAt: number;
	kind: 'completed' | 'refused' | 'wedged';
	detail: string;
	tEnd: number;
	client: MqttClient;
}

function authOpts(ctx: ContextWithHarper, clientId: string): IClientOptions {
	return {
		protocolVersion: 5,
		reconnectPeriod: 0,
		connectTimeout: MQTT_JS_CONNECT_TIMEOUT_MS,
		clean: true,
		username: ctx.harper.admin.username,
		password: ctx.harper.admin.password,
		clientId,
		rejectUnauthorized: false, // only meaningful for the TLS (mqtts) surface; harmless elsewhere
	};
}

/** One bounded connect attempt. NEVER rejects/throws; always resolves within WALL_CLOCK_MS. */
function attemptConnect(
	url: string,
	opts: IClientOptions
): Promise<Omit<AttemptResult, 'surface' | 'seq' | 'launchedAt'>> {
	return new Promise((resolveOuter) => {
		let classified = false;
		let client: MqttClient;
		try {
			client = mqtt.connect(url, opts);
		} catch (err: any) {
			resolveOuter({
				kind: 'refused',
				detail: `sync throw: ${err?.message}`,
				tEnd: Date.now(),
				client: undefined as any,
			});
			return;
		}
		const finish = (kind: AttemptResult['kind'], detail: string) => {
			if (classified) return;
			classified = true;
			clearTimeout(wedgeTimer);
			resolveOuter({ kind, detail, tEnd: Date.now(), client });
		};
		client.once('connect', () => finish('completed', 'connack received'));
		// .on, not .once: classified guards finish() to a single effect, but the listener must
		// stay attached -- a client force-closed post-classification can emit a second 'error',
		// and an unhandled second EventEmitter 'error' throws and kills the whole test process.
		client.on('error', (err: any) => finish('refused', String(err?.code ?? err?.message ?? err)));
		client.once('close', () => finish('refused', 'socket closed before connect/error'));
		const wedgeTimer = setTimeout(() => {
			finish(
				'wedged',
				`neither connect/error/close within ${WALL_CLOCK_MS}ms (mqtt.js connectTimeout=${MQTT_JS_CONNECT_TIMEOUT_MS}ms did not fire either)`
			);
		}, WALL_CLOCK_MS);
	});
}

/** Bounded: a client on a genuinely wedged socket may never invoke end()'s own callback, which
 * would otherwise hang every caller (including the whole suite, via the baseline probe) on
 * exactly the defect class this file exists to catch instead of reporting it. */
function endQuiet(client: MqttClient | undefined, timeoutMs = 2000): Promise<void> {
	return new Promise((resolveEnd) => {
		if (!client) return resolveEnd();
		let done = false;
		const finish = () => {
			if (done) return;
			done = true;
			resolveEnd();
		};
		const timer = setTimeout(finish, timeoutMs);
		try {
			client.end(true, {}, () => {
				clearTimeout(timer);
				finish();
			});
		} catch {
			clearTimeout(timer);
			finish();
		}
	});
}

suite('QA-649 MQTT connect wedge across an HTTP-worker restart', { skip: skipSuite }, (ctx: ContextWithHarper) => {
	before(async () => {
		await setupHarperWithFixture(ctx, FIXTURE_PATH, {
			config: {
				threads: { count: WORKERS },
				logging: { level: 'trace' },
			},
			env: {},
		});

		// Poll the probe route directly for non-404 — deliberately NOT restartHttpWorkers() (fire-
		// and-forget; would race the readiness wait against the same class of bug under test).
		const deadline = Date.now() + 120_000;
		let ready = false;
		while (Date.now() < deadline) {
			try {
				const res = await fetch(`${ctx.harper.httpURL}/Probe/`, {
					headers: {
						Authorization: `Basic ${Buffer.from(`${ctx.harper.admin.username}:${ctx.harper.admin.password}`).toString('base64')}`,
					},
					signal: AbortSignal.timeout(2000),
				});
				if (res.status !== 404) {
					ready = true;
					break;
				}
			} catch {
				/* not ready yet */
			}
			await sleep(150);
		}
		ok(ready, 'Probe route never left 404 within 120s -- fixture did not mount, not an MQTT problem');
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	function authHeader() {
		return `Basic ${Buffer.from(`${ctx.harper.admin.username}:${ctx.harper.admin.password}`).toString('base64')}`;
	}

	async function opsCall(body: unknown, timeoutMs = 5000) {
		try {
			const res = await fetch(ctx.harper.operationsAPIURL, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', 'Authorization': authHeader(), 'Connection': 'close' },
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
			return { status: res.status, body: json };
		} catch (err: any) {
			return { status: -1, body: undefined, errCode: String(err?.cause?.code ?? err?.code ?? err?.message) };
		}
	}

	/** HTTP worker thread ids as the operations API reports them (the repo idiom for observing a
	 * rotation -- server/rolling-restart.test.ts uses the same `threads` attribute). Job threads
	 * are excluded: `restart_service` itself runs in one, and they never rotate with the pool. */
	async function httpWorkerThreadIds(): Promise<number[]> {
		const r = await opsCall({ operation: 'system_information', attributes: ['threads'] });
		const threads = (r.body as any)?.threads;
		if (!Array.isArray(threads)) return [];
		return threads.filter((w: any) => w?.name !== 'job' && typeof w?.threadId === 'number').map((w: any) => w.threadId);
	}

	// Where `logging.root` actually points depends on how the file was launched, so try both in
	// priority order rather than assume one. Under harper-integration-test-run (every documented
	// command) the runner sets HARPER_INTEGRATION_TEST_LOG_DIR itself when the caller hasn't, and
	// the harness then overrides logging.root with its per-suite logDir -- so only the first
	// candidate exists. Under a bare `node --test` nothing sets it and only the second does.
	// Neighbouring suites read the same union (database/blob-restart-ttl-unlink.test.ts). The
	// child process's captured stdout is not a substitute: it does not carry the per-thread trace
	// lines this oracle counts.
	function readServerLog(): string {
		const candidates = [join(ctx.harper.dataRootDir, 'log', 'hdb.log')];
		if (ctx.harper.logDir) candidates.unshift(join(ctx.harper.logDir, 'hdb.log'));
		for (const candidate of candidates) {
			try {
				const text = readFileSync(candidate, 'utf8');
				if (text) return text;
			} catch {
				/* try the next candidate */
			}
		}
		return '';
	}

	/** Waits minWaitMs, then polls until the log stops growing for one quiet interval (bounded) --
	 * a condition-wait on the file transport actually flushing, not a fixed guess at how long. */
	async function readServerLogStable(minWaitMs: number, quietMs = 250, maxExtraMs = 3000): Promise<string> {
		await sleep(minWaitMs);
		let text = readServerLog();
		const deadline = Date.now() + maxExtraMs;
		while (Date.now() < deadline) {
			await sleep(quietMs);
			const next = readServerLog();
			if (next.length === text.length) return next;
			text = next;
		}
		return text;
	}

	function countMatches(text: string, re: RegExp): number {
		return (text.match(re) || []).length;
	}

	test(
		'MQTT connect storm (WS /mqtt, raw TCP :1883, TLS :8883) across restart_service http_workers',
		{ timeout: 240_000 },
		async (t) => {
			const wsBase = ctx.harper.httpURL.replace(/^http/, 'ws');
			const surfaces: Array<{ surface: 'ws' | 'tcp' | 'tls'; url: string; intervalMs: number }> = [
				{ surface: 'ws', url: `${wsBase}/mqtt`, intervalMs: 50 },
				{ surface: 'tcp', url: `mqtt://${ctx.harper.hostname}:1883`, intervalMs: 100 },
				{ surface: 'tls', url: `mqtts://${ctx.harper.hostname}:8883`, intervalMs: 200 },
			];

			// --- Baseline usability probe per surface. Every surface is REQUIRED. Treating an
			// unusable surface as "skip it" would make the anchor silently self-narrowing: the
			// regression class this file falsifies includes "the TCP/TLS listener stops coming
			// back", and that regression presents at the probe -- as a skip, not a failure. Only
			// whole-runtime limitations get to skip, and those are `skipSuite` above. Retried to a
			// deadline so a listener that is merely slow to bind is waited out instead. ---
			const PROBE_DEADLINE_MS = 30_000;
			const probeAttempts: Record<string, number> = { ws: 0, tcp: 0, tls: 0 };
			const usable = new Map<string, boolean>();
			const probeFailure = new Map<string, string>();
			for (const s of surfaces) {
				const deadline = Date.now() + PROBE_DEADLINE_MS;
				do {
					const n = ++probeAttempts[s.surface];
					const r = await attemptConnect(s.url, authOpts(ctx, `qa649-probe-${s.surface}-${n}`));
					usable.set(s.surface, r.kind === 'completed');
					if (r.kind !== 'completed') probeFailure.set(s.surface, `${r.kind}: ${r.detail}`);
					await endQuiet(r.client);
					if (usable.get(s.surface)) break;
					await sleep(500);
				} while (Date.now() < deadline);
			}
			for (const s of surfaces) {
				console.log(
					`[QA-649] baseline probe ${s.surface} (${s.url}): usable=${usable.get(s.surface)} ` +
						`attempts=${probeAttempts[s.surface]} ${probeFailure.get(s.surface) ?? ''}`
				);
			}
			for (const s of surfaces) {
				ok(
					usable.get(s.surface),
					`${s.surface} surface (${s.url}) never became usable within ${PROBE_DEADLINE_MS}ms over ${probeAttempts[s.surface]} attempt(s) -- last: ${probeFailure.get(s.surface)}`
				);
			}

			const results: AttemptResult[] = [];
			const lateSelfHeals: Array<{ surface: string; seq: number; wedgedAt: number; lateConnectAt: number }> = [];
			const lateWatchCount: Record<string, number> = { ws: 0, tcp: 0, tls: 0 };
			let stormOver = false;
			// Every await in the body below is deadline-bounded, so the `finally` that sets
			// stormOver is always reached and the storms do terminate on their own. What they do
			// NOT do is stop *promptly*: node:test cannot interrupt a running async function, so
			// after a runner timeout it proceeds to `after`/teardownHarper while this body keeps
			// firing connects for up to another WALL_CLOCK_MS at 50/100/200ms. t.signal aborts on
			// timeout as well as on normal completion, which cuts that overlap.
			t.signal.addEventListener('abort', () => {
				stormOver = true;
			});

			async function runStorm(surface: 'ws' | 'tcp' | 'tls', url: string, intervalMs: number) {
				let seq = 0;
				const pending: Array<Promise<void>> = [];
				while (!stormOver) {
					const mySeq = seq++;
					const launchedAt = Date.now();
					const clientId = `qa649-${surface}-${mySeq}-${randomUUID().slice(0, 6)}`;
					const p = attemptConnect(url, authOpts(ctx, clientId)).then((r) => {
						const rec: AttemptResult = { surface, seq: mySeq, launchedAt, ...r };
						results.push(rec);
						if (r.kind === 'completed') {
							void endQuiet(r.client);
						} else if (r.kind === 'wedged' && lateWatchCount[surface] < LATE_WATCH_CAP) {
							lateWatchCount[surface]++;
							const onLateConnect = () => {
								lateSelfHeals.push({ surface, seq: mySeq, wedgedAt: r.tEnd, lateConnectAt: Date.now() });
							};
							r.client.once('connect', onLateConnect);
							setTimeout(() => {
								r.client.removeListener('connect', onLateConnect);
								void endQuiet(r.client);
							}, LATE_GRACE_MS).unref();
						} else {
							void endQuiet(r.client);
						}
					});
					// attemptConnect never rejects, and this handler never throws -- but `p` sits
					// unawaited in `pending` for the rest of the storm, so any future violation of
					// that contract would otherwise crash the whole process on the next tick as an
					// unhandled rejection instead of failing just this test.
					p.catch(() => {});
					pending.push(p);
					await sleep(intervalMs);
				}
				await Promise.all(pending);
			}

			const stormPromises = surfaces.map((s) => runStorm(s.surface, s.url, s.intervalMs));

			let tBeforeRestart = 0;
			let tJobComplete: number | undefined;
			let finalJob: any;
			try {
				await sleep(WARMUP_MS);
				ok(results.length > 0, 'connect storm produced no attempts during warm-up -- harness problem');

				// Rotation proof, half 1. `threads.count` not applying would leave a single worker,
				// making "rotate them all" degenerate while every assertion below still passes --
				// the same vacuity guard integrationTests/server/rolling-restart.test.ts makes.
				const workersBefore = await httpWorkerThreadIds();
				ok(
					workersBefore.length >= 2,
					`expected >= 2 HTTP worker threads before the restart (threads.count=${WORKERS}), observed ${workersBefore.length} [${workersBefore}] -- a single-worker rotation is vacuous`
				);

				tBeforeRestart = Date.now();
				const restartResp = await opsCall({ operation: 'restart_service', service: 'http_workers' }, 30_000);
				const tAfterRestartResp = Date.now();
				strictEqual(
					restartResp.status,
					200,
					`restart_service should ack 200: ${restartResp.status} ${JSON.stringify(restartResp.body)}`
				);
				const jobId = (restartResp.body as any)?.job_id;
				ok(jobId, `restart_service response carried no job_id: ${JSON.stringify(restartResp.body)}`);
				console.log(`[QA-649] restart_service acked 200 in ${tAfterRestartResp - tBeforeRestart}ms, job_id=${jobId}`);

				// --- Poll get_job to a terminal state (the real completion signal per QA-642) ---
				const deadline = Date.now() + 60_000;
				let lastPoll: { status: number; body: any; errCode?: string } | undefined;
				while (Date.now() < deadline) {
					const r = await opsCall({ operation: 'get_job', id: jobId }, 3000);
					lastPoll = r;
					const job = Array.isArray(r.body) ? r.body[0] : undefined;
					if (job?.status === 'COMPLETE' || job?.status === 'ERROR') {
						tJobComplete = Date.now();
						finalJob = job;
						break;
					}
					await sleep(20);
				}
				ok(
					tJobComplete,
					`get_job(${jobId}) never reached a terminal status within 60s -- last poll: ${JSON.stringify(lastPoll)}`
				);
				strictEqual(
					finalJob.status,
					'COMPLETE',
					`restart job ended in ${finalJob.status}: ${JSON.stringify(finalJob)}`
				);
				console.log(`[QA-649] get_job(${jobId}) COMPLETE at t+${tJobComplete! - tBeforeRestart}ms`);

				// Rotation proof, half 2. get_job COMPLETE is a *documented* completion signal, not
				// evidence that anything moved: a restart_service that regressed to a no-op would
				// still report COMPLETE, and then every assertion below passes on a window that was
				// never opened -- pre-restart connects complete, in-window connects complete,
				// wedged=0. Worker identity is the evidence. QA-642 established that COMPLETE
				// correlates with the pool having FULLY rotated, so a survivor is a real finding
				// about that signal, not a tolerance to widen.
				const workersAfter = await httpWorkerThreadIds();
				console.log(
					`[QA-649] http worker threadIds ${JSON.stringify(workersBefore)} -> ${JSON.stringify(workersAfter)}`
				);
				ok(
					workersAfter.length >= 2,
					`expected >= 2 HTTP worker threads after the restart, observed ${workersAfter.length} [${workersAfter}]`
				);
				const survivors = workersAfter.filter((id) => workersBefore.includes(id));
				strictEqual(
					survivors.length,
					0,
					`restart_service http_workers reported COMPLETE but thread(s) [${survivors}] of [${workersBefore}] never rotated -- the restart window this test measures was not fully opened`
				);

				// --- Tail: keep storming past COMPLETE, to see whether the window truly closes.
				// TAIL_MS is a floor (so the post-COMPLETE sample is never degenerate), then a
				// condition-wait for each surface to actually complete a fresh connect. A fixed
				// sleep followed by asserting the side effect is the `await delay(N);
				// assert(sideEffectHappened)` shape AGENTS.md names as flake class #1138: a
				// listener that re-registers a second later than the tail would red the run.
				// assertUsableAfterRestart below still asserts it -- reaching this deadline means
				// the surface genuinely never came back. ---
				await sleep(TAIL_MS);
				const recoveredAfterRestart = (surface: string) =>
					results.some((r) => r.surface === surface && r.kind === 'completed' && r.launchedAt >= tJobComplete!);
				const tailDeadline = Date.now() + POST_RESTART_RECOVERY_MS;
				while (Date.now() < tailDeadline && !surfaces.every((s) => recoveredAfterRestart(s.surface))) {
					await sleep(100);
				}
			} finally {
				// Stop the storm loops no matter what -- if an assertion above throws (e.g. a
				// regressed restart_service), leaving them running would fire qa649-* connects
				// every 50/100/200ms past teardownHarper and hang the whole integration shard
				// instead of just failing this test.
				stormOver = true;
				await Promise.all(stormPromises).catch(() => {});
			}

			// Promise.all(stormPromises) above already waited for every launched attempt to be
			// CLASSIFIED (up to WALL_CLOCK_MS after launch); only the LATE_GRACE_MS late-connect
			// watch that starts once a 'wedged' result lands is still outstanding. Then poll the
			// log file until it stops growing, rather than guess a fixed extra wait for the file
			// transport to flush.
			const serverLog = await readServerLogStable(LATE_GRACE_MS + 500);

			// ================= ANALYSIS =================

			function analyzeSurface(surface: 'ws' | 'tcp' | 'tls') {
				const rs = results.filter((r) => r.surface === surface);
				if (rs.length === 0) return null;
				const completed = rs.filter((r) => r.kind === 'completed');
				const refused = rs.filter((r) => r.kind === 'refused');
				const wedged = rs.filter((r) => r.kind === 'wedged');
				const preRestart = rs.filter((r) => r.launchedAt < tBeforeRestart);
				const inWindow = rs.filter((r) => r.launchedAt >= tBeforeRestart && r.launchedAt < tJobComplete!);
				const postComplete = rs.filter((r) => r.launchedAt >= tJobComplete!);
				const wedgedInWindow = inWindow.filter((r) => r.kind === 'wedged');
				const wedgedPostComplete = postComplete.filter((r) => r.kind === 'wedged');
				const windowStart = wedged.length ? Math.min(...wedged.map((r) => r.launchedAt)) - tBeforeRestart : null;
				const windowEnd = wedged.length ? Math.max(...wedged.map((r) => r.launchedAt)) - tBeforeRestart : null;

				console.log(
					`\n[QA-649][${surface}] total=${rs.length} completed=${completed.length} refused=${refused.length} wedged=${wedged.length}\n` +
						`  pre-restart: ${preRestart.length} attempts, ${preRestart.filter((r) => r.kind === 'completed').length} completed\n` +
						`  during-window [restart-trigger, job-COMPLETE): ${inWindow.length} attempts, wedged=${wedgedInWindow.length}, refused=${inWindow.filter((r) => r.kind === 'refused').length}, completed=${inWindow.filter((r) => r.kind === 'completed').length}\n` +
						`  post-COMPLETE: ${postComplete.length} attempts, wedged=${wedgedPostComplete.length}, refused=${postComplete.filter((r) => r.kind === 'refused').length}, completed=${postComplete.filter((r) => r.kind === 'completed').length}\n` +
						`  wedge window (relative to restart trigger, by launch time): ${windowStart}ms .. ${windowEnd}ms`
				);

				return {
					rs,
					completed,
					refused,
					wedged,
					preRestart,
					inWindow,
					postComplete,
					wedgedInWindow,
					wedgedPostComplete,
				};
			}

			const wsA = analyzeSurface('ws');
			const tcpA = analyzeSurface('tcp');
			const tlsA = analyzeSurface('tls');
			ok(wsA && tcpA && tlsA, 'a required surface produced no attempts at all -- harness problem, not an MQTT result');

			// Server-side cross-check: count of transport-accepted lines vs client-completed count.
			const wsAcceptedLines = countMatches(serverLog, /Received WebSocket connection for MQTT from/g);
			const tcpAcceptedLines = countMatches(serverLog, /Received TCP connection for MQTT from/g);
			const sslAcceptedLines = countMatches(serverLog, /Received SSL connection for MQTT from/g);
			const closedLines = countMatches(serverLog, /MQTT connection was closed/g);
			console.log(
				`\n[QA-649] SERVER LOG cross-check: WS-accepted-lines=${wsAcceptedLines} (vs ${wsA!.completed.length} client-completed), ` +
					`TCP-accepted-lines=${tcpAcceptedLines}, SSL-accepted-lines=${sslAcceptedLines}, "MQTT connection was closed"-lines=${closedLines}`
			);
			ok(
				wsAcceptedLines > 0,
				'server log never recorded a single "Received WebSocket connection for MQTT from" line -- logging/harness problem, cannot evaluate the transport-accepted-but-never-completed hypothesis'
			);

			console.log(
				`\n[QA-649] SELF-HEAL: ${lateSelfHeals.length} of the ${Object.values(lateWatchCount).reduce((a, b) => a + b, 0)} tracked wedged client(s) ` +
					`fired a late 'connect' within the ${LATE_GRACE_MS}ms post-classification grace window. ` +
					`${lateSelfHeals.length ? JSON.stringify(lateSelfHeals) : '(none observed within our bounded observation window -- this does NOT prove they never connect, only that they did not within our grace period)'}`
			);

			// ================= VERDICT =================
			// Pre-restart traffic must actually have been live (sanity, not the hypothesis under test).
			ok(
				wsA!.preRestart.some((r) => r.kind === 'completed'),
				'no successful WS connects observed before the restart -- stream was not live, test invalid'
			);

			// Precondition proof, per surface: attempts must actually have landed strictly inside
			// the restart window, not just before/after it -- otherwise a degenerate window (e.g.
			// get_job completing on its very first poll, or a cadence too coarse to fit inside it)
			// would make that surface's wedge check below vacuous while it still reported green.
			for (const [surface, a] of [
				['WS', wsA!],
				['TCP', tcpA!],
				['TLS', tlsA!],
			] as const) {
				ok(
					a.inWindow.length > 0,
					`no ${surface} connect attempts landed inside the restart window [trigger, COMPLETE) -- window was ${tJobComplete! - tBeforeRestart}ms, nothing to test on this surface`
				);
			}

			// Q3: does polling get_job to COMPLETE close the window entirely? Evidence: any wedged
			// WS attempt LAUNCHED AT/AFTER tJobComplete would mean the window survives past the
			// documented completion signal.
			console.log(
				`\n[QA-649] Q3 (does get_job COMPLETE close the window?): ${wsA!.wedgedPostComplete.length} wedged WS attempt(s) launched at/after get_job COMPLETE ` +
					(wsA!.wedgedPostComplete.length === 0
						? '-- window appears CLOSED by the time get_job reports COMPLETE.'
						: '-- DEFECT-ADJACENT: the window OUTLIVES the documented completion signal.')
			);

			// A zero client-side wedge count is not by itself proof MQTT survived the restart -- a
			// listener that never re-registers after the rotation would refuse every post-restart
			// attempt (ECONNRESET, classified 'refused') and still show wedged=0. Require at least
			// one real post-restart completion per usable surface.
			function assertUsableAfterRestart(surface: string, a: NonNullable<ReturnType<typeof analyzeSurface>>) {
				ok(
					a.postComplete.some((r) => r.kind === 'completed'),
					`MQTT (${surface}) never completed a single connect after get_job COMPLETE -- listener may not have survived the restart`
				);
			}
			assertUsableAfterRestart('WS', wsA!);
			assertUsableAfterRestart('TCP', tcpA!);
			assertUsableAfterRestart('TLS', tlsA!);

			// Primary hypothesis: an MQTT connect on any usable transport must never wedge (neither
			// complete nor cleanly refuse) within our bounded observation window.
			function assertNoWedge(surface: string, a: NonNullable<ReturnType<typeof analyzeSurface>>) {
				ok(
					a.wedged.length === 0,
					`WEDGE DEFECT (${surface}): ${a.wedged.length} of ${a.rs.length} connect attempt(s) neither completed nor errored within ${WALL_CLOCK_MS}ms ` +
						`(mqtt.js connectTimeout=${MQTT_JS_CONNECT_TIMEOUT_MS}ms also did not fire) -- samples: ${JSON.stringify(a.wedged.slice(0, 5).map((r) => ({ seq: r.seq, launchRelMs: r.launchedAt - tBeforeRestart, detail: r.detail })))}`
				);
			}
			assertNoWedge('WS', wsA!);
			assertNoWedge('TCP', tcpA!);
			assertNoWedge('TLS', tlsA!);

			// Two-sided oracle, enforced last: `assertNoWedge` above already independently pins
			// the client-observed wedge count to zero with the most specific diagnostic, so a real
			// wedge fails there first rather than surfacing here as a less informative accept
			// mismatch.
			//
			// The bound is closed at BOTH ends, because each end fails a different way:
			//   upper -- the server accepted a transport the client never accounted for at all.
			//     `refused` counts as accounted-for deliberately: the server logs "accepted" the
			//     instant the transport upgrade lands, several ms before CONNACK, so a worker torn
			//     down inside that gap during the rolling restart is a legitimate
			//     accepted-then-reset the client correctly classifies `refused`, not a wedge.
			//   lower -- the trace is not actually being read. Every completed connect necessarily
			//     crossed the accept-log site, so `acceptedLines` below the completed count means
			//     the server half of the oracle is silently disabled (a wording change in
			//     server/mqtt.ts, a truncated log) and the upper bound alone would still pass, at
			//     its most permissive, on zero evidence.
			// Both ends allow for the baseline probe attempts, which trigger accept lines but are
			// deliberately excluded from `results`: every attempt may have been accepted (upper),
			// and exactly one of them completed (lower).
			function assertServerAccepts(
				surface: string,
				acceptedLines: number,
				probes: number,
				a: NonNullable<ReturnType<typeof analyzeSurface>>
			) {
				ok(
					acceptedLines >= a.completed.length + 1,
					`SERVER-SIDE TRACE MISSING (${surface}): only ${acceptedLines} accepted-transport log line(s) for ${a.completed.length} client-completed connect(s) + 1 completed baseline probe. Every completed connect crosses the accept-log site, so this oracle is not reading it -- the server/mqtt.ts log wording changed, or the log was truncated mid-run`
				);
				ok(
					acceptedLines <= a.completed.length + a.refused.length + probes,
					`SERVER-SIDE ACCEPT MISMATCH (${surface}): server log recorded ${acceptedLines} accepted transports vs at most ${a.completed.length + a.refused.length + probes} client-accounted-for (completed ${a.completed.length} + refused ${a.refused.length} + ${probes} baseline probe attempt(s))`
				);
			}
			assertServerAccepts('WS', wsAcceptedLines, probeAttempts.ws, wsA!);
			assertServerAccepts('TCP', tcpAcceptedLines, probeAttempts.tcp, tcpA!);
			assertServerAccepts('TLS', sslAcceptedLines, probeAttempts.tls, tlsA!);
		}
	);
});
