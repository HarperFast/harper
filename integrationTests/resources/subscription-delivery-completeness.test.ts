/**
 * QA-883 — Table.ts subscription dispatcher: does it drop intermediate same-id updates under
 * load, and does ANY subscription surface guarantee full-stream (every-transition) delivery?
 *
 * MECHANISM (resources/Table.ts, real-time listener registered via addSubscription()):
 *
 *   const entry: Entry = primaryStore.getEntry(id);
 *   if (entry) {
 *     if (entry.version !== auditRecord.version) return; // out of order event, with old update, don't send anything
 *     value = entry.value;
 *     ...
 *   }
 *
 * (resources/Table.ts:3968-3971, inside the `subscribe()` real-time dispatch callback, ~L3947).
 * Every committed write appends to the audit log and fires this listener once per commit. But the
 * listener re-reads the CURRENT primaryStore entry for `id` rather than using the audit record's
 * own value, and silently `return`s (delivers nothing) if a newer write already landed on that id
 * before this listener call is processed — i.e. rapid same-id writes are coalesced to
 * latest-value-wins. This is universal: every subscription surface (in-process subscribe(), SSE,
 * MQTT, WebSocket) is driven off this SAME listener (DESIGN.md L108: "The cross-thread
 * subscription path ... drives every Table.subscribe() consumer"). The one documented exception
 * is `request.rawEvents` (Table.ts:3952 `if (type === 'message' || request.rawEvents)`), which
 * skips the entry-version check entirely and forwards the audit record's own value — but grepping
 * server/mqtt.ts, server/REST.ts, and server/*.ts (see fixture header) turns up NO built-in
 * protocol surface that sets `rawEvents`, so this bypass is unreachable from SSE/MQTT/WS as
 * shipped; only a custom Resource calling `.subscribe({rawEvents: true})` directly could use it.
 *
 * DOCS CHECK (grepped `docs/`, `DESIGN.md`, `resources/DESIGN.md`, README.md, and the
 * `@harperfast/skills/harper-best-practices` rules bundle for "coalesc", "latest", "every
 * update|transition", "at-least-once", "guarantee...delivery"): the ONLY latest-value-wins language found
 * is real-time-apps.md's MQTT **retained-message** table ("Only the latest-timestamp message is
 * kept; suitable for sensor readings") — that documents retained-topic semantics specifically, not
 * the live real-time delivery path this test exercises. Nothing documents (or promises) coalescing
 * vs. full-stream delivery for a live subscribe()/SSE/MQTT/WS consumer. Gap confirmed, not guessed.
 *
 * AXES (surface x rate x threads x distinct-ids), prioritized per QA-883 brief:
 *   T1 SLOW,  single id, threads=1 — is the "spaced/settled" rate lossless? (the whole boundary)
 *   T2 BURST, single id, threads=1 — drop-under-burst, all 3 surfaces at once (same write loop)
 *   T3 BURST, many ids,  threads=1 — does concurrent cross-id load change the drop rate/pattern?
 *   T4 BURST, single id, threads=4 — does cross-thread notify (DESIGN.md L108) change the result?
 *   T5 SLOW,  single id, threads=4 — re-check the lossless boundary under multi-threading
 * In-process subscribe() is only measured under threads=1 (fixture header: a probe GET can land
 * on any of 4 worker threads, and only the thread that ran the module-load subscription has a
 * populated ledger — so threads=4 leaves it OUT rather than report a false empty count).
 *
 * Reproduction:
 *   npm run test:integration -- "integrationTests/resources/subscription-delivery-completeness.test.ts"
 * Harper SHA: c28e5f83f (discovery); re-verified green 5/5 on c11e0976c (main) at Stage-2 gating.
 */
import { suite, test, before, after } from 'node:test';
import { ok, strictEqual } from 'node:assert';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';

import mqtt, { type IClientOptions, type MqttClient } from 'mqtt';
import request from 'supertest';

import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
import { waitFor } from '../../unitTests/waitFor.js';
// @ts-expect-error utils/client.mjs has no type declarations; runtime resolves fine
import { createApiClient } from './../apiTests/utils/client.mjs';

const FIXTURE_PATH = resolve(import.meta.dirname, 'subscription-delivery-completeness');
const TABLE = 'Burst';

const skipSuite = process.env.HARPER_RUNTIME === 'bun' || process.platform === 'win32';

const ADMIN_USER = 'admin';
const ADMIN_PASS = 'Abc1234!';

// ── SSE helpers ─────────────────────────────────
interface SseEvent {
	data?: string;
	at: number;
}
interface SseStream {
	events: SseEvent[];
	status: number;
	contentType: string;
	destroy: () => void;
}

function openSse(urlStr: string, headers: Record<string, string>): Promise<SseStream> {
	const url = new URL(urlStr);
	const lib = url.protocol === 'https:' ? https : http;
	const events: SseEvent[] = [];
	let buffer = '';
	const parseFrame = (frame: string) => {
		if (!frame.trim()) return;
		const ev: SseEvent = { at: Date.now() };
		for (const line of frame.split('\n')) {
			const idx = line.indexOf(':');
			if (idx < 0) continue;
			const field = line.slice(0, idx);
			const val = line.slice(idx + 1).replace(/^ /, '');
			if (field === 'data') ev.data = (ev.data ? ev.data + '\n' : '') + val;
		}
		events.push(ev);
	};
	return new Promise<SseStream>((resolvePromise, reject) => {
		const req = lib.request(
			url,
			{ method: 'GET', headers: { ...headers, Accept: 'text/event-stream' }, rejectUnauthorized: false } as any,
			(res) => {
				const stream: SseStream = {
					events,
					status: res.statusCode ?? 0,
					contentType: (res.headers['content-type'] as string) ?? '',
					destroy: () => {
						res.destroy();
						req.destroy();
					},
				};
				res.setEncoding('utf8');
				res.on('data', (chunk: string) => {
					buffer += chunk.replace(/\r\n?/g, '\n');
					let sep: number;
					while ((sep = buffer.indexOf('\n\n')) >= 0) {
						parseFrame(buffer.slice(0, sep));
						buffer = buffer.slice(sep + 2);
					}
				});
				res.on('end', () => {
					if (buffer.trim()) parseFrame(buffer);
					buffer = '';
				});
				res.on('error', () => {});
				resolvePromise(stream);
			}
		);
		req.on('error', reject);
		req.end();
	});
}

interface Delivered {
	id?: string;
	seq?: number;
	tag?: string;
}

function sseDelivered(ev: SseEvent): Delivered | undefined {
	if (!ev.data) return undefined;
	try {
		const obj = JSON.parse(ev.data);
		if (obj && typeof obj === 'object' && obj.id != null) {
			const rec = obj.value && typeof obj.value === 'object' ? obj.value : obj;
			return { id: String(obj.id), seq: typeof rec?.seq === 'number' ? rec.seq : undefined, tag: rec?.tag };
		}
	} catch {
		/* not json */
	}
	return undefined;
}

// ── MQTT helpers ────────────────────────────────
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

function connectMqtt(url: string, opts: IClientOptions): Promise<MqttClient> {
	return new Promise((resolvePromise, reject) => {
		const client = mqtt.connect(url, opts);
		const onError = (err: Error) => {
			client.removeListener('connect', onConnect);
			client.end(true);
			reject(err);
		};
		const onConnect = () => {
			client.removeListener('error', onError);
			client.on('error', () => {});
			resolvePromise(client);
		};
		client.once('error', onError);
		client.once('connect', onConnect);
	});
}

function mqttSubscribe(client: MqttClient, topic: string, qos: 0 | 1 | 2 = 1): Promise<any[]> {
	return new Promise((resolvePromise, reject) => {
		client.subscribe(topic, { qos }, (err, granted) => {
			if (err) reject(err);
			else resolvePromise(granted ?? []);
		});
	});
}

function endQuiet(client: MqttClient | undefined): Promise<void> {
	return new Promise((resolvePromise) => {
		if (!client) return resolvePromise();
		client.end(true, {}, () => resolvePromise());
	});
}

function collectMqtt(client: MqttClient) {
	const events: Delivered[] = [];
	const handler = (_topic: string, payload: Buffer) => {
		let parsed: any;
		try {
			parsed = JSON.parse(payload.toString());
		} catch {
			parsed = undefined;
		}
		events.push({ id: parsed?.id != null ? String(parsed.id) : undefined, seq: parsed?.seq, tag: parsed?.tag });
	};
	client.on('message', handler);
	return { events, stop: () => client.removeListener('message', handler) };
}

const j = (x: any) => JSON.stringify(x);

/** Per-id delivery accounting: distinct seq values received vs. issued, for one id. */
function analyze(delivered: Delivered[], id: string, issued: number) {
	const seqs = delivered
		.filter((e) => e.id === id)
		.map((e) => e.seq)
		.filter((s): s is number => typeof s === 'number');
	const uniq = new Set(seqs);
	const monotonic = seqs.every((v, i) => i === 0 || v >= seqs[i - 1]);
	const last = seqs[seqs.length - 1];
	return {
		receivedCount: seqs.length,
		uniqCount: uniq.size,
		dropped: issued - uniq.size,
		monotonic,
		last,
		sample: seqs.slice(0, 10),
	};
}

function lastDeliveredSeq(delivered: Delivered[], id: string, tag: string) {
	return delivered.filter((event) => event.id === id && event.tag === tag).at(-1)?.seq;
}

function runSuite(threadCount: 1 | 4) {
	suite(`QA-883 subscription coalescing [threads=${threadCount}]`, { skip: skipSuite }, (ctx: ContextWithHarper) => {
		let client: ReturnType<typeof createApiClient>;
		let restBase = '';
		let authHeaders: Record<string, string> = {};
		let mqttURL = '';
		let mqttUsable = false;
		const openStreams = new Set<SseStream>();

		const track = (s: SseStream): SseStream => {
			openStreams.add(s);
			return s;
		};
		const drop = (s: SseStream) => {
			try {
				s.destroy();
			} catch {
				/* ignore */
			}
			openStreams.delete(s);
		};

		const restPut = (id: string, body: object) =>
			request(restBase)
				.put(`/${TABLE}/${encodeURIComponent(id)}`)
				.set(client.headers)
				.send(body);

		async function inProcEvents(): Promise<Delivered[]> {
			if (threadCount !== 1) return [];
			const r = await client.reqRest(`/InProcProbe/`).timeout(10_000);
			const body = r.body as any;
			return Array.isArray(body?.events)
				? body.events.map((e: any) => ({ id: e.id != null ? String(e.id) : undefined, seq: e.seq, tag: e.tag }))
				: [];
		}

		before(async () => {
			await setupHarperWithFixture(ctx, FIXTURE_PATH, { config: { threads: { count: threadCount } }, env: {} });
			client = createApiClient(ctx.harper);
			restBase = client.restURL;
			authHeaders = { Authorization: client.headers.Authorization as string };

			const httpURL = ctx.harper.httpURL;
			const wsScheme = httpURL.startsWith('https') ? 'wss' : 'ws';
			mqttURL = `${httpURL.replace(/^https?/, wsScheme)}/mqtt`;

			// Readiness poll (per eviction-secondary-index.test.ts ~L91). No restartHttpWorkers() —
			// the fixture is pre-installed, restarting would race it. Poll BOTH the schema-defined
			// table route and the resources.js-defined InProcProbe route: the graphql schema and
			// resources.js load on independent timelines (component loader logs "still waiting for
			// N pending file reads" after the table route is already live), so gating on `/Burst/`
			// alone can leave InProcProbe 404ing for a bit longer.
			const deadline = Date.now() + 60_000;
			while (Date.now() < deadline) {
				try {
					const probe = await client.reqRest(`/${TABLE}/`).timeout(3_000);
					const probe2 = threadCount === 1 ? await client.reqRest(`/InProcProbe/`).timeout(3_000) : { status: 200 };
					if (probe.status !== 404 && probe2.status !== 404) break;
				} catch {
					/* not ready */
				}
				await sleep(250);
			}

			// SSE on an empty/nonexistent collection withholds headers until the first row exists
			// (QA-140 finding) — seed one row so every collection SSE opened below flushes promptly.
			await restPut('__seed__', { id: '__seed__', value: 0, seq: 0, tag: 'seed' }).expect(204);

			try {
				const probe = await connectMqtt(mqttURL, baseOpts({ clientId: `qa883-probe-t${threadCount}` }));
				mqttUsable = probe.connected === true;
				await endQuiet(probe);
			} catch (err) {
				mqttUsable = false;
				console.log(`\n[QA-883] HARNESS: MQTT connect probe failed on ${mqttURL}: ${(err as Error)?.message}`);
			}
			ok(mqttUsable, `QA-883 requires an MQTT connection at ${mqttURL}`);

			if (threadCount === 1) {
				await sleep(500);
				const r = await client.reqRest(`/InProcProbe/`).timeout(10_000);
				console.log(
					`\n[QA-883] HARNESS: InProcProbe after seed -> status=${r.status} count=${(r.body as any)?.count} started=${(r.body as any)?.started} error=${(r.body as any)?.error} sample=${JSON.stringify((r.body as any)?.events?.slice?.(-3))}`
				);
			}
		});

		after(async () => {
			for (const s of openStreams) {
				try {
					s.destroy();
				} catch {
					/* ignore */
				}
			}
			openStreams.clear();
			await teardownHarper(ctx);
		});

		/**
		 * Drive `count` writes to `id` at the given rate, with subscribers already attached on all
		 * available surfaces, then report per-surface delivered/dropped counts.
		 *
		 * rate 'slow'  = each write fully awaited (REST response received) + a settle delay before
		 *                the next — "one settled write at a time", per QA-883 brief.
		 * rate 'burst' = all `count` writes fired via Promise.all with no await between issuance —
		 *                genuine overlapping/concurrent commits, "tight loop, no await between".
		 */
		async function driveAndMeasure(opts: { label: string; id: string; count: number; rate: 'slow' | 'burst' }) {
			const { label, id, count, rate } = opts;
			const tag = `${label}-${Date.now()}`;

			const sse = track(await openSse(`${restBase}/${TABLE}/`, authHeaders));
			ok(sse.status >= 200 && sse.status < 300, `[${label}] SSE should open, got ${sse.status}`);

			let mqc: MqttClient | undefined;
			let mqCollect: ReturnType<typeof collectMqtt> | undefined;
			if (mqttUsable) {
				mqc = await connectMqtt(mqttURL, baseOpts({ clientId: `qa883-${label}` }));
				await mqttSubscribe(mqc, `${TABLE}/${id}`, 1);
				mqCollect = collectMqtt(mqc);
			}

			try {
				await sleep(400); // let subscriptions attach before we start writing

				let issued = 0;
				const t0 = Date.now();
				if (rate === 'slow') {
					for (let seq = 1; seq <= count; seq++) {
						const res = await restPut(id, { id, value: seq, seq, tag });
						strictEqual(res.status, 204, `[${label}] write ${seq} must succeed before measuring delivery`);
						issued++;
						await waitFor(
							async () => {
								const inProc = threadCount === 1 ? await inProcEvents() : [];
								const sseEvents = sse.events.map(sseDelivered).filter((event): event is Delivered => !!event);
								const mqttEvents = mqCollect?.events ?? [];
								return (
									lastDeliveredSeq(sseEvents, id, tag) === seq &&
									(!mqCollect || lastDeliveredSeq(mqttEvents, id, tag) === seq) &&
									(threadCount !== 1 || lastDeliveredSeq(inProc, id, tag) === seq)
								);
							},
							{ timeout: 15_000, interval: 50, message: `[${label}] write ${seq} was not delivered on every surface` }
						);
					}
				} else {
					const puts = [];
					for (let seq = 1; seq <= count; seq++) puts.push(restPut(id, { id, value: seq, seq, tag }));
					const results = await Promise.all(puts);
					issued = results.filter((r) => r.status === 204).length;
				}
				const writeMs = Date.now() - t0;

				const finalRes = await request(restBase)
					.get(`/${TABLE}/${encodeURIComponent(id)}`)
					.set(client.headers);
				strictEqual(finalRes.status, 200, `[${label}] final GET must succeed`);
				const finalSeq = (finalRes.body as any)?.seq;
				await waitFor(
					async () => {
						const inProc = threadCount === 1 ? await inProcEvents() : [];
						const sseEvents = sse.events.map(sseDelivered).filter((event): event is Delivered => !!event);
						const mqttEvents = mqCollect?.events ?? [];
						return (
							lastDeliveredSeq(sseEvents, id, tag) === finalSeq &&
							(!mqCollect || lastDeliveredSeq(mqttEvents, id, tag) === finalSeq) &&
							(threadCount !== 1 || lastDeliveredSeq(inProc, id, tag) === finalSeq)
						);
					},
					{ timeout: 15_000, interval: 50, message: `[${label}] final value was not delivered on every surface` }
				);

				const sseDeliveredEvents = sse.events
					.map(sseDelivered)
					.filter((e): e is Delivered => e?.id === id && e?.tag === tag);
				const sseStats = analyze(sseDeliveredEvents, id, issued);

				let mqStats: ReturnType<typeof analyze> | undefined;
				if (mqCollect) {
					mqCollect.stop();
					const mqEvents = mqCollect.events.filter((e) => e.id === id && e.tag === tag);
					mqStats = analyze(mqEvents, id, issued);
				}

				let inProcStats: ReturnType<typeof analyze> | undefined;
				if (threadCount === 1) {
					const inProc = await inProcEvents();
					const inProcOwn = inProc.filter((e) => e.id === id && e.tag === tag);
					inProcStats = analyze(inProcOwn, id, issued);
				}

				console.log(
					`\n[QA-883][${label}] rate=${rate} threads=${threadCount} id=${id} issued=${issued} writeMs=${writeMs} finalStoredSeq=${finalSeq}\n` +
						`  in-proc: ${inProcStats ? j(inProcStats) : 'N/A (threads!=1)'}\n` +
						`  SSE    : ${j(sseStats)}\n` +
						`  MQTT   : ${mqStats ? j(mqStats) : 'N/A (mqtt unusable)'}`
				);

				return { issued, writeMs, inProcStats, sseStats, mqStats, finalSeq };
			} finally {
				drop(sse);
				mqCollect?.stop();
				await endQuiet(mqc);
			}
		}

		test('T-slow: single id, spaced/settled writes — is the slow rate lossless?', async () => {
			const COUNT = threadCount === 1 ? 30 : 15;
			const { issued, inProcStats, sseStats, mqStats } = await driveAndMeasure({
				label: 'slow',
				id: `slow-${threadCount}`,
				count: COUNT,
				rate: 'slow',
			});
			strictEqual(issued, COUNT, `all ${COUNT} slow writes must succeed before measuring delivery`);

			// The claim under test: "slow" (one settled write at a time) should be lossless on every
			// surface. Report, don't hard-fail the suite on this — it's the finding, not a known
			// invariant Harper documents. strictEqual gives a clear PASS/FAIL signal in the log either way.
			if (inProcStats)
				strictEqual(inProcStats.dropped, 0, `in-process dropped ${inProcStats.dropped}/${COUNT} at slow rate`);
			strictEqual(sseStats.dropped, 0, `SSE dropped ${sseStats.dropped}/${COUNT} at slow rate`);
			if (mqStats) strictEqual(mqStats.dropped, 0, `MQTT dropped ${mqStats.dropped}/${COUNT} at slow rate`);
		});

		test('T-burst: single id, tight-loop concurrent writes — drop-under-burst', async () => {
			const COUNT = 200;
			const { issued, inProcStats, sseStats, mqStats, finalSeq } = await driveAndMeasure({
				label: 'burst',
				id: `burst-${threadCount}`,
				count: COUNT,
				rate: 'burst',
			});
			strictEqual(issued, COUNT, `all ${COUNT} burst writes must succeed before measuring delivery`);

			// Coalescing under burst is the EXPECTED, documented-as-a-cache-semantic behavior per
			// QA-883's premise — not asserted as a defect. NOTE: writes were fired concurrently
			// (Promise.all, no await between), so our own `seq` labels do NOT define commit order —
			// delivered seqs need not be monotonic in issuance order (that's a property of OUR
			// concurrent client, not a dispatcher reorder). The real invariant: the LAST event each
			// surface delivered must match the record's actual final stored state (no stale/invented
			// terminal value), and every id must have delivered at least one live event.
			ok(sseStats.receivedCount > 0, 'SSE must deliver at least one event under burst');
			strictEqual(
				sseStats.last,
				finalSeq,
				`SSE last-delivered seq must match final stored seq ${finalSeq}, got ${sseStats.last}`
			);
			if (mqStats) {
				ok(mqStats.receivedCount > 0, 'MQTT must deliver at least one event under burst');
				strictEqual(
					mqStats.last,
					finalSeq,
					`MQTT last-delivered seq must match final stored seq ${finalSeq}, got ${mqStats.last}`
				);
			}
			if (inProcStats) {
				ok(inProcStats.receivedCount > 0, 'in-process probe must deliver at least one event under burst');
				strictEqual(
					inProcStats.last,
					finalSeq,
					`in-process last-delivered seq must match final stored seq ${finalSeq}, got ${inProcStats.last}`
				);
			}
		});

		if (threadCount === 1) {
			test('T-many-ids: N ids x M concurrent writes each — cross-id load, per-id drop rate', async () => {
				const IDS = 10;
				const PER_ID = 30;
				const tag = `many-${Date.now()}`;
				const runId = (i: number) => `many-${tag}-${i}`;

				const sse = track(await openSse(`${restBase}/${TABLE}/`, authHeaders));
				let mqc: MqttClient | undefined;
				let mqCollect: ReturnType<typeof collectMqtt> | undefined;
				try {
					ok(sse.status >= 200 && sse.status < 300, `SSE collection should open, got ${sse.status}`);
					if (mqttUsable) {
						mqc = await connectMqtt(mqttURL, baseOpts({ clientId: 'qa883-many' }));
						await mqttSubscribe(mqc, `${TABLE}/#`, 1);
						mqCollect = collectMqtt(mqc);
					}

					await sleep(400);

					const puts: Array<{ id: string; request: ReturnType<typeof restPut> }> = [];
					for (let i = 0; i < IDS; i++) {
						const id = runId(i);
						for (let seq = 1; seq <= PER_ID; seq++)
							puts.push({ id, request: restPut(id, { id, value: seq, seq, tag }) });
					}
					const t0 = Date.now();
					const results = await Promise.all(puts.map((put) => put.request));
					const writeMs = Date.now() - t0;
					const issuedById = new Map<string, number>();
					for (const [index, result] of results.entries()) {
						if (result.status === 204) {
							const id = puts[index].id;
							issuedById.set(id, (issuedById.get(id) ?? 0) + 1);
						}
					}
					const issuedTotal = [...issuedById.values()].reduce((total, issued) => total + issued, 0);

					const finalSeqById = new Map<string, number>();
					for (let i = 0; i < IDS; i++) {
						const id = runId(i);
						const finalRes = await request(restBase)
							.get(`/${TABLE}/${encodeURIComponent(id)}`)
							.set(client.headers);
						strictEqual(finalRes.status, 200, `final GET for ${id} must succeed`);
						finalSeqById.set(id, (finalRes.body as any)?.seq);
					}
					await waitFor(
						async () => {
							const inProcEventsForTag = (await inProcEvents()).filter((event) => event.tag === tag);
							const sseEventsForTag = sse.events
								.map(sseDelivered)
								.filter((event): event is Delivered => event?.tag === tag);
							const mqttEventsForTag = mqCollect?.events.filter((event) => event.tag === tag) ?? [];
							return Array.from({ length: IDS }, (_, i) => {
								const id = runId(i);
								const finalSeq = finalSeqById.get(id);
								return (
									lastDeliveredSeq(sseEventsForTag, id, tag) === finalSeq &&
									lastDeliveredSeq(mqttEventsForTag, id, tag) === finalSeq &&
									lastDeliveredSeq(inProcEventsForTag, id, tag) === finalSeq
								);
							}).every(Boolean);
						},
						{ timeout: 15_000, interval: 50, message: 'many-id final values were not delivered on every surface' }
					);

					const inProc = (await inProcEvents()).filter((e) => e.tag === tag);
					const sseEvents = sse.events.map(sseDelivered).filter((e): e is Delivered => e?.tag === tag);
					mqCollect?.stop();
					const mqEvents = mqCollect?.events.filter((e) => e.tag === tag) ?? [];

					const perIdRows: string[] = [];
					let inProcDroppedTotal = 0;
					let sseDroppedTotal = 0;
					let mqDroppedTotal = 0;
					for (let i = 0; i < IDS; i++) {
						const id = runId(i);
						const issued = issuedById.get(id) ?? 0;
						const ip = analyze(inProc, id, issued);
						const se = analyze(sseEvents, id, issued);
						const mq = mqCollect ? analyze(mqEvents, id, issued) : undefined;
						inProcDroppedTotal += threadCount === 1 ? ip.dropped : 0;
						sseDroppedTotal += se.dropped;
						mqDroppedTotal += mq?.dropped ?? 0;
						perIdRows.push(
							`    ${id}: in-proc drop=${threadCount === 1 ? ip.dropped : 'N/A'} sse drop=${se.dropped} mqtt drop=${mq ? mq.dropped : 'N/A'}`
						);
					}

					console.log(
						`\n[QA-883][many-ids] ${IDS} ids x ${PER_ID} writes, all fired concurrently (writeMs=${writeMs}, issued=${issuedTotal}/${IDS * PER_ID}):\n` +
							(threadCount === 1 ? `  in-proc total dropped=${inProcDroppedTotal}/${IDS * PER_ID}\n` : '') +
							`  SSE total dropped=${sseDroppedTotal}/${IDS * PER_ID}\n` +
							`  MQTT total dropped=${mqDroppedTotal}/${IDS * PER_ID}\n` +
							perIdRows.join('\n')
					);

					// No hard assertion here beyond "every id delivers its terminal value" — this test is
					// characterizing the drop RATE under cross-id load, not asserting a specific number.
					for (let i = 0; i < IDS; i++) {
						const id = runId(i);
						const issued = issuedById.get(id) ?? 0;
						strictEqual(issued, PER_ID, `all writes for ${id} must succeed before measuring delivery`);
						const finalSeq = finalSeqById.get(id);
						const ip = analyze(inProc, id, issued);
						ok(ip.receivedCount > 0, `in-process probe must deliver at least one event for ${id}`);
						strictEqual(
							ip.last,
							finalSeq,
							`in-process terminal value for ${id} must match final stored seq ${finalSeq}, got ${ip.last}`
						);
						const se = analyze(sseEvents, id, issued);
						ok(se.receivedCount > 0, `SSE must deliver at least one event for ${id}`);
						strictEqual(
							se.last,
							finalSeq,
							`SSE terminal value for ${id} must match final stored seq ${finalSeq}, got ${se.last}`
						);
						const mq = analyze(mqEvents, id, issued);
						ok(mq.receivedCount > 0, `MQTT must deliver at least one event for ${id}`);
						strictEqual(
							mq.last,
							finalSeq,
							`MQTT terminal value for ${id} must match final stored seq ${finalSeq}, got ${mq.last}`
						);
					}
				} finally {
					drop(sse);
					mqCollect?.stop();
					await endQuiet(mqc);
				}
			});
		}
	});
}

runSuite(1);
runSuite(4);
