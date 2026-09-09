/**
 * Promoted from qa-explorer (QA-681 / P-460): pins Harper's MQTT shared-subscription (`$share`)
 * contract and the ordinary fan-out invariants a client would otherwise reach for it to get.
 *
 * Harper implements no `$share` parsing. `SubscriptionsSession.addSubscription()` hands the whole
 * topic string, literal `$share/<group>/` prefix included, to `resources.getMatch(path, 'mqtt')`;
 * `$share` is never a table, so the lookup misses, addSubscription() throws a 404, and
 * server/mqtt.ts maps it to SUBACK reason 0x8f on MQTT v5 and 0x80 on v3.1.1.
 *
 * The subscription is REFUSED, not accepted as an inert filter. Were `$share` ever silently
 * accepted, subscribers would begin receiving the FULL fan-out where the application expected each
 * message to reach exactly one worker; both the refusal and the absence of delivery are asserted,
 * so either drift fails this file.
 *
 * On a rejected SUBACK mqtt.js's `granted` callback argument echoes the client's own request rather
 * than the broker's grant, so the reason code is read from `err.packet.granted`. Reading `granted`
 * there turns a correct refusal into a fabricated "silently accepted" result.
 *
 * Run:
 *   npm run test:integration -- "integrationTests/mqtt/qa681-mqtt-shared-subscriptions.test.ts"
 */
import { suite, test, before, after } from 'node:test';
import { ok, strictEqual } from 'node:assert';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

import mqtt, { type IClientOptions, type MqttClient } from 'mqtt';

import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
// @ts-expect-error utils/client.mjs has no type declarations; runtime resolves fine
import { createApiClient } from '../apiTests/utils/client.mjs';
// @ts-expect-error lifecycle.mjs has no type declarations; runtime resolves fine
import { waitForRouteReady } from '../apiTests/utils/lifecycle.mjs';

const FIXTURE_PATH = resolve(import.meta.dirname, 'qa681-mqtt-shared-subscriptions');

// mqtt.js's WebSocket transport doesn't complete CONNACK on Bun — the same skip the sibling MQTT
// suites carry.
const skipSuite = process.env.HARPER_RUNTIME === 'bun' || process.platform === 'win32';

const STREAM_TOPIC = 'Events/stream';
const Q3_TOPIC = 'Events/q3stream';
const Q3_SHARE_TOPIC = `$share/g1/${Q3_TOPIC}`;
const QOS1_TOPIC = 'Events/qos1stream';
const SHARE_TOPIC = '$share/g1/Events/stream';
const SUBACK_TOPIC_FILTER_INVALID = 0x8f; // MQTT v5
const SUBACK_UNSPECIFIED_FAILURE = 0x80; // MQTT v3.1.1's only failure code

suite('QA-681 MQTT shared-subscription ($share) semantics', { skip: skipSuite }, (ctx: ContextWithHarper) => {
	let client: ReturnType<typeof createApiClient>;
	let mqttURL = '';
	let mqttUsable = false;
	let mqttSkipReason = '';

	function baseOpts(overrides: Partial<IClientOptions> = {}): IClientOptions {
		return {
			protocolVersion: 5,
			reconnectPeriod: 0,
			connectTimeout: 8_000,
			clean: true,
			username: ctx.harper.admin.username,
			password: ctx.harper.admin.password,
			...overrides,
		};
	}

	/** `collector`, when given, is attached synchronously at client creation — before CONNACK. A
	 *  resuming durable session replays its backlog the moment the connection is accepted, and
	 *  mqtt.js delivers and acknowledges those PUBLISHes before the continuation of an awaited
	 *  connect() could install a listener, so a listener added afterwards silently misses them. */
	function connect(
		url: string,
		opts: IClientOptions,
		collector?: (topic: string, payload: Buffer) => void
	): Promise<MqttClient> {
		return new Promise((resolvePromise, reject) => {
			const mqttClient = mqtt.connect(url, opts);
			if (collector) mqttClient.on('message', collector);
			let timer: ReturnType<typeof setTimeout>;
			const onError = (err: Error) => {
				clearTimeout(timer);
				mqttClient.removeListener('connect', onConnect);
				mqttClient.end(true);
				reject(err);
			};
			const onConnect = () => {
				clearTimeout(timer);
				mqttClient.removeListener('error', onError);
				mqttClient.on('error', () => {});
				resolvePromise(mqttClient);
			};
			// Remove only this helper's own listeners on timeout. removeAllListeners() would also
			// strip mqtt.js's internal socket-teardown handlers, which can leave end(true) stalled
			// and hang the runner rather than failing it.
			timer = setTimeout(() => {
				mqttClient.removeListener('error', onError);
				mqttClient.removeListener('connect', onConnect);
				mqttClient.on('error', () => {});
				mqttClient.end(true);
				reject(new Error(`mqtt connect timed out for clientId=${opts.clientId}`));
			}, 10_000);
			mqttClient.once('error', onError);
			mqttClient.once('connect', onConnect);
		});
	}

	interface SubAckResult {
		granted?: any[];
		err?: string;
		/** The broker's real reason code. mqtt.js's ack handler computes `err.code` from the wire
		 *  packet, but the top-level subscribe() callback re-wraps it as an `ErrorWithSubackPacket`
		 *  which drops `.code` and keeps `.packet` — whose `.granted` holds the reason-code bytes.
		 *  The callback's own `granted` argument is the client's echoed REQUEST on a rejection, so
		 *  it must never be the source of this value. */
		code?: number;
	}
	function subscribe(
		mqttClient: MqttClient,
		topic: string,
		qos: 0 | 1 | 2 = 1,
		timeoutMs = 8_000
	): Promise<SubAckResult> {
		return new Promise((resolvePromise, reject) => {
			const timer = setTimeout(() => reject(new Error(`subscribe timed out for ${topic}`)), timeoutMs);
			mqttClient.subscribe(topic, { qos }, (err, granted) => {
				clearTimeout(timer);
				const rawGranted = (err as any)?.packet?.granted;
				resolvePromise({
					granted: granted?.map((g: any) => g.qos ?? g),
					err: err ? String(err.message ?? err) : undefined,
					code: (err as any)?.code ?? (Array.isArray(rawGranted) ? rawGranted[0] : undefined),
				});
			});
		});
	}

	function publish(mqttClient: MqttClient, topic: string, payload: string, opts: object = {}): Promise<void> {
		return new Promise((resolvePromise, reject) => {
			mqttClient.publish(topic, payload, { qos: 1, retain: false, ...opts }, (err) =>
				err ? reject(err) : resolvePromise()
			);
		});
	}

	function endQuiet(mqttClient: MqttClient | undefined): Promise<void> {
		return new Promise((resolvePromise) => {
			if (!mqttClient) return resolvePromise();
			const timer = setTimeout(() => resolvePromise(), 3_000);
			mqttClient.end(true, {}, () => {
				clearTimeout(timer);
				resolvePromise();
			});
		});
	}

	interface CollectedMessage {
		topic: string;
		payload: string;
	}
	function collectMessages(mqttClient: MqttClient) {
		const messages: CollectedMessage[] = [];
		const handler = (topic: string, payload: Buffer) => {
			messages.push({ topic, payload: payload.toString() });
		};
		mqttClient.on('message', handler);
		return { messages, stop: () => mqttClient.removeListener('message', handler) };
	}

	async function waitFor(predicate: () => boolean, timeoutMs = 6_000, intervalMs = 30): Promise<boolean> {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			if (predicate()) return true;
			await sleep(intervalMs);
		}
		return predicate();
	}

	function payloadSeq(p: string): number | undefined {
		try {
			const parsed = JSON.parse(p);
			if (parsed && typeof parsed === 'object' && 'seq' in parsed) return (parsed as any).seq;
		} catch {
			/* a non-JSON payload is not one of ours; the caller's count assertions catch the shortfall */
		}
		return undefined;
	}

	const seqsOf = (collected: { messages: CollectedMessage[] }): number[] =>
		collected.messages.map((m) => payloadSeq(m.payload)).filter((v): v is number => typeof v === 'number');

	/** Fail rather than silently skip when the harness could not reach MQTT at all: an arm that
	 *  reports a green verdict without having run its probes is exactly the vacuous coverage a
	 *  regression anchor exists to prevent. */
	function requireMqtt() {
		ok(mqttUsable, `MQTT is unusable, so this arm proved nothing: ${mqttSkipReason}`);
	}

	before(async () => {
		await setupHarperWithFixture(ctx, FIXTURE_PATH, { config: {}, env: {} });
		client = createApiClient(ctx.harper);
		const httpURL = ctx.harper.httpURL;
		const wsScheme = httpURL.startsWith('https') ? 'wss' : 'ws';
		mqttURL = `${httpURL.replace(/^https?/, wsScheme)}/mqtt`;

		await waitForRouteReady(client, '/Events/', 120_000);

		try {
			const probe = await connect(mqttURL, baseOpts({ clientId: 'qa681-probe' }));
			mqttUsable = probe.connected === true;
			if (!mqttUsable) mqttSkipReason = `MQTT client connected=false on ${mqttURL}`;
			await endQuiet(probe);
		} catch (err) {
			mqttUsable = false;
			mqttSkipReason = `MQTT connect probe failed on ${mqttURL}: ${(err as Error)?.message}`;
		}
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	test('Q1 (control): ordinary subscribers get complete, duplicate-free fan-out', { timeout: 30_000 }, async () => {
		requireMqtt();
		const M = 20;
		let pub: MqttClient | undefined;
		let subA: MqttClient | undefined;
		let subB: MqttClient | undefined;
		try {
			pub = await connect(mqttURL, baseOpts({ clientId: 'qa681-q1-pub' }));
			subA = await connect(mqttURL, baseOpts({ clientId: 'qa681-q1-a' }));
			subB = await connect(mqttURL, baseOpts({ clientId: 'qa681-q1-b' }));
			await subscribe(subA, STREAM_TOPIC, 1);
			await subscribe(subB, STREAM_TOPIC, 1);
			const cA = collectMessages(subA);
			const cB = collectMessages(subB);

			for (let seq = 0; seq < M; seq++) {
				await publish(pub, STREAM_TOPIC, JSON.stringify({ seq, tag: 'q1' }));
			}
			await waitFor(() => cA.messages.length >= M && cB.messages.length >= M, 10_000);
			await sleep(500); // so a duplicate just behind the Mth message still lands in the count
			cA.stop();
			cB.stop();

			const seqsA = seqsOf(cA);
			const seqsB = seqsOf(cB);
			console.log(`[QA-681][Q1] ordinary fan-out: A recv=${seqsA.length} B recv=${seqsB.length} (published=${M})`);
			strictEqual(seqsA.length, M, `ordinary subscriber A should get every one of ${M} messages (true fan-out)`);
			strictEqual(seqsB.length, M, `ordinary subscriber B should get every one of ${M} messages (true fan-out)`);
			strictEqual(new Set(seqsA).size, M, 'no duplicates for A');
			strictEqual(new Set(seqsB).size, M, 'no duplicates for B');
		} finally {
			await endQuiet(pub);
			await endQuiet(subA);
			await endQuiet(subB);
		}
	});

	test('Q2: $share subscriptions are refused with an explicit SUBACK reason code', { timeout: 30_000 }, async () => {
		requireMqtt();

		const clientsV5: MqttClient[] = [];
		const resultsV5: SubAckResult[] = [];
		try {
			for (let i = 0; i < 4; i++) {
				const c = await connect(mqttURL, baseOpts({ clientId: `qa681-q2-v5-${i}` }));
				clientsV5.push(c);
				resultsV5.push(await subscribe(c, SHARE_TOPIC, 1));
			}
		} finally {
			for (const c of clientsV5) await endQuiet(c);
		}
		console.log(`[QA-681][Q2] v5 SUBACK results for ${SHARE_TOPIC} (4 clients): ${JSON.stringify(resultsV5)}`);
		strictEqual(resultsV5.length, 4, 'all four v5 clients must have produced a SUBACK result');
		for (const [i, r] of resultsV5.entries()) {
			strictEqual(
				r.code,
				SUBACK_TOPIC_FILTER_INVALID,
				`client ${i}: expected reason 0x8f (Topic Filter invalid) — $share must be REFUSED, not accepted as an ordinary filter — got ${JSON.stringify(r)}`
			);
		}

		const clientV3 = await connect(mqttURL, baseOpts({ clientId: 'qa681-q2-v3', protocolVersion: 4 }));
		try {
			const resV3 = await subscribe(clientV3, SHARE_TOPIC, 1);
			console.log(`[QA-681][Q2] v3.1.1 SUBACK result: ${JSON.stringify(resV3)}`);
			strictEqual(
				resV3.code,
				SUBACK_UNSPECIFIED_FAILURE,
				`v3.1.1 expected refusal reason 0x80, got ${JSON.stringify(resV3)}`
			);
		} finally {
			await endQuiet(clientV3);
		}
	});

	test(
		'Q3: a refused $share subscriber receives nothing and does not disturb an ordinary one',
		{ timeout: 30_000 },
		async () => {
			requireMqtt();
			const M = 15;
			const groupClients: MqttClient[] = [];
			const groupCollectors: ReturnType<typeof collectMessages>[] = [];
			let pub: MqttClient | undefined;
			let ordinary: MqttClient | undefined;
			try {
				pub = await connect(mqttURL, baseOpts({ clientId: 'qa681-q3-pub' }));
				ordinary = await connect(mqttURL, baseOpts({ clientId: 'qa681-q3-ordinary' }));
				// Delivery is deliberately not gated on the SUBACK: this is the fire-and-forget client.
				const groupSubAcks: SubAckResult[] = [];
				for (let i = 0; i < 4; i++) {
					const c = await connect(mqttURL, baseOpts({ clientId: `qa681-q3-group-${i}` }));
					groupClients.push(c);
					groupSubAcks.push(await subscribe(c, Q3_SHARE_TOPIC, 1));
					groupCollectors.push(collectMessages(c));
				}
				await subscribe(ordinary, Q3_TOPIC, 1);
				const ordinaryObs = collectMessages(ordinary);

				for (let seq = 0; seq < M; seq++) {
					await publish(pub, Q3_TOPIC, JSON.stringify({ seq, tag: 'q3' }));
				}
				await waitFor(() => ordinaryObs.messages.length >= M, 8_000);
				await sleep(800); // only elapsed time can evidence the absence asserted below
				ordinaryObs.stop();
				groupCollectors.forEach((c) => c.stop());

				const ordinarySeqs = seqsOf(ordinaryObs);
				const groupCounts = groupCollectors.map((c) => c.messages.length);
				console.log(
					`[QA-681][Q3] ordinary recv=${ordinarySeqs.length}/${M}; refused-client recv counts=${JSON.stringify(groupCounts)}`
				);

				// The zeros must come from a refusal, not from a subscribe that timed out: same zero,
				// different reason.
				for (const [i, r] of groupSubAcks.entries())
					strictEqual(
						r.code,
						SUBACK_TOPIC_FILTER_INVALID,
						`$share client ${i} must have been refused, not merely unsubscribed: ${JSON.stringify(r)}`
					);
				strictEqual(ordinarySeqs.length, M, "ordinary subscriber unaffected by neighbours' refused $share subscribes");
				strictEqual(new Set(ordinarySeqs).size, M, 'ordinary subscriber sees no duplicates');
				for (const [i, n] of groupCounts.entries())
					strictEqual(n, 0, `$share client ${i} must receive ZERO messages — neither load-balanced nor fanned out`);
			} finally {
				await endQuiet(pub);
				await endQuiet(ordinary);
				for (const c of groupClients) await endQuiet(c);
			}
		}
	);

	test(
		'Q4: QoS1 mid-stream disconnect — no cross-client redistribution, and the durable session loses nothing',
		{ timeout: 40_000 },
		async () => {
			requireMqtt();
			const N = 30;
			const dropAt = 15;
			const dropClientId = `qa681-q4-drop-${randomUUID().slice(0, 6)}`;

			let pub: MqttClient | undefined;
			let survivorA: MqttClient | undefined;
			let survivorC: MqttClient | undefined;
			let dropClient: MqttClient | undefined;
			try {
				pub = await connect(mqttURL, baseOpts({ clientId: 'qa681-q4-pub' }));
				survivorA = await connect(mqttURL, baseOpts({ clientId: 'qa681-q4-a' }));
				survivorC = await connect(mqttURL, baseOpts({ clientId: 'qa681-q4-c' }));
				await subscribe(survivorA, QOS1_TOPIC, 1);
				await subscribe(survivorC, QOS1_TOPIC, 1);
				// clean:false plus a stable clientId, so "lost forever" is distinguishable from
				// "redelivered to itself" after the resume.
				dropClient = await connect(mqttURL, baseOpts({ clientId: dropClientId, clean: false }));
				await subscribe(dropClient, QOS1_TOPIC, 1);

				const cA = collectMessages(survivorA);
				const cC = collectMessages(survivorC);
				const beforeDrop = collectMessages(dropClient);

				for (let seq = 0; seq < N; seq++) {
					await publish(pub, QOS1_TOPIC, JSON.stringify({ seq, tag: 'q4' }), { qos: 1 });
					if (seq === dropAt - 1) {
						await sleep(150); // let in-flight qos1 delivery to dropClient settle first
						// Destroy the transport with no MQTT DISCONNECT: a crashed member, not a clean
						// unsubscribe, which is what leaves the durable session with a backlog to resume.
						(dropClient as any).stream?.destroy?.();
						dropClient.end(true);
						// Converge on the socket actually being down before publishing past the drop
						// point; otherwise seq 15 can still reach the old session and the boundary
						// assertion below fails on a run that behaved correctly.
						await waitFor(() => dropClient?.connected !== true, 5_000);
					}
				}
				await waitFor(() => cA.messages.length >= N && cC.messages.length >= N, 12_000);
				await sleep(800); // so a redistributed extra copy would be counted, not missed
				cA.stop();
				cC.stop();
				beforeDrop.stop();

				const seqsA = seqsOf(cA);
				const seqsC = seqsOf(cC);
				const deliveredBeforeDrop = new Set(seqsOf(beforeDrop));

				console.log(
					`[QA-681][Q4] drop after seq=${dropAt - 1}: survivorA recv=${seqsA.length}/${N} ` +
						`survivorC recv=${seqsC.length}/${N} dropClient recv-before-drop=${deliveredBeforeDrop.size}`
				);
				strictEqual(
					seqsA.length,
					N,
					`survivor A should get exactly ${N} (no redistribution of the dropped client's messages)`
				);
				strictEqual(
					seqsC.length,
					N,
					`survivor C should get exactly ${N} (no redistribution of the dropped client's messages)`
				);
				strictEqual(new Set(seqsA).size, N, 'no duplicates for survivor A');
				strictEqual(new Set(seqsC).size, N, 'no duplicates for survivor C');

				// The drop must genuinely have cut delivery. Without this, a run where the transport
				// destroy failed leaves deliveredBeforeDrop holding all N, and the coverage poll below
				// is satisfied before the session ever resumes — so a broken clean:false resume would
				// pass. Which messages landed first is scheduler-dependent; that none published after
				// the drop did is not, and that is what is asserted.
				ok(
					[...deliveredBeforeDrop].every((seq) => seq < dropAt),
					`the dropped client must have received nothing published after the drop, got ${JSON.stringify([...deliveredBeforeDrop].sort((a, b) => a - b))}`
				);

				const resumedMessages: CollectedMessage[] = [];
				const resumed = await connect(mqttURL, baseOpts({ clientId: dropClientId, clean: false }), (topic, payload) =>
					resumedMessages.push({ topic, payload: payload.toString() })
				);
				try {
					// Poll on COVERAGE, not on a count. QoS-1 is at-least-once, so a resume may replay a
					// message that was unacked when the transport died; counting deliveries would then
					// reach the expected total while a later sequence is still in flight, and the run
					// would fail a session that recovers everything.
					const allSeqs = Array.from({ length: N }, (_, seq) => seq);
					const seenSoFar = () => new Set([...deliveredBeforeDrop, ...seqsOf({ messages: resumedMessages })]);
					const recovered = await waitFor(() => allSeqs.every((seq) => seenSoFar().has(seq)), 10_000);
					const resumedSeqs = seqsOf({ messages: resumedMessages });
					console.log(
						`[QA-681][Q4] resumed same-clientId session recv=${resumedSeqs.length} ` +
							`(missed ${N - deliveredBeforeDrop.size}): ${JSON.stringify(resumedSeqs)}`
					);

					const seen = seenSoFar();
					ok(
						recovered,
						`the durable session must lose nothing across the drop; never delivered seq ${JSON.stringify(allSeqs.filter((seq) => !seen.has(seq)))}`
					);
					ok(
						resumedSeqs.every((seq) => seq >= 0 && seq < N),
						`the resumed session must only receive this run's messages, got ${JSON.stringify(resumedSeqs)}`
					);
				} finally {
					await endQuiet(resumed);
				}
			} finally {
				await endQuiet(pub);
				await endQuiet(survivorA);
				await endQuiet(survivorC);
				await endQuiet(dropClient);
			}
		}
	);
});
