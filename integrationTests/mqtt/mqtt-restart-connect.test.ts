/**
 * QA-649 — does an MQTT connect wedge (neither complete nor error) across an HTTP-worker
 * restart, as seen in a prior cluster experiment where `mqtt.connect()` over the WebSocket
 * `/mqtt` endpoint, fired right after `restart_service {service:'http_workers'}`, sat forever
 * (600s+) with no `connectTimeout` firing and no further connection attempts in the log?
 *
 * Background established by QA-642 (integrationTests/apiTests/restart-service-contract.test.ts):
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
 *   - server side: {dataRootDir}/log/hdb.log at logging.level 'trace' — server/mqtt.ts logs
 *     `Received WebSocket connection for MQTT from` / `Received TCP connection for MQTT from` /
 *     `Received SSL connection for MQTT from` at the moment the TRANSPORT (WS upgrade / raw
 *     socket) is accepted, BEFORE the MQTT CONNECT packet is even parsed. If the count of these
 *     "accepted" log lines during the restart window exceeds the count of client-side 'completed'
 *     outcomes for the same surface/window, that is server-side proof some connections were
 *     accepted at the transport level but never finished the MQTT handshake — the wedge shape
 *     described in the scenario, not a client-side illusion (a past QA finding was retracted for
 *     exactly this kind of one-sided evidence).
 *
 * Run:
 *   npm run test:integration -- "integrationTests/mqtt/mqtt-restart-connect.test.ts"
 */
import { suite, test, before, after } from 'node:test';
import { ok, strictEqual } from 'node:assert';
import { resolve, join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';

import mqtt, { type IClientOptions, type MqttClient } from 'mqtt';

import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';

const FIXTURE_PATH = resolve(import.meta.dirname, 'mqtt-restart-connect');
const WORKERS = 4; // need >1 for a real "rotate them all" restart, matching QA-642's rationale

const skipSuite = process.platform === 'win32';

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
	const launchedAt = Date.now();
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
		client.once('error', (err: any) => finish('refused', String(err?.code ?? err?.message ?? err)));
		client.once('close', () => finish('refused', 'socket closed before connect/error'));
		const wedgeTimer = setTimeout(() => {
			finish(
				'wedged',
				`neither connect/error/close within ${WALL_CLOCK_MS}ms (mqtt.js connectTimeout=${MQTT_JS_CONNECT_TIMEOUT_MS}ms did not fire either)`
			);
		}, WALL_CLOCK_MS);
		void launchedAt;
	});
}

function endQuiet(client: MqttClient | undefined): Promise<void> {
	return new Promise((resolveEnd) => {
		if (!client) return resolveEnd();
		try {
			client.end(true, {}, () => resolveEnd());
		} catch {
			resolveEnd();
		}
	});
}

suite('QA-649 MQTT connect wedge across an HTTP-worker restart', { skip: skipSuite }, (ctx: ContextWithHarper) => {
	let procOutput = '';

	before(async () => {
		await setupHarperWithFixture(ctx, FIXTURE_PATH, {
			config: {
				threads: { count: WORKERS },
				logging: { root: 'log', level: 'trace', console: true },
			},
			env: {},
		});

		procOutput += ctx.harper.startupOutput?.stdout ?? '';
		procOutput += ctx.harper.startupOutput?.stderr ?? '';
		const proc = ctx.harper.process;
		proc?.stdout?.on('data', (d: Buffer) => (procOutput += d.toString()));
		proc?.stderr?.on('data', (d: Buffer) => (procOutput += d.toString()));

		// Poll the probe route directly for non-404 — deliberately NOT restartHttpWorkers() (fire-
		// and-forget; would race the readiness wait against the same class of bug under test).
		const deadline = Date.now() + 120_000;
		while (Date.now() < deadline) {
			try {
				const res = await fetch(`${ctx.harper.httpURL}/Probe/`, {
					headers: {
						Authorization: `Basic ${Buffer.from(`${ctx.harper.admin.username}:${ctx.harper.admin.password}`).toString('base64')}`,
					},
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

	function readServerLog(): string {
		let text = procOutput;
		const p = join(ctx.harper.dataRootDir, 'log', 'hdb.log');
		if (existsSync(p)) {
			try {
				text += readFileSync(p, 'utf8');
			} catch {
				/* ignore */
			}
		}
		const logDir = (ctx.harper as any).logDir as string | undefined;
		if (logDir) {
			for (const name of ['hdb.log', 'stdout.log', 'stderr.log']) {
				const p2 = join(logDir, name);
				if (existsSync(p2)) {
					try {
						text += readFileSync(p2, 'utf8');
					} catch {
						/* ignore */
					}
				}
			}
		}
		return text;
	}

	function countMatches(text: string, re: RegExp): number {
		return (text.match(re) || []).length;
	}

	test(
		'MQTT connect storm (WS /mqtt, raw TCP :1883, TLS :8883) across restart_service http_workers',
		{ timeout: 240_000 },
		async () => {
			const wsBase = ctx.harper.httpURL.replace(/^http/, 'ws');
			const surfaces: Array<{ surface: 'ws' | 'tcp' | 'tls'; url: string; intervalMs: number }> = [
				{ surface: 'ws', url: `${wsBase}/mqtt`, intervalMs: 50 },
				{ surface: 'tcp', url: `mqtt://${ctx.harper.hostname}:1883`, intervalMs: 100 },
				{ surface: 'tls', url: `mqtts://${ctx.harper.hostname}:8883`, intervalMs: 200 },
			];

			// --- Baseline usability probe per surface (bounded; skip a surface if unusable rather
			// than treat harness/environment limitations as a Harper defect). ---
			const usable = new Map<string, boolean>();
			const skipReason = new Map<string, string>();
			for (const s of surfaces) {
				const r = await attemptConnect(s.url, authOpts(ctx, `qa649-probe-${s.surface}`));
				usable.set(s.surface, r.kind === 'completed');
				if (r.kind !== 'completed') skipReason.set(s.surface, `${r.kind}: ${r.detail}`);
				await endQuiet(r.client);
			}
			for (const s of surfaces) {
				console.log(
					`[QA-649] baseline probe ${s.surface} (${s.url}): usable=${usable.get(s.surface)} ${skipReason.get(s.surface) ?? ''}`
				);
			}
			ok(
				usable.get('ws'),
				`WS /mqtt surface must be usable at baseline for this experiment to be meaningful: ${skipReason.get('ws')}`
			);

			// --- Storm driver: fire connects on a fixed cadence per surface until stormOver ---
			const results: AttemptResult[] = [];
			const lateSelfHeals: Array<{ surface: string; seq: number; wedgedAt: number; lateConnectAt: number }> = [];
			const lateWatchCount: Record<string, number> = { ws: 0, tcp: 0, tls: 0 };
			let stormOver = false;

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
							}, LATE_GRACE_MS);
						} else {
							void endQuiet(r.client);
						}
					});
					pending.push(p);
					await sleep(intervalMs);
				}
				await Promise.all(pending);
			}

			const stormPromises: Array<Promise<void>> = [];
			for (const s of surfaces) {
				if (usable.get(s.surface)) stormPromises.push(runStorm(s.surface, s.url, s.intervalMs));
				else console.log(`[QA-649] skipping storm for surface '${s.surface}': ${skipReason.get(s.surface)}`);
			}

			// --- Warm-up: confirm live traffic before touching anything ---
			await sleep(WARMUP_MS);
			ok(results.length > 0, 'connect storm produced no attempts during warm-up -- harness problem');

			// --- Trigger restart_service http_workers, capture job_id ---
			const tBeforeRestart = Date.now();
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
			let tJobComplete: number | undefined;
			let finalJob: any;
			{
				const deadline = Date.now() + 60_000;
				while (Date.now() < deadline) {
					const r = await opsCall({ operation: 'get_job', id: jobId }, 3000);
					const job = Array.isArray(r.body) ? r.body[0] : undefined;
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
			console.log(`[QA-649] get_job(${jobId}) COMPLETE at t+${tJobComplete! - tBeforeRestart}ms`);

			// --- Tail: keep storming a bit past COMPLETE, to see whether the window truly closes ---
			await sleep(TAIL_MS);
			stormOver = true;
			await Promise.all(stormPromises);

			// Give any attempts launched right at the tail edge (up to WALL_CLOCK_MS + LATE_GRACE_MS
			// to fully classify/self-heal-observe) time to finish before we analyze.
			await sleep(WALL_CLOCK_MS + LATE_GRACE_MS + 500);

			// ================= ANALYSIS =================
			const serverLog = readServerLog();

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
			const tcpA = usable.get('tcp') ? analyzeSurface('tcp') : null;
			const tlsA = usable.get('tls') ? analyzeSurface('tls') : null;

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

			// Q3: does polling get_job to COMPLETE close the window entirely? Evidence: any wedged
			// WS attempt LAUNCHED AT/AFTER tJobComplete would mean the window survives past the
			// documented completion signal.
			console.log(
				`\n[QA-649] Q3 (does get_job COMPLETE close the window?): ${wsA!.wedgedPostComplete.length} wedged WS attempt(s) launched at/after get_job COMPLETE ` +
					(wsA!.wedgedPostComplete.length === 0
						? '-- window appears CLOSED by the time get_job reports COMPLETE.'
						: '-- DEFECT-ADJACENT: the window OUTLIVES the documented completion signal.')
			);

			// Primary hypothesis: a WS /mqtt connect must never wedge (neither complete nor cleanly
			// refuse) within our bounded observation window. Contrast surfaces are informational.
			ok(
				wsA!.wedged.length === 0,
				`WEDGE DEFECT: ${wsA!.wedged.length} of ${wsA!.rs.length} WS /mqtt connect attempt(s) neither completed nor errored within ${WALL_CLOCK_MS}ms ` +
					`(mqtt.js connectTimeout=${MQTT_JS_CONNECT_TIMEOUT_MS}ms also did not fire) -- samples: ${JSON.stringify(wsA!.wedged.slice(0, 5).map((r) => ({ seq: r.seq, launchRelMs: r.launchedAt - tBeforeRestart, detail: r.detail })))}`
			);

			if (tcpA) console.log(`[QA-649] contrast: raw TCP :1883 wedged=${tcpA.wedged.length}/${tcpA.rs.length}`);
			if (tlsA) console.log(`[QA-649] contrast: TLS :8883 wedged=${tlsA.wedged.length}/${tlsA.rs.length}`);
		}
	);
});
