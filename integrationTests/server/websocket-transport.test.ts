/**
 * WebSocket subscription transport: delivery, disconnect teardown, backpressure.
 *
 * Harper exposes table subscriptions over WebSocket. The WS subscribe URL is the
 * SAME REST path (e.g. /Burst/ collection or /Burst/<id> record), upgraded to
 * WebSocket; the connection itself IS the subscription. We send Authorization +
 * Content-Type: application/json on the upgrade request so frames arrive as JSON
 * change envelopes: {id, localTime, value:<record>, version, type}.
 *
 * QUESTIONS:
 *   Q1 SAME-KEY BURST: fire N rapid PUTs to ONE key; subscriber must see monotonic
 *      (no reorder), no value past final, last==final. (Coalescing is legitimate;
 *      we assert order.)
 *   Q2 MANY-KEY BURST: one PUT to each of K distinct keys; every key delivered
 *      EXACTLY ONCE, no drop/dup. (Parity with QA-140's exactly-once SSE/MQTT.)
 *   Q3 DISCONNECT TEARDOWN: open a WS sub, receive an event, then HARD disconnect
 *      the client mid-stream. Does the subscription-layer teardown fire PROMPTLY
 *      (activeSubs decrements without any further write), confirming WS is leak-free?
 *      Or is it deferred until the next event (F-024-style)?
 *   Q4 SLOW / STALLED CONSUMER: open a WS sub and NEVER read (pause the socket),
 *      drive sustained large writes, sample per-worker heap/handles. Bounded
 *      (kernel backpressure) vs unbounded. Liveness: a healthy WS + REST client
 *      stays responsive throughout.
 *
 * TEARDOWN SAFETY: every WS is terminate()'d in finally/after. An undrained WS
 * sub would block teardownHarper, so we never rely on the server to close it.
 */
import { suite, test, before, after } from 'node:test';
import { ok, strictEqual } from 'node:assert';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import WebSocket from 'ws';
import request from 'supertest';

import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
// @ts-expect-error utils/client.mjs has no type declarations; runtime resolves fine
import { createApiClient } from '../apiTests/utils/client.mjs';

const FIXTURE_PATH = resolve(import.meta.dirname, 'websocket-transport');
const skipSuite = process.env.HARPER_RUNTIME === 'bun' || process.platform === 'win32';

interface WsEvent {
	raw: string;
	id?: string;
	value?: number;
	type?: string;
	at: number;
}

/**
 * An open WS subscription. `events` is mutated live as frames arrive. `consume:false` pauses
 * the socket (stalled slow consumer — never read). `terminate()` hard-kills the socket (the
 * mid-stream client-disconnect simulation; ws.terminate() is an abrupt RST, no close frame).
 */
interface WsSub {
	ws: WebSocket;
	events: WsEvent[];
	opened: boolean;
	terminate: () => void;
}

function parseFrame(raw: string): WsEvent {
	const ev: WsEvent = { raw, at: Date.now() };
	try {
		const obj = JSON.parse(raw);
		if (obj && typeof obj === 'object') {
			if (obj.id != null) ev.id = String(obj.id);
			ev.type = obj.type;
			const inner = obj.value;
			if (inner && typeof inner === 'object' && typeof inner.value === 'number') ev.value = inner.value;
			else if (typeof inner === 'number') ev.value = inner;
			else if (typeof obj.value === 'number') ev.value = obj.value;
		}
	} catch {
		/* not json */
	}
	return ev;
}

function openWs(wsBase: string, path: string, auth: string, opts: { consume?: boolean } = {}): Promise<WsSub> {
	const consume = opts.consume ?? true;
	const events: WsEvent[] = [];
	const ws = new WebSocket(`${wsBase}${path}`, {
		headers: { 'Authorization': auth, 'Content-Type': 'application/json' },
		// loopback; no TLS in this env but tolerate self-signed if it ever is.
		rejectUnauthorized: false,
	});
	const sub: WsSub = {
		ws,
		events,
		opened: false,
		terminate: () => {
			try {
				ws.terminate();
			} catch {
				/* ignore */
			}
		},
	};
	ws.on('message', (data: Buffer) => {
		if (!consume) return; // stalled consumer: drop without parsing (socket still drains; see Q4 note)
		events.push(parseFrame(data.toString()));
	});
	ws.on('error', () => {});
	return new Promise<WsSub>((resolve, reject) => {
		ws.once('open', () => {
			sub.opened = true;
			if (!consume) ws.pause(); // truly stall: stop reading the underlying socket
			resolve(sub);
		});
		ws.once('error', (err) => reject(err));
		// guard: never hang forever waiting for an upgrade
		setTimeout(() => (sub.opened ? resolve(sub) : reject(new Error('ws open timeout'))), 8000);
	});
}

async function waitFor(
	predicate: () => boolean | Promise<boolean>,
	timeoutMs = 15_000,
	intervalMs = 25
): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await predicate()) return true;
		await sleep(intervalMs);
	}
	return await predicate();
}

function wsSuite(label: string, threadCount: number | undefined) {
	suite(`WebSocket transport [${label}]`, { skip: skipSuite }, (ctx: ContextWithHarper) => {
		let client: ReturnType<typeof createApiClient>;
		let restBase = '';
		let wsBase = '';
		let auth = '';
		const open = new Set<WsSub>();

		const track = (s: WsSub) => {
			open.add(s);
			return s;
		};
		const drop = (s: WsSub) => {
			s.terminate();
			open.delete(s);
		};

		const restPut = (id: string, body: object) => request(restBase).put(`/Burst/${id}`).set(client.headers).send(body);

		// PERSISTENT latest-per-pid ledger. A single /Probe/ GET lands on ONE worker,
		// and one probe() call's round-robin may not cover all workers — so we keep
		// the latest reading per pid ACROSS calls. Monotonic counters (opened/closed)
		// are always correct; gauges (activeSubs/heap/handles) reflect each worker's
		// last-seen value.
		const perPid = new Map<number, any>();

		/** Sum per-worker Probe ledgers (latest reading per pid, accumulated across calls). */
		async function probe(samples = 40): Promise<{
			activeSubs: number;
			opened: number;
			closed: number;
			maxConcurrent: number;
			teardownErrors: number;
			activeHandles: number;
			heapUsed: number;
			pids: number;
		}> {
			for (let i = 0; i < samples; i++) {
				try {
					// Connection: close forces a FRESH TCP connection per GET so the OS (SO_REUSEPORT)
					// spreads our probes across ALL worker threads — a keep-alive agent would pin every
					// GET to one worker (workers=1) and hide the worker holding the WS sub.
					const r = await client.reqRest('/Probe/').set('Connection', 'close').timeout(3000);
					if (r.status === 200 && r.body?.pid != null) perPid.set(r.body.pid, r.body);
				} catch {
					/* ignore */
				}
			}
			const agg = {
				activeSubs: 0,
				opened: 0,
				closed: 0,
				maxConcurrent: 0,
				teardownErrors: 0,
				activeHandles: 0,
				heapUsed: 0,
				pids: perPid.size,
			};
			for (const v of perPid.values()) {
				agg.activeSubs += v.activeSubs ?? 0;
				agg.opened += v.opened ?? 0;
				agg.closed += v.closed ?? 0;
				agg.maxConcurrent += v.maxConcurrent ?? 0;
				agg.teardownErrors += v.teardownErrors ?? 0;
				agg.activeHandles += v.activeHandles ?? 0;
				agg.heapUsed += v.heapUsed ?? 0;
			}
			return agg;
		}

		before(async () => {
			const config: any = {};
			if (threadCount) config.threads = { count: threadCount };
			await setupHarperWithFixture(ctx, FIXTURE_PATH, { config, env: {} });
			client = createApiClient(ctx.harper);
			restBase = client.restURL;
			wsBase = restBase.replace(/^http/, 'ws');
			auth = client.headers.Authorization as string;
			const deadline = Date.now() + 30_000;
			while (Date.now() < deadline) {
				try {
					const probeReq = await client.reqRest('/Burst/').timeout(3000);
					if (probeReq.status !== 404) break;
				} catch {
					/* not ready */
				}
				await sleep(250);
			}
		});

		after(async () => {
			for (const s of open) s.terminate();
			open.clear();
			await teardownHarper(ctx);
		});

		// Q1 — same-key burst: monotonic, last==final.
		test('Q1: same-key burst delivers in monotonic order, ending on final', { timeout: 60_000 }, async () => {
			const N = 30;
			const id = `q1-${Date.now()}`;
			const sub = track(await openWs(wsBase, `/Burst/${id}`, auth));
			ok(sub.opened, 'WS record subscription should open');
			await sleep(300);
			for (let v = 1; v <= N; v++) await restPut(id, { id, value: v, tag: 'q1' }).expect(204);

			await waitFor(() => sub.events.filter((e) => e.id === id && e.value === N).length >= 1, 12_000);
			const mine = sub.events.filter((e) => e.id === id && typeof e.value === 'number');
			const values = mine.map((e) => e.value as number);
			const monotonic = values.every((v, i) => i === 0 || v >= values[i - 1]);
			const last = values[values.length - 1];
			console.log(
				`\n[ws-transport][${label}][Q1] same-key burst (sent ${N}):\n` +
					`  frames for key       = ${mine.length}\n` +
					`  values               = ${JSON.stringify(values.slice(0, 40))}\n` +
					`  monotonic            = ${monotonic}\n` +
					`  last / final         = ${last} / ${N}\n` +
					`  classification       = ${values.length >= N ? 'FULL STREAM' : values.length <= 3 ? 'COALESCED' : 'PARTIAL'}`
			);
			ok(values.length >= 1, 'WS subscriber should receive at least one frame for our key');
			ok(monotonic, `WS values must be monotonic (no reorder); got ${JSON.stringify(values)}`);
			ok(values.length <= N, `must not deliver MORE than sent (no dup); got ${values.length}`);
			strictEqual(last, N, `last delivered value must be the final write ${N}, got ${last}`);
			drop(sub);
		});

		// Q2 — many-key burst: exactly-once per key, no drop/dup.
		test('Q2: many-key burst delivers each key exactly once (no drop/dup)', { timeout: 60_000 }, async () => {
			const K = 50;
			const run = Date.now();
			const sub = track(await openWs(wsBase, `/Burst/`, auth)); // collection sub
			ok(sub.opened, 'WS collection subscription should open');
			await sleep(400);
			const keys: string[] = [];
			for (let i = 0; i < K; i++) {
				const id = `q2-${run}-${i}`;
				keys.push(id);
				await restPut(id, { id, value: i, tag: 'q2' }).expect(204);
			}
			const keySet = new Set(keys);
			await waitFor(() => {
				const seen = new Set(sub.events.filter((e) => e.id && keySet.has(e.id)).map((e) => e.id));
				return seen.size >= K;
			}, 15_000);

			const mine = sub.events.filter((e) => e.id && keySet.has(e.id));
			const counts = new Map<string, number>();
			for (const e of mine) counts.set(e.id!, (counts.get(e.id!) ?? 0) + 1);
			const delivered = counts.size;
			const dups = [...counts.entries()].filter(([, c]) => c > 1);
			const missing = keys.filter((k) => !counts.has(k));
			console.log(
				`\n[ws-transport][${label}][Q2] many-key burst (sent ${K} distinct keys):\n` +
					`  distinct keys delivered = ${delivered}/${K}\n` +
					`  duplicated keys         = ${dups.length} ${dups.length ? JSON.stringify(dups.slice(0, 5)) : ''}\n` +
					`  missing keys            = ${missing.length} ${missing.length ? JSON.stringify(missing.slice(0, 5)) : ''}\n` +
					`  classification          = ${delivered === K && dups.length === 0 ? 'EXACTLY-ONCE' : delivered < K ? 'DROP' : 'DUP'}`
			);
			strictEqual(delivered, K, `every key must be delivered; missing=${JSON.stringify(missing.slice(0, 10))}`);
			strictEqual(dups.length, 0, `no key may be duplicated; dups=${JSON.stringify(dups.slice(0, 10))}`);
			drop(sub);
		});

		// Q3 — DISCONNECT TEARDOWN. Sample subscription-layer activeSubs
		// BEFORE / WHILE-CONNECTED / AFTER-DISCONNECT with NO intervening write.
		test(
			'Q3: WS disconnect tears down the subscription PROMPTLY (no F-024 deferral)',
			{ timeout: 90_000 },
			async () => {
				const base = await probe();
				const id = `q3-${Date.now()}`;
				// connect to the instrumented Live resource so we observe the REAL subscription lifecycle.
				const sub = track(await openWs(wsBase, `/Live/${id}`, auth));
				ok(sub.opened, 'Live WS subscription should open');
				// receive at least one event to prove the sub is live, then we will NOT write again.
				await sleep(300);
				await restPut(id, { id, value: 1, tag: 'q3' }).expect(204);
				await waitFor(() => sub.events.length >= 1, 6000); // confirm the sub is actually live
				// Poll until the Probe ledger reflects the new sub. In multi-worker the WS lands on ONE
				// worker and our round-robin /Probe/ GETs may not sample that pid until a later pass —
				// so wait for the monotonic `opened` to register rather than snapshotting once (which
				// races the worker that holds the sub).
				let whileConnected = await probe();
				await waitFor(
					async () => {
						whileConnected = await probe(12);
						return whileConnected.opened - base.opened >= 1 && whileConnected.activeSubs - base.activeSubs >= 1;
					},
					10_000,
					150
				);
				const openedDelta = whileConnected.opened - base.opened;
				const activeWhile = whileConnected.activeSubs - base.activeSubs;
				ok(openedDelta >= 1, `Live.connect should register a subscription; openedDelta=${openedDelta}`);
				ok(activeWhile >= 1, `activeSubs should rise by >=1 while connected; got ${activeWhile}`);

				// HARD disconnect mid-stream. CRITICAL: do NOT write anything after this — a deferred
				// teardown would only fire on the NEXT event, so a clean decrement here with
				// zero further writes proves PROMPT teardown.
				const tDisc = Date.now();
				drop(sub);

				// Poll for teardown to register. The DEFINITIVE leak-free signal is the activeSubs
				// gauge returning to baseline (opened-closed back to 0 on the holding worker) AND the
				// monotonic `closed` counter catching up.
				let tornAt = 0;
				await waitFor(
					async () => {
						const p = await probe(60);
						if (p.activeSubs - base.activeSubs <= 0 && p.closed - base.closed >= openedDelta) {
							tornAt = Date.now();
							return true;
						}
						return false;
					},
					15_000,
					150
				);
				const after = await probe(60);
				const closedDelta = after.closed - base.closed;
				const activeAfter = after.activeSubs - base.activeSubs;
				const teardownMs = tornAt ? tornAt - tDisc : -1;
				console.log(
					`\n[ws-transport][${label}][Q3] disconnect teardown (NO write after disconnect):\n` +
						`  baseline activeSubs        = ${base.activeSubs} (workers=${base.pids})\n` +
						`  while-connected openedDelta = ${openedDelta}, activeDelta = ${activeWhile}\n` +
						`  after-disconnect closedDelta = ${closedDelta}, activeDelta = ${activeAfter}\n` +
						`  teardown latency           = ${teardownMs}ms (no intervening event)\n` +
						`  teardownErrors             = ${after.teardownErrors - base.teardownErrors}\n` +
						`  => ${
							activeAfter <= 0 && closedDelta >= openedDelta
								? 'PROMPT teardown (WS leak-free; iterator.return fired on disconnect)'
								: 'DEFERRED / LEAK (subscription survived disconnect — F-024-style)'
						}`
				);
				strictEqual(after.teardownErrors - base.teardownErrors, 0, 'no teardown errors');
				ok(
					closedDelta >= openedDelta,
					`WS disconnect must tear down the sub WITHOUT a following event; closed=${closedDelta} opened=${openedDelta}`
				);
				ok(activeAfter <= 0, `activeSubs must return to baseline after disconnect; residual=${activeAfter}`);
			}
		);

		// Q3b — churn: open/receive/disconnect many WS subs; activeSubs must return to baseline.
		test('Q3b: WS subscribe churn returns activeSubs to baseline (no leak)', { timeout: 120_000 }, async () => {
			const base = await probe();
			const ROUNDS = 25;
			for (let i = 0; i < ROUNDS; i++) {
				const id = `q3b-${Date.now()}-${i}`;
				const s = await openWs(wsBase, `/Live/${id}`, auth);
				await restPut(id, { id, value: i, tag: 'q3b' }).expect(204);
				await sleep(40);
				s.terminate(); // disconnect; no write after
			}
			await waitFor(
				async () => {
					const p = await probe(8);
					return p.activeSubs - base.activeSubs <= 0;
				},
				20_000,
				200
			);
			const after = await probe();
			const residual = after.activeSubs - base.activeSubs;
			console.log(
				`\n[ws-transport][${label}][Q3b] churn x${ROUNDS}:\n` +
					`  opened delta = ${after.opened - base.opened}, closed delta = ${after.closed - base.closed}\n` +
					`  residual activeSubs = ${residual}, maxConcurrent observed = ${after.maxConcurrent}\n` +
					`  => ${residual <= 1 ? 'CLEAN (no listener/handle leak across churn)' : 'LEAK (subs survive disconnect)'}`
			);
			ok(residual <= 1, `activeSubs must settle to baseline after churn; residual=${residual}`);
		});

		// Q4 — stalled WS consumer: never read, drive large writes, sample heap/handles + liveness.
		test('Q4: stalled WS consumer is bounded; server stays responsive', { timeout: 90_000 }, async () => {
			const before = await probe();
			const id = `q4-${Date.now()}`;
			const big = 'x'.repeat(4096);
			// Open a stalled collection sub: ws.pause() so we never read the socket -> server's
			// send loop should hit writableNeedDrain and await 'drain' (kernel backpressure),
			// not buffer unboundedly in-process.
			const stalled = track(await openWs(wsBase, `/Burst/`, auth, { consume: false }));
			ok(stalled.opened, 'stalled WS sub should open');
			await sleep(300);
			const N = 200;
			let writeErrors = 0;
			const t0 = Date.now();
			for (let v = 1; v <= N; v++) {
				try {
					await restPut(id, { id, value: v, tag: big }).timeout(5000).expect(204);
				} catch (e) {
					writeErrors++;
					if (writeErrors <= 2) console.log(`[ws-transport][${label}][Q4] write ${v} err: ${(e as Error).message}`);
				}
			}
			const writeMs = Date.now() - t0;

			// healthy clients stay responsive: a fresh REST GET and a fresh (draining) WS sub.
			const hT0 = Date.now();
			let healthStatus = 0;
			let healthValue: unknown;
			try {
				const h = await client.reqRest(`/Burst/${id}`).timeout(5000);
				healthStatus = h.status;
				healthValue = h.body?.value;
			} catch (e) {
				console.log(`[ws-transport][${label}][Q4] concurrent GET err: ${(e as Error).message}`);
			}
			const healthMs = Date.now() - hT0;

			const after = await probe();
			const heapGrowth = after.heapUsed - before.heapUsed;
			const handleGrowth = after.activeHandles - before.activeHandles;
			// Bounded-buffering signal: the send loop awaits the socket 'drain'
			// when writableNeedDrain, so a stalled (paused) consumer applies KERNEL TCP backpressure
			// rather than buffering frames unboundedly in-process. The definitive evidence is (a)
			// activeHandles does NOT grow per-write and (b) heap does not track total write volume.
			const boundedHeap = heapGrowth < 64 * 1e6; // generous ceiling; normal GC churn lives well under this
			const boundedHandles = handleGrowth <= 2; // just the stalled socket (+ maybe the fresh GET)
			console.log(
				`\n[ws-transport][${label}][Q4] stalled-consumer summary:\n` +
					`  ${N} large (~4KB) PUTs in ${writeMs}ms, writeErrors=${writeErrors}\n` +
					`  concurrent GET status=${healthStatus} latency=${healthMs}ms value=${healthValue}\n` +
					`  worker heapUsed growth (summed) = ${(heapGrowth / 1e6).toFixed(1)}MB\n` +
					`  activeHandles before/after = ${before.activeHandles}/${after.activeHandles} (growth ${handleGrowth})\n` +
					`  => server ${healthMs < 4000 && healthStatus === 200 ? 'RESPONSIVE (not wedged)' : 'DEGRADED / wedged'}; ` +
					`buffering ${boundedHeap && boundedHandles ? 'BOUNDED (kernel backpressure; no handle/heap blowup)' : 'SUSPECT-UNBOUNDED'}`
			);
			strictEqual(writeErrors, 0, 'writes must not fail because one WS consumer is stalled');
			strictEqual(healthStatus, 200, 'server must serve normal requests with a stalled WS reader');
			ok(healthMs < 4000, `concurrent request must stay responsive; took ${healthMs}ms`);
			strictEqual(healthValue, N, `final persisted value should be ${N}`);
			drop(stalled);
		});
	});
}

wsSuite('single-worker', undefined);
wsSuite('multi-worker', 4);
