/**
 * Post-merge compatibility coverage for https://github.com/HarperFast/harper/pull/2040
 * QA-895/P-634: simultaneous MQTT 3.1.1/5 x JSON/CBOR x QoS 0/1 subscribers.
 * One worker keeps all eight clients on the same worker-local encoding cache.
 * Checks negotiated payload bytes, parsed PUBLISH framing and session packet IDs;
 * repeats rapid version turnover and abrupt sibling disconnect races ten times each.
 * Publishes await QoS 1 acknowledgements to establish order, without awaiting
 * subscriber delivery between versions (concurrent transactions can commit out of order).
 * QoS 0 may coalesce intermediate versions: require nonempty, increasing deliveries
 * ending at the terminal value, not lossless bursts. A subsequent delivery is the
 * observation barrier; no arbitrary settle sleep is used.
 * Non-retained table messages have fresh identities/versions. This does not force
 * same-object version invalidation, timer/budget generation rotation, or prove cache
 * hit counts. Disconnect timing races delivery, not a deterministic server write.
 * WebSocket transport only; Bun and Windows are excluded.
 */
import { suite, test, before, after } from 'node:test';
import assert from 'node:assert';
import { setTimeout as sleep } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import mqtt, { type IClientOptions, type MqttClient } from 'mqtt';
import { decode as decodeCbor } from 'cbor-x';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
import { createApiClient } from '../apiTests/utils/client.mjs';

const FIXTURE_PATH = resolve(import.meta.dirname, 'fixtures/shared-encoding-cross-product');
const TOPIC = 'Probe/probe1';
const REPETITIONS = 10;
const BURST = 25;
interface Combo {
	protocolVersion: 4 | 5;
	contentType: 'application/json' | 'application/cbor';
	qos: 0 | 1;
}
interface Packet {
	payload: Buffer;
	qos: number;
	messageId?: number;
	topic: string;
}
interface Subscriber {
	combo: Combo;
	client: MqttClient;
	packets: Packet[];
}
const combos: Combo[] = [];
for (const protocolVersion of [4, 5] as const) {
	for (const contentType of ['application/json', 'application/cbor'] as const) {
		// Seed payload reuse before the QoS 0 subscriber can retain its frame.
		for (const qos of [1, 0] as const) combos.push({ protocolVersion, contentType, qos });
	}
}
function decode(sub: Subscriber, packet: Packet) {
	return sub.combo.contentType === 'application/cbor'
		? decodeCbor(packet.payload)
		: JSON.parse(packet.payload.toString());
}

suite(
	'MQTT shared encoding cross product (QA-895/P-634)',
	{
		timeout: 120_000,
		skip: process.env.HARPER_RUNTIME === 'bun' || process.platform === 'win32',
	},
	(ctx: ContextWithHarper) => {
		let url: string;
		let publisher: MqttClient;
		const clients = new Set<MqttClient>();
		const runtimeErrors: string[] = [];

		function assertHealthy() {
			assert.deepStrictEqual(runtimeErrors, [], 'MQTT runtime errors');
		}
		async function waitFor(predicate: () => boolean, label: string) {
			const deadline = Date.now() + 10_000;
			while (Date.now() < deadline) {
				assertHealthy();
				if (predicate()) return;
				await sleep(20);
			}
			assert.fail(`Timed out: ${label}`);
		}
		async function connect(options: Partial<IClientOptions> = {}) {
			const client = mqtt.connect(url, {
				protocolVersion: 5,
				reconnectPeriod: 0,
				connectTimeout: 8000,
				clean: true,
				clientId: randomUUID(),
				username: ctx.harper.admin.username,
				password: ctx.harper.admin.password,
				...options,
			});
			clients.add(client);
			client.on('error', (error) => runtimeErrors.push(`${client.options.clientId}: ${error.message}`));
			await new Promise<void>((resolvePromise, reject) => {
				const timer = setTimeout(() => finish(new Error('MQTT connect timed out')), 9000);
				function finish(error?: Error) {
					clearTimeout(timer);
					client.removeListener('connect', onConnect);
					client.removeListener('error', onError);
					if (error) reject(error);
					else resolvePromise();
				}
				const onConnect = () => finish();
				const onError = (error: Error) => finish(error);
				client.once('connect', onConnect);
				client.once('error', onError);
			});
			return client;
		}
		async function close(client: MqttClient) {
			await new Promise<void>((resolvePromise) => client.end(true, {}, resolvePromise));
			clients.delete(client);
		}
		async function makeSub(combo: Combo): Promise<Subscriber> {
			const client = await connect({
				protocolVersion: combo.protocolVersion,
				wsOptions: { headers: { accept: combo.contentType } },
			});
			const sub: Subscriber = { combo, client, packets: [] };
			client.on('message', (topic, payload, packet) =>
				sub.packets.push({
					topic,
					payload: Buffer.from(payload),
					qos: packet.qos,
					messageId: packet.messageId,
				})
			);
			const grants = await client.subscribeAsync(TOPIC, { qos: combo.qos });
			assert.strictEqual(grants.length, 1);
			assert.strictEqual(grants[0].topic, TOPIC);
			assert.strictEqual(grants[0].qos, combo.qos, `SUBACK ${JSON.stringify(combo)}`);
			return sub;
		}
		async function publish(marker: string, seq: number) {
			await publisher.publishAsync(TOPIC, JSON.stringify({ marker, seq }), { qos: 1, retain: false });
		}
		async function terminal(subs: Subscriber[], marker: string, seq: number) {
			await waitFor(
				() =>
					subs.every((sub) =>
						sub.packets.some((packet) => {
							const value = decode(sub, packet);
							return value.marker === marker && value.seq === seq;
						})
					),
				`all ${subs.length} subscribers receive ${marker}/${seq}`
			);
		}
		function validate(subs: Subscriber[], marker: string, last: number) {
			assertHealthy();
			for (const sub of subs) {
				const label = JSON.stringify(sub.combo);
				assert.ok(sub.packets.length > 0, `${label}: nonempty delivery`);
				let previous = 0;
				const ids = new Set<number>();
				for (const packet of sub.packets) {
					assert.strictEqual(packet.topic, TOPIC, label);
					assert.strictEqual(packet.qos, sub.combo.qos, label);
					assert.ok(packet.payload.length > 0, label);
					const value = decode(sub, packet);
					assert.strictEqual(value.marker, marker, label);
					assert.ok(
						Number.isInteger(value.seq) && value.seq > previous && value.seq <= last,
						`${label}: invalid sequence ${previous} -> ${value.seq}`
					);
					previous = value.seq;
					if (sub.combo.qos === 1) {
						assert.ok(Number.isInteger(packet.messageId) && packet.messageId! > 0 && packet.messageId! <= 65535, label);
						// These short sessions never wrap; IDs are compared only within this session.
						assert.ok(!ids.has(packet.messageId!), `${label}: repeated session message ID`);
						ids.add(packet.messageId!);
					} else assert.strictEqual(packet.messageId, undefined, label);
				}
				assert.strictEqual(previous, last, `${label}: terminal delivery`);
			}
		}
		async function withPopulation(run: (subs: Subscriber[]) => Promise<void>) {
			const subs: Subscriber[] = [];
			try {
				for (const combo of combos) subs.push(await makeSub(combo));
				await run(subs);
			} finally {
				// Includes clients whose connect or subscribe failed before makeSub returned.
				await Promise.all([...clients].filter((client) => client !== publisher).map(close));
			}
			assertHealthy();
		}
		before(async () => {
			await setupHarperWithFixture(ctx, FIXTURE_PATH, { config: { threads: { count: 1 } }, env: {} });
			url = `${ctx.harper.httpURL.replace(/^http/, 'ws')}/mqtt`;
			const api = createApiClient(ctx.harper);
			const deadline = Date.now() + 30_000;
			let ready = false;
			let lastResponse = '';
			while (Date.now() < deadline && !ready) {
				try {
					const response = await api.reqRest('/Ready/').timeout(2000);
					lastResponse = `${response.status} ${JSON.stringify(response.body)}`;
					ready = response.status === 200 && response.body.ok === true;
				} catch (error) {
					lastResponse = String(error);
				}
				if (!ready) await sleep(100);
			}
			assert.ok(ready, `Fixture readiness failed: ${lastResponse}`);
			publisher = await connect();
		});
		after(async () => {
			try {
				await Promise.all([...clients].map(close));
			} finally {
				await teardownHarper(ctx);
			}
			assertHealthy();
		});
		test('all eight simultaneous combinations receive their negotiated bytes and framing', async () => {
			await withPopulation(async (subs) => {
				const marker = randomUUID();
				await publish(marker, 1);
				await terminal(subs, marker, 1);
				validate(subs, marker, 1);
				const copied = subs.map((sub) => ({ ...sub, packets: sub.packets.map((packet) => ({ ...packet })) }));
				validate(copied, marker, 1);
				const qos1 = copied.find((sub) => sub.combo.qos === 1)!;
				qos1.packets[0].qos = 0;
				assert.throws(
					() => validate(copied, marker, 1),
					(error: Error) => error instanceof assert.AssertionError && error.actual === 0 && error.expected === 1,
					'the observed-packet oracle must reject a QoS 1 delivery changed to QoS 0'
				);
				for (const type of ['application/json', 'application/cbor']) {
					const sameCodec = subs.filter((sub) => sub.combo.contentType === type);
					for (const sub of sameCodec) assert.deepStrictEqual(sub.packets[0].payload, sameCodec[0].packets[0].payload);
				}
				assert.notDeepStrictEqual(subs[0].packets[0].payload, subs[2].packets[0].payload);
			});
		});
		for (const disconnect of [false, true]) {
			test(`${disconnect ? 'abrupt sibling disconnect' : 'rapid version turnover'}: ${REPETITIONS} repetitions`, async (t) => {
				for (let repetition = 0; repetition < REPETITIONS; repetition++) {
					await withPopulation(async (subs) => {
						const marker = randomUUID();
						let victim: MqttClient | undefined;
						let victimClosed = false;
						if (disconnect) {
							victim = (await makeSub(combos[repetition % combos.length])).client;
							// Trigger on a real first delivery while the burst is being drained.
							victim.once('close', () => {
								victimClosed = true;
							});
							victim.once('message', () => {
								victim!.stream.destroy();
							});
						}
						for (let seq = 1; seq <= BURST; seq++) await publish(marker, seq);
						await terminal(subs, marker, BURST);
						if (victim) await waitFor(() => victimClosed, 'abrupt sibling close');
						await publish(marker, BURST + 1);
						await terminal(subs, marker, BURST + 1);
						validate(subs, marker, BURST + 1);
						t.diagnostic(
							`repetition ${repetition + 1}: 8 subscribers; deliveries ${subs.map((sub) => sub.packets.length).join(',')}`
						);
					});
				}
			});
		}
	}
);
