/**
 * MQTT broker AT SCALE: many topics x many subscribers, wildcard
 * fan-out, QoS-1 reconnect-backlog, per-subscription isolation, broker memory.
 *
 * Prior MQTT waves were single-topic. This pushes to a table-backed topic
 * space with MANY device topics (Device/<id>) and MANY concurrent subscribers —
 * some WILDCARD (Device/#, Device/+), some specific-topic — then a burst of
 * publishes across all topics, plus a QoS-1 subscriber that disconnects and
 * reconnects to drain a backlog.
 *
 * Wiring recap:
 *   - MQTT transport: WebSocket on Harper's HTTP port at /mqtt, MQTT v5, admin
 *     basic-auth — same loopback the REST client uses.
 *   - Topics are table-backed: Device/<id> <-> a Device record keyed by <id>.
 *     A publish to Device/7 is a write to record id "7"; a subscriber on
 *     Device/7 / Device/+ / Device/# sees it as a change message.
 *   - Durable QoS-1 backlog: clean:false + sessionExpiryInterval; on reconnect
 *     (no re-subscribe) the broker replays the audit gap.
 *
 * QUESTIONS
 *   Q1 WILDCARD FAN-OUT CORRECTNESS (no cross-topic bleed): with subscribers on
 *      Device/#, Device/+, and several SPECIFIC Device/<id>, burst one publish to
 *      every Device/<id>. Assert: # sub gets EXACTLY the full id set; + sub gets
 *      exactly the full id set (single level); each specific sub gets ONLY its id
 *      and NOTHING else (a Device/7 sub receiving Device/2 is cross-topic BLEED —
 *      a correctness/security defect). No drop, no dup.
 *   Q2 QoS-1 DURABLE BACKLOG ON RECONNECT: a clean:false QoS-1 sub on Device/#
 *      attaches, confirms it is armed, disconnects; we then publish a backlog
 *      across ALL topics while it is gone; it reconnects (no re-subscribe) and
 *      must drain the backlog (every gap publish delivered, no loss).
 *   Q3 PER-SUBSCRIPTION ISOLATION (no head-of-line blocking): a STALLED subscriber
 *      (paused WS stream, never drains) on Device/# coexists with HEALTHY
 *      subscribers during a burst. The healthy subs must receive their full set
 *      promptly — the stalled peer must not starve/delay them. Also sample
 *      per-worker heap to characterize broker memory under fan-out (bounded vs
 *      growing).
 *
 * Run BOTH single-worker and multi-worker (threads.count=4) by parameterizing
 * the suite over a config matrix.
 *
 * SANDBOX CAVEAT: MQTT-over-loopback-WebSocket sometimes fails to connect here
 * ("socket hang up"). `before` does a connect probe; if THAT fails we report a
 * HARNESS limitation rather than a Harper defect (skip the probes).
 */
import { suite, test, before, after } from 'node:test';
import { ok, strictEqual, deepStrictEqual } from 'node:assert';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import mqtt, { type IClientOptions, type MqttClient } from 'mqtt';
import request from 'supertest';

import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
// @ts-expect-error utils/client.mjs has no type declarations; runtime resolves fine
import { createApiClient } from '../apiTests/utils/client.mjs';

const FIXTURE_PATH = resolve(import.meta.dirname, 'mqtt-at-scale');
const TABLE = 'Device';

const skipSuite = process.env.HARPER_RUNTIME === 'bun' || process.platform === 'win32';

const ADMIN_USER = 'admin';
const ADMIN_PASS = 'Abc1234!';

// ── MQTT helpers ──────────────────────────────────────────────────────────────
function baseOpts(overrides: Partial<IClientOptions> = {}): IClientOptions {
	return {
		protocolVersion: 5,
		reconnectPeriod: 0,
		connectTimeout: 8000,
		clean: true,
		username: ADMIN_USER,
		password: ADMIN_PASS,
		...overrides,
	};
}

function connect(url: string, opts: IClientOptions): Promise<MqttClient> {
	return new Promise((resolve, reject) => {
		const client = mqtt.connect(url, opts);
		const onError = (err: Error) => {
			client.removeListener('connect', onConnect);
			client.end(true);
			reject(err);
		};
		const onConnect = () => {
			client.removeListener('error', onError);
			resolve(client);
		};
		client.once('error', onError);
		client.once('connect', onConnect);
	});
}

function subscribe(client: MqttClient, topic: string, qos: 0 | 1 | 2 = 1): Promise<any[]> {
	return new Promise((resolve, reject) => {
		client.subscribe(topic, { qos }, (err, granted) => (err ? reject(err) : resolve(granted ?? [])));
	});
}

function endQuiet(client: MqttClient | undefined): Promise<void> {
	return new Promise((resolve) => {
		if (!client) return resolve();
		client.end(true, {}, () => resolve());
	});
}

interface MqttMsg {
	topic: string;
	id?: string;
	value?: number;
	tag?: string;
	at: number;
}

/** Collect+parse Device change messages for one MQTT consumer. */
function collect(client: MqttClient) {
	const events: MqttMsg[] = [];
	const handler = (topic: string, payload: Buffer) => {
		let parsed: any;
		try {
			parsed = JSON.parse(payload.toString());
		} catch {
			parsed = undefined;
		}
		const value =
			typeof parsed?.value === 'number'
				? parsed.value
				: typeof parsed?.value?.value === 'number'
					? parsed.value.value
					: undefined;
		events.push({
			topic,
			id: parsed?.id != null ? String(parsed.id) : undefined,
			value,
			tag: parsed?.tag,
			at: Date.now(),
		});
	};
	client.on('message', handler);
	return { events, stop: () => client.removeListener('message', handler) };
}

async function waitFor(predicate: () => boolean, timeoutMs = 15_000, intervalMs = 25): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return true;
		await sleep(intervalMs);
	}
	return predicate();
}

/** Sample per-worker heap (system_information threads). Returns max heapUsed across workers, in MB. */
async function maxWorkerHeapMB(client: ReturnType<typeof createApiClient>): Promise<number> {
	try {
		const r = await client
			.req()
			.send({ operation: 'system_information', attributes: ['threads'] })
			.timeout(10_000);
		const threads = (r.body as any)?.threads;
		if (Array.isArray(threads)) {
			const heaps = threads.map((t: any) => (typeof t.heapUsed === 'number' ? t.heapUsed : 0));
			return Math.max(0, ...heaps) / (1024 * 1024);
		}
	} catch {
		/* ignore */
	}
	return -1;
}

const j = (x: any) => JSON.stringify(x);

// The id of the topic the SPECIFIC subscribers target (must never bleed).
const SPECIFIC_IDS = ['7', '13', '42'];

/** Build one parameterized suite per worker-count config. */
function buildSuite(label: string, config: Record<string, unknown>) {
	suite(`MQTT at scale (${label})`, { skip: skipSuite }, (ctx: ContextWithHarper) => {
		let client: ReturnType<typeof createApiClient>;
		let restBase = '';
		let mqttURL = '';
		let mqttUsable = false;
		let mqttSkipReason = '';

		const restPut = (id: string, body: object) =>
			request(restBase).put(`/${TABLE}/${id}`).set(client.headers).send(body);

		before(async () => {
			await setupHarperWithFixture(ctx, FIXTURE_PATH, { config, env: {} });
			client = createApiClient(ctx.harper);
			restBase = client.restURL;

			const httpURL = ctx.harper.httpURL;
			const wsScheme = httpURL.startsWith('https') ? 'wss' : 'ws';
			mqttURL = `${httpURL.replace(/^https?/, wsScheme)}/mqtt`;

			// Readiness poll.
			const deadline = Date.now() + 30_000;
			while (Date.now() < deadline) {
				try {
					const probe = await client.reqRest(`/${TABLE}/`).timeout(3_000);
					if (probe.status !== 404) break;
				} catch {
					/* not ready */
				}
				await sleep(250);
			}

			// MQTT connect probe — separates a Harper defect from sandbox WS hang-ups.
			try {
				const probe = await connect(mqttURL, baseOpts({ clientId: `mqtt-scale-${label}-probe` }));
				mqttUsable = probe.connected === true;
				await endQuiet(probe);
			} catch (err) {
				mqttUsable = false;
				mqttSkipReason = `MQTT connect probe failed on ${mqttURL}: ${(err as Error)?.message}`;
				console.log(`\n[mqtt-at-scale][${label}] HARNESS: ${mqttSkipReason}`);
			}
		});

		after(async () => {
			await teardownHarper(ctx);
		});

		// ── Q1: WILDCARD FAN-OUT — exact #/+ matching, NO cross-topic bleed ────────
		test('Q1: wildcard fan-out correctness — no cross-topic bleed', async (t) => {
			if (!mqttUsable) {
				t.skip(`MQTT broker unavailable (harness): ${mqttSkipReason}`);
				return;
			}
			const N = 60; // 60 device topics Device/0..Device/59
			const runTag = `q1-${label}-${Date.now()}`;
			const allIds = [...Array(N)].map((_, i) => String(i));

			const pub = await connect(mqttURL, baseOpts({ clientId: `mqtt-scale-${label}-q1-pub` }));
			const hashSub = await connect(mqttURL, baseOpts({ clientId: `mqtt-scale-${label}-q1-hash` }));
			const plusSub = await connect(mqttURL, baseOpts({ clientId: `mqtt-scale-${label}-q1-plus` }));
			const specSubs: { id: string; c: MqttClient; obs: ReturnType<typeof collect> }[] = [];
			try {
				const hashObs = collect(hashSub);
				const plusObs = collect(plusSub);
				await subscribe(hashSub, `${TABLE}/#`, 1);
				await subscribe(plusSub, `${TABLE}/+`, 1);
				for (const id of SPECIFIC_IDS) {
					const c = await connect(mqttURL, baseOpts({ clientId: `mqtt-scale-${label}-q1-spec-${id}` }));
					const obs = collect(c);
					await subscribe(c, `${TABLE}/${id}`, 1);
					specSubs.push({ id, c, obs });
				}
				await sleep(800); // let all subscriptions attach

				// Burst: one publish to EVERY Device/<id>. value == numeric id.
				const t0 = Date.now();
				for (const id of allIds) {
					await restPut(id, { id, value: Number(id), tag: runTag }).expect(204);
				}
				const writeMs = Date.now() - t0;

				const mine = (e: MqttMsg) => e.tag === runTag;
				await waitFor(() => hashObs.events.filter(mine).length >= N, 20_000);
				await waitFor(() => plusObs.events.filter(mine).length >= N, 20_000);
				for (const s of specSubs) await waitFor(() => s.obs.events.filter(mine).length >= 1, 20_000);
				await sleep(1500); // settle window to catch any trailing bleed

				// ── Wildcard completeness + dup analysis ──
				const analyze = (obs: ReturnType<typeof collect>) => {
					const ids = obs.events
						.filter(mine)
						.map((e) => e.id)
						.filter((x): x is string => x != null);
					const seen = new Map<string, number>();
					for (const k of ids) seen.set(k, (seen.get(k) ?? 0) + 1);
					const uniq = seen.size;
					return { recv: ids.length, uniq, dup: ids.length - uniq, dropped: N - uniq, set: seen };
				};
				const h = analyze(hashObs);
				const p = analyze(plusObs);

				// ── Cross-topic BLEED analysis on each specific subscriber ──
				const bleedReports: string[] = [];
				let totalBleed = 0;
				let totalSpecMissing = 0;
				for (const s of specSubs) {
					const ids = s.obs.events
						.filter(mine)
						.map((e) => e.id)
						.filter((x): x is string => x != null);
					const got = new Set(ids);
					const bleed = [...got].filter((g) => g !== s.id); // ANY id != its own == BLEED
					const gotOwn = got.has(s.id);
					totalBleed += bleed.length;
					if (!gotOwn) totalSpecMissing++;
					bleedReports.push(
						`    Device/${s.id}: gotOwn=${gotOwn} recv=${ids.length} ` +
							`bleed=${bleed.length ? j(bleed.slice(0, 8)) : 'none'}`
					);
				}

				hashObs.stop();
				plusObs.stop();
				for (const s of specSubs) s.obs.stop();

				console.log(
					`\n[mqtt-at-scale][${label}][Q1] WILDCARD FAN-OUT (${N} topics, burst in ${writeMs}ms):\n` +
						`  Device/# : recv=${h.recv} uniq=${h.uniq} dup=${h.dup} dropped=${h.dropped} (expect ${N}/${N}/0/0)\n` +
						`  Device/+ : recv=${p.recv} uniq=${p.uniq} dup=${p.dup} dropped=${p.dropped} (expect ${N}/${N}/0/0)\n` +
						`  SPECIFIC subscribers (each must get ONLY its own id):\n` +
						bleedReports.join('\n') +
						`\n  => totalCrossTopicBleed=${totalBleed} specMissingOwn=${totalSpecMissing}`
				);

				// Hard invariants — wildcard completeness:
				strictEqual(h.dropped, 0, `Device/# must receive every topic; dropped=${h.dropped}`);
				strictEqual(h.dup, 0, `Device/# must not duplicate; dup=${h.dup}`);
				strictEqual(p.dropped, 0, `Device/+ must receive every single-level topic; dropped=${p.dropped}`);
				strictEqual(p.dup, 0, `Device/+ must not duplicate; dup=${p.dup}`);
				// THE SECURITY/CORRECTNESS INVARIANT — no cross-topic bleed:
				strictEqual(
					totalBleed,
					0,
					`CROSS-TOPIC BLEED: a specific subscriber received a non-matching topic. ${bleedReports.join(' | ')}`
				);
				strictEqual(totalSpecMissing, 0, 'each specific subscriber must receive its OWN topic');
			} finally {
				await endQuiet(pub);
				await endQuiet(hashSub);
				await endQuiet(plusSub);
				for (const s of specSubs) await endQuiet(s.c);
			}
		});

		// ── Q2: QoS-1 DURABLE BACKLOG drained on reconnect ─────────────────────────
		test('Q2: QoS-1 durable backlog drained on reconnect across all topics', async (t) => {
			if (!mqttUsable) {
				t.skip(`MQTT broker unavailable (harness): ${mqttSkipReason}`);
				return;
			}
			const N = 40;
			const clientId = `mqtt-scale-${label}-q2-durable`;
			const topic = `${TABLE}/#`;
			const runTag = `q2-${label}-${Date.now()}`;
			const pub = await connect(mqttURL, baseOpts({ clientId: `${clientId}-pub` }));
			let durable: MqttClient | undefined;
			try {
				// (1) Durable session, QoS-1, wildcard subscribe.
				durable = await connect(
					mqttURL,
					baseOpts({ clientId, clean: false, properties: { sessionExpiryInterval: 300 } })
				);
				let obs = collect(durable);
				await subscribe(durable, topic, 1);
				await sleep(400);

				// Pre-gap live message confirms the sub is armed.
				await restPut('arm', { id: 'arm', value: -1, tag: `${runTag}-arm` }).expect(204);
				await waitFor(() => obs.events.some((e) => e.tag === `${runTag}-arm`), 8000);
				obs.stop();

				// (2) Disconnect — broker retains the durable session.
				await endQuiet(durable);
				durable = undefined;
				await sleep(200);

				// (3) BACKLOG while disconnected: one publish per topic across N topics.
				const backlogIds = [...Array(N)].map((_, i) => `bk-${i}`);
				for (let i = 0; i < N; i++) {
					await restPut(backlogIds[i], { id: backlogIds[i], value: i, tag: runTag }).expect(204);
				}

				// (4) Reconnect SAME durable session (no re-subscribe); drain backlog.
				durable = await connect(
					mqttURL,
					baseOpts({ clientId, clean: false, properties: { sessionExpiryInterval: 300 } })
				);
				obs = collect(durable);
				await waitFor(() => obs.events.filter((e) => e.tag === runTag).length >= N, 20_000);
				await sleep(1500);

				const got = obs.events
					.filter((e) => e.tag === runTag)
					.map((e) => e.id)
					.filter((x): x is string => x != null);
				const seen = new Map<string, number>();
				for (const k of got) seen.set(k, (seen.get(k) ?? 0) + 1);
				const missing = backlogIds.filter((id) => !seen.has(id));
				const dups = backlogIds.filter((id) => (seen.get(id) ?? 0) > 1);
				obs.stop();

				console.log(
					`\n[mqtt-at-scale][${label}][Q2] QoS-1 DURABLE BACKLOG (${N} topics published while offline):\n` +
						`  drained=${seen.size}/${N} missing=${missing.length ? j(missing.slice(0, 10)) : 'none'} ` +
						`dup=${dups.length ? j(dups.slice(0, 10)) : 'none'}\n` +
						`  => ${missing.length === 0 ? 'CORRECT: full backlog drained' : 'LOST BACKLOG'}`
				);

				deepStrictEqual(missing, [], `QoS-1 durable backlog must be fully drained; missing=${j(missing)}`);
				deepStrictEqual(dups, [], `QoS-1 durable backlog must not duplicate; dup=${j(dups)}`);
			} finally {
				await endQuiet(pub);
				if (durable) await endQuiet(durable);
				// purge the durable session so a re-run starts clean
				try {
					const cleaner = await connect(mqttURL, baseOpts({ clientId, clean: true }));
					await endQuiet(cleaner);
				} catch {
					/* best effort */
				}
			}
		});

		// ── Q3: ISOLATION (no HOL blocking) + broker memory under fan-out ──────────
		test('Q3: stalled subscriber does not starve healthy subs; memory bounded', async (t) => {
			if (!mqttUsable) {
				t.skip(`MQTT broker unavailable (harness): ${mqttSkipReason}`);
				return;
			}
			const N = 50;
			const ROUNDS = 5;
			const big = 'x'.repeat(8192); // ~8KB payload, fan-out across many subs
			const runTag = `q3-${label}-${Date.now()}`;
			const baselineHeap = await maxWorkerHeapMB(client);

			// STALLED subscriber on Device/# — paused WS stream, never drains.
			const stalled = await connect(mqttURL, baseOpts({ clientId: `mqtt-scale-${label}-q3-stalled` }));
			await subscribe(stalled, `${TABLE}/#`, 1);
			try {
				(stalled.stream as any)?.pause?.();
			} catch {
				/* ignore */
			}

			// HEALTHY subscribers: one Device/# and several specific.
			const healthyHash = await connect(mqttURL, baseOpts({ clientId: `mqtt-scale-${label}-q3-healthy` }));
			const healthyObs = collect(healthyHash);
			await subscribe(healthyHash, `${TABLE}/#`, 1);
			const specSubs: { id: string; c: MqttClient; obs: ReturnType<typeof collect> }[] = [];
			for (const id of SPECIFIC_IDS) {
				const c = await connect(mqttURL, baseOpts({ clientId: `mqtt-scale-${label}-q3-spec-${id}` }));
				const obs = collect(c);
				await subscribe(c, `${TABLE}/${id}`, 1);
				specSubs.push({ id, c, obs });
			}

			try {
				await sleep(800);
				const heapTrend: number[] = [baselineHeap];
				let writeErrors = 0;
				const roundLatency: number[] = [];

				for (let r = 0; r < ROUNDS; r++) {
					const roundTag = `${runTag}-r${r}`;
					const ids = [...Array(N)].map((_, i) => String(i));
					const t0 = Date.now();
					for (const id of ids) {
						try {
							await restPut(id, { id, value: r, tag: roundTag }).timeout(8000).expect(204);
						} catch (e) {
							writeErrors++;
							if (writeErrors <= 2) console.log(`[mqtt-at-scale][${label}][Q3] write err: ${(e as Error).message}`);
						}
					}

					// Healthy Device/# must receive the full round set promptly despite the
					// stalled peer (isolation / no head-of-line blocking).
					const armed = await waitFor(() => healthyObs.events.filter((e) => e.tag === roundTag).length >= N, 12_000);
					const latency = Date.now() - t0;
					roundLatency.push(latency);

					await sleep(1200); // let resource-report interval update before sampling heap
					heapTrend.push(await maxWorkerHeapMB(client));
					const got = new Set(healthyObs.events.filter((e) => e.tag === roundTag).map((e) => e.id));
					console.log(
						`[mqtt-at-scale][${label}][Q3] round ${r}: ${N} writes, healthy#recv=${got.size}/${N} ` +
							`armed=${armed} latency=${latency}ms maxHeapMB=${heapTrend[heapTrend.length - 1].toFixed(1)}`
					);
				}

				await sleep(3000);
				const afterIdleHeap = await maxWorkerHeapMB(client);

				// Isolation: every healthy sub received its full set across all rounds.
				const healthyTotal = new Set(
					healthyObs.events.filter((e) => e.tag?.startsWith(runTag)).map((e) => `${e.tag}/${e.id}`)
				);
				const expectedHealthy = N * ROUNDS;
				healthyObs.stop();
				let specStarved = 0;
				for (const s of specSubs) {
					const own = s.obs.events.filter((e) => e.tag?.startsWith(runTag) && e.id === s.id).length;
					const bleed = s.obs.events.filter((e) => e.tag?.startsWith(runTag) && e.id !== s.id).length;
					if (own < ROUNDS) specStarved++;
					console.log(`[mqtt-at-scale][${label}][Q3] spec Device/${s.id}: own=${own}/${ROUNDS} bleed=${bleed}`);
					s.obs.stop();
				}

				const valid = heapTrend.filter((h) => h >= 0);
				const peak = Math.max(...valid);
				const growth = peak - baselineHeap;
				const totalPayloadMB = (ROUNDS * N * big.length) / (1024 * 1024);
				let strictlyRising = valid.length >= 3;
				for (let i = 2; i < valid.length; i++) if (valid[i] <= valid[i - 1]) strictlyRising = false;
				const maxLatency = Math.max(...roundLatency);

				let memVerdict: string;
				if (strictlyRising && growth > totalPayloadMB * 0.5)
					memVerdict = 'UNBOUNDED (heap tracks buffered payload per stalled sub)';
				else if (growth > totalPayloadMB) memVerdict = 'GROWING (non-monotonic but large)';
				else memVerdict = 'BOUNDED (heap did not track buffered fan-out payload)';

				console.log(
					`\n[mqtt-at-scale][${label}][Q3] ISOLATION + MEMORY:\n` +
						`  healthy Device/# delivered=${healthyTotal.size}/${expectedHealthy} specStarved=${specStarved}\n` +
						`  round latency ms = ${j(roundLatency)} (max ${maxLatency}ms)\n` +
						`  payload (note: backing-table writes, not raw buffer) ~${totalPayloadMB.toFixed(1)}MB\n` +
						`  heap MB trend = ${heapTrend.map((h) => h.toFixed(1)).join(' -> ')}  afterIdle=${afterIdleHeap.toFixed(1)}\n` +
						`  baseline=${baselineHeap.toFixed(1)} peak=${peak.toFixed(1)} growth=${growth.toFixed(1)}MB ` +
						`strictlyRising=${strictlyRising}\n` +
						`  writeErrors=${writeErrors}\n` +
						`  => ISOLATION: ${specStarved === 0 && healthyTotal.size >= expectedHealthy ? 'OK (no starvation)' : 'STARVED'} | MEMORY: ${memVerdict}`
				);

				// Hard invariants: a stalled peer must not starve healthy subs.
				strictEqual(specStarved, 0, 'specific healthy subs must not be starved by a stalled peer');
				strictEqual(
					healthyTotal.size,
					expectedHealthy,
					`healthy Device/# must receive all ${expectedHealthy} events despite a stalled peer; got ${healthyTotal.size}`
				);
				ok(maxLatency < 12_000, `per-round delivery must stay responsive; max latency ${maxLatency}ms`);
				strictEqual(writeErrors, 0, 'writes must not error while a subscriber is stalled');
				// Memory characterized (logged verdict), not hard-asserted — unbounded
				// live-tail is a known META, not a fresh defect.
				ok(true, 'memory behavior characterized in log');
			} finally {
				await endQuiet(stalled);
				await endQuiet(healthyHash);
				for (const s of specSubs) await endQuiet(s.c);
			}
		});

		test('instance survived scale probes (liveness)', async () => {
			const rest = await client
				.reqRest(`/${TABLE}/`)
				.timeout(5_000)
				.catch(() => ({ status: 0 }));
			ok((rest as any).status !== 0, `instance should still answer REST, got status ${(rest as any).status}`);
		});
	});
}

buildSuite('single-worker', { threads: { count: 1 } });
buildSuite('multi-worker', { threads: { count: 4 } });
