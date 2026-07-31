'use strict';

const assert = require('node:assert');
const testUtils = require('../../testUtils.js');
testUtils.preTestPrep();

const { generate } = require('mqtt-packet');
const { WebSocketServer } = require('ws');
const WebSocket = require('ws');

const { contentTypes, asyncSerialization } = require('#src/server/serverHelpers/contentTypes');
const { getSharedMessageEncoding, getSharedFrame } = require('#src/server/serverHelpers/sharedMessageEncoding');

// Content types registered only for these tests, so serializer invocations can be counted exactly.
// The registered serializer function is what getSharedMessageEncoding keys on.
const COUNTED_TYPE = 'application/x-shared-encoding-counted';
const ALT_TYPE = 'application/x-shared-encoding-alt';
const ASYNC_TYPE = 'application/x-shared-encoding-async';

let countedCalls;
let altCalls;

before(function () {
	contentTypes.set(COUNTED_TYPE, {
		serialize(message) {
			countedCalls++;
			return Buffer.from('counted:' + JSON.stringify(message));
		},
		q: 1,
	});
	contentTypes.set(ALT_TYPE, {
		serialize(message) {
			altCalls++;
			return Buffer.from('alt:' + JSON.stringify(message));
		},
		q: 1,
	});
});

after(function () {
	contentTypes.delete(COUNTED_TYPE);
	contentTypes.delete(ALT_TYPE);
	contentTypes.delete(ASYNC_TYPE);
});

beforeEach(function () {
	countedCalls = 0;
	altCalls = 0;
});

// A subscriber's connection-level request; findBestSerializer only ever reads the Accept header.
function subscriberRequest(accept) {
	return { headers: { accept } };
}

describe('sharedMessageEncoding – payload sharing', function () {
	it('serializes once for two subscribers negotiating the same content type', function () {
		const message = { id: 1, temperature: 21.5 };

		const first = getSharedMessageEncoding(message, subscriberRequest(COUNTED_TYPE));
		const second = getSharedMessageEncoding(message, subscriberRequest(COUNTED_TYPE));

		assert.strictEqual(countedCalls, 1, 'the message should be serialized exactly once for both subscribers');
		assert.strictEqual(first, second, 'both subscribers should get the same encoding');
		assert.strictEqual(first.payload, second.payload, 'both subscribers should get the same payload buffer');
		assert.strictEqual(first.payload.toString(), 'counted:{"id":1,"temperature":21.5}');
	});

	it('gives subscribers negotiating different content types their own correct payloads', function () {
		const message = { id: 2, status: 'ok' };

		const counted = getSharedMessageEncoding(message, subscriberRequest(COUNTED_TYPE));
		const alt = getSharedMessageEncoding(message, subscriberRequest(ALT_TYPE));

		assert.strictEqual(countedCalls, 1);
		assert.strictEqual(altCalls, 1);
		assert.notStrictEqual(counted.payload, alt.payload);
		assert.strictEqual(counted.payload.toString(), 'counted:{"id":2,"status":"ok"}');
		assert.strictEqual(alt.payload.toString(), 'alt:{"id":2,"status":"ok"}');
	});

	it('does not share across distinct messages', function () {
		const request = subscriberRequest(COUNTED_TYPE);

		const first = getSharedMessageEncoding({ id: 3 }, request);
		const second = getSharedMessageEncoding({ id: 4 }, request);

		assert.strictEqual(countedCalls, 2);
		assert.notStrictEqual(first.payload, second.payload);
		assert.strictEqual(first.payload.toString(), 'counted:{"id":3}');
		assert.strictEqual(second.payload.toString(), 'counted:{"id":4}');
	});

	it('serializes a late subscriber against the same shared encoding', function () {
		const message = { id: 5 };
		const request = subscriberRequest(COUNTED_TYPE);

		const early = getSharedMessageEncoding(message, request);
		getSharedMessageEncoding(message, request);
		const late = getSharedMessageEncoding(message, request);

		assert.strictEqual(countedCalls, 1);
		assert.strictEqual(late.payload, early.payload);
	});

	it('falls back to per-subscriber serialization for a primitive message', function () {
		const request = subscriberRequest(COUNTED_TYPE);

		const first = getSharedMessageEncoding('a string message', request);
		const second = getSharedMessageEncoding('a string message', request);

		// primitives can not key a WeakMap, so they are simply not shared — still correct, just not memoized
		assert.strictEqual(countedCalls, 2);
		assert.strictEqual(first.payload.toString(), 'counted:"a string message"');
		assert.strictEqual(second.payload.toString(), 'counted:"a string message"');
	});

	it('serializes to JSON, once, when there is no request (raw TCP MQTT)', function () {
		const message = { id: 6, name: 'sensor' };

		const first = getSharedMessageEncoding(message, null);
		const second = getSharedMessageEncoding(message, undefined);

		assert.strictEqual(first, second, 'requestless subscribers all share the default JSON serializer');
		assert.strictEqual(first.payload, '{"id":6,"name":"sensor"}');
	});

	it('collapses an async serialization into one shared resolved payload', async function () {
		let asyncCalls = 0;
		let ready = false;
		contentTypes.set(ASYNC_TYPE, {
			serialize(message) {
				asyncCalls++;
				if (!ready) {
					asyncSerialization(Promise.resolve().then(() => (ready = true)));
					return undefined;
				}
				return Buffer.from('async:' + JSON.stringify(message));
			},
			q: 1,
		});
		const message = { id: 7 };

		const first = getSharedMessageEncoding(message, subscriberRequest(ASYNC_TYPE));
		const second = getSharedMessageEncoding(message, subscriberRequest(ASYNC_TYPE));

		assert.strictEqual(first, second);
		assert.strictEqual(typeof first.payload.then, 'function', 'the pending serialization is shared, not re-entered');
		const resolved = await first.payload;
		assert.strictEqual(resolved.toString(), 'async:{"id":7}');
		// the resolved buffer replaces the promise in place, so subscribers arriving after it settles
		// take the synchronous path
		assert.strictEqual(getSharedMessageEncoding(message, subscriberRequest(ASYNC_TYPE)).payload, resolved);
		// two attempts (the initial one that requested async work, and the retry), never four
		assert.strictEqual(asyncCalls, 2);
	});
});

describe('sharedMessageEncoding – frame sharing', function () {
	it('generates a frame once per key and reuses it', function () {
		const encoding = getSharedMessageEncoding({ id: 8 }, subscriberRequest(COUNTED_TYPE));
		let generated = 0;
		const generateFrame = () => {
			generated++;
			return Buffer.from('frame');
		};

		const first = getSharedFrame(encoding, '4 topic/a', generateFrame);
		const second = getSharedFrame(encoding, '4 topic/a', generateFrame);

		assert.strictEqual(generated, 1);
		assert.strictEqual(first, second);
	});

	it('keeps frames distinct per key', function () {
		const encoding = getSharedMessageEncoding({ id: 9 }, subscriberRequest(COUNTED_TYPE));

		const v4 = getSharedFrame(encoding, '4 topic/a', () => Buffer.from('v4'));
		const v5 = getSharedFrame(encoding, '5 topic/a', () => Buffer.from('v5'));
		const otherTopic = getSharedFrame(encoding, '4 topic/b', () => Buffer.from('other'));

		assert.strictEqual(v4.toString(), 'v4');
		assert.strictEqual(v5.toString(), 'v5');
		assert.strictEqual(otherTopic.toString(), 'other');
	});

	it('frames are scoped to the encoding, so a different content type gets its own', function () {
		const message = { id: 10 };
		const counted = getSharedMessageEncoding(message, subscriberRequest(COUNTED_TYPE));
		const alt = getSharedMessageEncoding(message, subscriberRequest(ALT_TYPE));

		const countedFrame = getSharedFrame(counted, '4 topic/a', () => Buffer.from('counted-frame'));
		const altFrame = getSharedFrame(alt, '4 topic/a', () => Buffer.from('alt-frame'));

		assert.strictEqual(countedFrame.toString(), 'counted-frame');
		assert.strictEqual(altFrame.toString(), 'alt-frame');
	});
});

// These pin the two mqtt-packet facts the QoS 0 sharing in server/mqtt.ts depends on.
describe('sharedMessageEncoding – mqtt-packet assumptions behind QoS 0 sharing', function () {
	const topic = 'sensors/room-1/temperature';
	const payload = Buffer.from('{"temperature":21.5}');

	it('ignores messageId for QoS 0, so it can be omitted entirely', function () {
		const withoutId = generate({ cmd: 'publish', topic, payload, qos: 0 }, { protocolVersion: 4 });
		const withId = generate({ cmd: 'publish', topic, payload, qos: 0, messageId: 4242 }, { protocolVersion: 4 });

		assert.deepStrictEqual(withoutId, withId);
	});

	it('emits different bytes per protocol version, which is why the frame key includes it', function () {
		const v4 = generate({ cmd: 'publish', topic, payload, qos: 0 }, { protocolVersion: 4 });
		const v5 = generate({ cmd: 'publish', topic, payload, qos: 0 }, { protocolVersion: 5 });

		assert.notDeepStrictEqual(v4, v5, 'MQTT v5 adds a properties field that v3.1.1 omits');
	});

	it('emits distinct bytes per messageId once QoS is non-zero, so those stay per subscriber', function () {
		const first = generate({ cmd: 'publish', topic, payload, qos: 1, messageId: 1 }, { protocolVersion: 4 });
		const second = generate({ cmd: 'publish', topic, payload, qos: 1, messageId: 2 }, { protocolVersion: 4 });

		assert.notDeepStrictEqual(first, second);
	});
});

// Acceptance: a shared buffer must survive being handed to many subscribers unchanged. Server-to-client
// WebSocket frames are unmasked per RFC 6455, so ws never XORs the payload in place — but that is the
// property the whole optimization rests on, so assert it against the real ws send path.
describe('sharedMessageEncoding – shared buffers are not mutated by the send path', function () {
	it('is byte-identical after being sent to multiple WebSocket subscribers', async function () {
		const encoding = getSharedMessageEncoding({ temperature: 21.5 }, subscriberRequest(COUNTED_TYPE));
		const shared = getSharedFrame(encoding, '4 sensors/room-1', () =>
			generate(
				{ cmd: 'publish', topic: 'sensors/room-1/temperature', payload: encoding.payload, qos: 0 },
				{ protocolVersion: 4 }
			)
		);
		const original = Buffer.from(shared); // independent copy to compare against afterwards

		const wss = new WebSocketServer({ port: 0 });
		try {
			await new Promise((resolve) => wss.once('listening', resolve));
			const { port } = wss.address();
			const SUBSCRIBERS = 5;
			const received = [];

			const serverSockets = [];
			const connected = new Promise((resolve) => {
				wss.on('connection', (socket) => {
					serverSockets.push(socket);
					if (serverSockets.length === SUBSCRIBERS) resolve();
				});
			});

			const clients = [];
			const allReceived = [];
			for (let i = 0; i < SUBSCRIBERS; i++) {
				const client = new WebSocket(`ws://127.0.0.1:${port}`);
				clients.push(client);
				allReceived.push(
					new Promise((resolve) =>
						client.once('message', (data) => {
							received.push(Buffer.from(data));
							resolve();
						})
					)
				);
			}
			await Promise.all(clients.map((client) => new Promise((resolve) => client.once('open', resolve))));
			await connected;

			// the same buffer instance goes to every subscriber, exactly as the fan-out does
			for (const socket of serverSockets) socket.send(shared);
			await Promise.all(allReceived);

			assert.deepStrictEqual(shared, original, 'the shared buffer must not be mutated by sending it');
			for (const bytes of received) {
				assert.deepStrictEqual(bytes, original, 'every subscriber must receive the identical bytes');
			}
			for (const client of clients) client.close();
		} finally {
			await new Promise((resolve) => wss.close(resolve));
		}
	});
});
