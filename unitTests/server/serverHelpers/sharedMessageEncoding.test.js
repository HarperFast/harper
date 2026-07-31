'use strict';

const assert = require('node:assert');
const testUtils = require('../../testUtils.js');
testUtils.preTestPrep();

const { generate } = require('mqtt-packet');
const { WebSocketServer } = require('ws');
const WebSocket = require('ws');

const { contentTypes, asyncSerialization } = require('#src/server/serverHelpers/contentTypes');
const {
	getSharedMessageEncoding,
	getSharedFrame,
	setSharedFrame,
	rotateSharedEncodings,
	isRotationScheduled,
	resolveSharedPayload,
	MAX_RETAINED_BYTES,
} = require('#src/server/serverHelpers/sharedMessageEncoding');

/**
 * Sharing is gated on the event carrying a record version, which every store-sourced event does.
 * These tests are about the encoding itself, so they pass one; the gate has its own suite below.
 */
function share(message, request) {
	return getSharedMessageEncoding(message, request, 1);
}

/**
 * Mirrors the QoS 0 lookup-then-generate in server/mqtt.ts's outbound listener, including its
 * `hits > 0` gate — a frame is only retained once a second subscriber has actually arrived.
 */
function shareFrame(encoding, version, topic, generateFrame) {
	const existing = getSharedFrame(encoding, version, topic);
	if (existing !== undefined) return existing;
	const frame = generateFrame();
	if (encoding.hits > 0) setSharedFrame(encoding, version, topic, frame);
	return frame;
}

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

		const first = share(message, subscriberRequest(COUNTED_TYPE));
		const second = share(message, subscriberRequest(COUNTED_TYPE));

		assert.strictEqual(countedCalls, 1, 'the message should be serialized exactly once for both subscribers');
		assert.strictEqual(first, second, 'both subscribers should get the same encoding');
		assert.strictEqual(first.payload, second.payload, 'both subscribers should get the same payload buffer');
		assert.strictEqual(first.payload.toString(), 'counted:{"id":1,"temperature":21.5}');
	});

	it('gives subscribers negotiating different content types their own correct payloads', function () {
		const message = { id: 2, status: 'ok' };

		const counted = share(message, subscriberRequest(COUNTED_TYPE));
		const alt = share(message, subscriberRequest(ALT_TYPE));

		assert.strictEqual(countedCalls, 1);
		assert.strictEqual(altCalls, 1);
		assert.notStrictEqual(counted.payload, alt.payload);
		assert.strictEqual(counted.payload.toString(), 'counted:{"id":2,"status":"ok"}');
		assert.strictEqual(alt.payload.toString(), 'alt:{"id":2,"status":"ok"}');
	});

	it('does not share across distinct messages', function () {
		const request = subscriberRequest(COUNTED_TYPE);

		const first = share({ id: 3 }, request);
		const second = share({ id: 4 }, request);

		assert.strictEqual(countedCalls, 2);
		assert.notStrictEqual(first.payload, second.payload);
		assert.strictEqual(first.payload.toString(), 'counted:{"id":3}');
		assert.strictEqual(second.payload.toString(), 'counted:{"id":4}');
	});

	it('serializes a late subscriber against the same shared encoding', function () {
		const message = { id: 5 };
		const request = subscriberRequest(COUNTED_TYPE);

		const early = share(message, request);
		share(message, request);
		const late = share(message, request);

		assert.strictEqual(countedCalls, 1);
		assert.strictEqual(late.payload, early.payload);
	});

	it('falls back to per-subscriber serialization for a primitive message', function () {
		const request = subscriberRequest(COUNTED_TYPE);

		const first = share('a string message', request);
		const second = share('a string message', request);

		// primitives can not key a WeakMap, so they are simply not shared — still correct, just not memoized
		assert.strictEqual(countedCalls, 2);
		assert.strictEqual(first.payload.toString(), 'counted:"a string message"');
		assert.strictEqual(second.payload.toString(), 'counted:"a string message"');
	});

	it('serializes to JSON, once, when there is no request (raw TCP MQTT)', function () {
		const message = { id: 6, name: 'sensor' };

		const first = share(message, null);
		const second = share(message, undefined);

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

		const first = share(message, subscriberRequest(ASYNC_TYPE));
		const second = share(message, subscriberRequest(ASYNC_TYPE));

		assert.strictEqual(first, second);
		assert.strictEqual(typeof first.payload.then, 'function', 'the pending serialization is shared, not re-entered');
		const resolved = await first.payload;
		assert.strictEqual(resolved.toString(), 'async:{"id":7}');
		// the resolved buffer replaces the promise in place, so subscribers arriving after it settles
		// take the synchronous path
		assert.strictEqual(share(message, subscriberRequest(ASYNC_TYPE)).payload, resolved);
		// two attempts (the initial one that requested async work, and the retry), never four
		assert.strictEqual(asyncCalls, 2);
	});
});

// Sharing is only sound because the producer yields a fresh object per version. Store-sourced
// events carry a record version and satisfy that; an app-authored Resource yielding its own
// envelope does not, and could otherwise mutate one object, re-send it, and have every subscriber
// receive the first message's bytes. Gating on the version makes the contract enforced, not merely
// documented — so this is the test that a mutated-and-resent envelope is never served stale.
describe('sharedMessageEncoding – sharing is gated on store provenance', function () {
	it('does not share an event with no record version', function () {
		const message = { id: 30, reading: 1 };
		const request = subscriberRequest(COUNTED_TYPE);

		const first = getSharedMessageEncoding(message, request);
		const second = getSharedMessageEncoding(message, request);

		assert.strictEqual(countedCalls, 2, 'an unversioned event must be encoded per subscriber');
		assert.notStrictEqual(first, second);
	});

	it('serves the current contents when an app mutates and re-sends one envelope', function () {
		// the shape the contract warns about: a module-level object reused for every publish
		const envelope = { seq: 0 };
		const request = subscriberRequest(COUNTED_TYPE);

		envelope.seq = 1;
		const firstPublish = getSharedMessageEncoding(envelope, request);
		envelope.seq = 2;
		const secondPublish = getSharedMessageEncoding(envelope, request);

		assert.strictEqual(firstPublish.payload.toString(), 'counted:{"seq":1}');
		assert.strictEqual(secondPublish.payload.toString(), 'counted:{"seq":2}', 'must never deliver stale bytes');
	});

	it('shares an event that carries a record version', function () {
		const message = { id: 31, reading: 1 };
		const request = subscriberRequest(COUNTED_TYPE);

		const first = getSharedMessageEncoding(message, request, 42);
		const second = getSharedMessageEncoding(message, request, 42);

		assert.strictEqual(countedCalls, 1);
		assert.strictEqual(first, second);
	});
});

describe('sharedMessageEncoding – pass-through messages', function () {
	// A message that already carries its own encoding is delivered verbatim, so content negotiation
	// must never run for it — an Accept header naming only unsupported types throws 406, which in
	// the MQTT listener disconnects the session.
	it('delivers a message that carries its own content type without negotiating', function () {
		const message = { contentType: 'application/octet-stream', data: Buffer.from([1, 2, 3]) };
		const unsatisfiable = subscriberRequest('application/x-not-registered');

		const encoding = share(message, unsatisfiable);

		assert.strictEqual(encoding.payload, message.data);
	});

	it('shares one entry across subscribers regardless of what each negotiated', function () {
		const message = { contentType: 'application/octet-stream', data: Buffer.from('shared') };

		const viaCounted = share(message, subscriberRequest(COUNTED_TYPE));
		const viaAlt = share(message, subscriberRequest(ALT_TYPE));

		assert.strictEqual(viaCounted, viaAlt, 'pass-through messages are content-type independent');
		assert.strictEqual(countedCalls, 0, 'no serializer should have been invoked');
		assert.strictEqual(altCalls, 0);
	});

	it('still negotiates normally for a message with a content type but no data', function () {
		const message = { contentType: 'application/octet-stream', id: 11 };

		const encoding = share(message, subscriberRequest(COUNTED_TYPE));

		assert.strictEqual(countedCalls, 1);
		assert.strictEqual(encoding.payload.toString(), 'counted:' + JSON.stringify(message));
	});
});

describe('sharedMessageEncoding – a failed serialization is retried, not memoized', function () {
	const FAILING_TYPE = 'application/x-shared-encoding-failing';

	afterEach(function () {
		contentTypes.delete(FAILING_TYPE);
	});

	it('clears the payload so the next subscriber re-encodes after an async rejection', async function () {
		let attempts = 0;
		let failNext = true;
		contentTypes.set(FAILING_TYPE, {
			serialize(message) {
				attempts++;
				if (failNext) {
					// model a blob read that must complete before the message can be serialized
					asyncSerialization(Promise.reject(new Error('transient serialization failure')));
					return undefined;
				}
				return Buffer.from('recovered:' + JSON.stringify(message));
			},
			q: 1,
		});
		const message = { id: 12 };
		const request = subscriberRequest(FAILING_TYPE);

		const failing = share(message, request);
		await assert.rejects(failing.payload, /transient serialization failure/);
		assert.strictEqual(failing.payload, undefined, 'the rejected promise must not stay memoized');

		// the failure has cleared; a later subscriber (or a later delivery of the same message) must
		// get a fresh attempt rather than inheriting the rejection
		failNext = false;
		const recovered = share(message, request);
		assert.strictEqual(recovered.payload.toString(), 'recovered:{"id":12}');
		assert.strictEqual(attempts, 2);
	});

	it('lets a whole fan-out recover from one shared failure rather than all failing together', async function () {
		let failNext = true;
		contentTypes.set(FAILING_TYPE, {
			serialize(message) {
				if (failNext) {
					failNext = false; // transient: the retry succeeds
					asyncSerialization(Promise.reject(new Error('transient serialization failure')));
					return undefined;
				}
				return Buffer.from('recovered:' + JSON.stringify(message));
			},
			q: 1,
		});
		const message = { id: 13 };
		const request = subscriberRequest(FAILING_TYPE);

		// the whole wave is already awaiting the one shared promise when it rejects
		const encoding = share(message, request);
		const wave = [
			resolveSharedPayload(encoding, message, request, 1),
			resolveSharedPayload(encoding, message, request, 1),
			resolveSharedPayload(encoding, message, request, 1),
		];

		const payloads = await Promise.all(wave);
		for (const payload of payloads) {
			assert.strictEqual(payload.toString(), 'recovered:{"id":13}', 'every subscriber must recover');
		}
	});

	it('propagates a failure that a retry cannot fix', async function () {
		contentTypes.set(FAILING_TYPE, {
			serialize() {
				asyncSerialization(Promise.reject(new Error('persistent serialization failure')));
				return undefined;
			},
			q: 1,
		});
		const message = { id: 14 };
		const request = subscriberRequest(FAILING_TYPE);

		const encoding = share(message, request);
		await assert.rejects(
			resolveSharedPayload(encoding, message, request, 1),
			/persistent serialization failure/,
			'a retry that fails again must surface, not hang or deliver empty bytes'
		);
	});
});

describe('sharedMessageEncoding – retention is bounded by rotation', function () {
	// Retention has to be bounded by the fan-out, not by the message object: for record events the
	// message IS the store's cached record, so an entry that outlives the fan-out keeps a serialized
	// copy (and a whole PUBLISH buffer) alive for as long as that record stays cached.
	it('keeps an entry across one rotation and drops it after two', function () {
		const message = { id: 20 };
		const request = subscriberRequest(COUNTED_TYPE);

		const original = share(message, request);
		assert.strictEqual(countedCalls, 1);

		// one rotation: the entry is in the previous generation, still reachable
		rotateSharedEncodings();
		assert.strictEqual(share(message, request), original, 'a fan-out may span a rotation');
		assert.strictEqual(countedCalls, 1);

		// the lookup above promoted it back into the current generation, so it survives again
		rotateSharedEncodings();
		assert.strictEqual(share(message, request), original);
		assert.strictEqual(countedCalls, 1);

		// two rotations with no intervening lookup releases it, and the next subscriber re-encodes
		rotateSharedEncodings();
		rotateSharedEncodings();
		assert.notStrictEqual(share(message, request), original, 'the entry must be released');
		assert.strictEqual(countedCalls, 2);
	});

	it('counts reuses so a caller can tell a real fan-out from a single subscriber', function () {
		const message = { id: 21 };
		const request = subscriberRequest(COUNTED_TYPE);

		const first = share(message, request);
		assert.strictEqual(first.hits, 0, 'the first subscriber has no one to share with yet');
		assert.strictEqual(share(message, request).hits, 1);
		assert.strictEqual(share(message, request).hits, 2);
	});

	it('never reports a hit for an unshareable primitive message', function () {
		const request = subscriberRequest(COUNTED_TYPE);

		assert.strictEqual(share('primitive', request).hits, 0);
		assert.strictEqual(share('primitive', request).hits, 0);
	});

	// Time alone bounds how long an entry is held, not how much is held at once. Without the byte
	// budget, a high-throughput single-subscriber topic would keep a whole rotation interval's worth
	// of payloads live.
	it('rotates early once retained bytes pass the budget', function () {
		const BULKY_TYPE = 'application/x-shared-encoding-bulky';
		const CHUNK = 1_000_000;
		contentTypes.set(BULKY_TYPE, { serialize: () => Buffer.alloc(CHUNK), q: 1 });
		try {
			rotateSharedEncodings();
			rotateSharedEncodings();
			const request = subscriberRequest(BULKY_TYPE);
			const first = { id: 'bulky-first' };
			const firstEncoding = share(first, request);

			// two budgets' worth of new messages forces two early rotations, which releases the first
			const needed = Math.ceil((MAX_RETAINED_BYTES * 2) / CHUNK) + 2;
			for (let i = 0; i < needed; i++) share({ id: 'bulky-' + i }, request);

			assert.notStrictEqual(
				share(first, request),
				firstEncoding,
				'byte pressure must release earlier entries rather than holding a whole interval'
			);
		} finally {
			contentTypes.delete(BULKY_TYPE);
			rotateSharedEncodings();
			rotateSharedEncodings();
		}
	});

	it('gives back an entry’s bytes when it is refilled, so the budget does not leak', function () {
		const BULKY_TYPE = 'application/x-shared-encoding-bulky-refill';
		const CHUNK = 1_000_000;
		let failNext = true;
		contentTypes.set(BULKY_TYPE, {
			serialize() {
				if (failNext) {
					failNext = false;
					throw new Error('first attempt fails');
				}
				return Buffer.alloc(CHUNK);
			},
			q: 1,
		});
		try {
			rotateSharedEncodings();
			rotateSharedEncodings();
			const request = subscriberRequest(BULKY_TYPE);
			const message = { id: 'refill-budget' };

			// a synchronous throw on the first encode must leave nothing charged and nothing retained
			assert.throws(() => share(message, request), /first attempt fails/);

			const encoding = share(message, request);
			assert.strictEqual(encoding.failed, false);
			assert.strictEqual(encoding.bytes, CHUNK, 'the entry accounts for exactly what it holds');
		} finally {
			contentTypes.delete(BULKY_TYPE);
			rotateSharedEncodings();
			rotateSharedEncodings();
		}
	});

	it('arms the rotation timer on the first retained entry, and stops it once nothing is retained', function () {
		// drain whatever earlier tests retained so this starts from a known state
		rotateSharedEncodings();
		rotateSharedEncodings();
		assert.strictEqual(isRotationScheduled(), false, 'an idle broker must not keep a timer armed');

		share({ id: 23 }, subscriberRequest(COUNTED_TYPE));
		assert.strictEqual(isRotationScheduled(), true, 'retaining an entry must arm rotation');

		// the first rotation still has the entry to release, so the timer keeps running
		rotateSharedEncodings();
		assert.strictEqual(isRotationScheduled(), true);
		// the second finds nothing was retained since, so it stops
		rotateSharedEncodings();
		assert.strictEqual(isRotationScheduled(), false, 'rotation must stop when there is nothing left to release');

		// and re-arms rather than leaving retention unbounded after a quiet period
		share({ id: 24 }, subscriberRequest(COUNTED_TYPE));
		assert.strictEqual(isRotationScheduled(), true, 'rotation must re-arm after stopping');
	});

	it('does not treat a serializer that legitimately returns undefined as a failure', function () {
		const UNDEFINED_TYPE = 'application/x-shared-encoding-undefined';
		let calls = 0;
		contentTypes.set(UNDEFINED_TYPE, {
			serialize() {
				calls++;
				return undefined;
			},
			q: 1,
		});
		try {
			const message = { id: 22 };
			const request = subscriberRequest(UNDEFINED_TYPE);

			const first = share(message, request);
			const second = share(message, request);

			assert.strictEqual(first, second);
			assert.strictEqual(first.failed, false);
			// an undefined payload is a legitimate result, not a retry signal — re-encoding here would
			// make the cache slower than no cache at all
			assert.strictEqual(calls, 1);
		} finally {
			contentTypes.delete(UNDEFINED_TYPE);
		}
	});
});

describe('sharedMessageEncoding – frame sharing', function () {
	// The retention policy the outbound listener applies: nothing is kept for a fan-out of one, and
	// from the third subscriber on the frame is served from cache. A fan-out of exactly two pays two
	// generates — the cost of not knowing the width in advance.
	it('retains a frame from the second subscriber on, and reuses it thereafter', function () {
		const message = { id: 8 };
		const request = subscriberRequest(COUNTED_TYPE);
		let generated = 0;
		const generateFrame = () => {
			generated++;
			return Buffer.from('frame');
		};

		const first = shareFrame(share(message, request), 4, 'topic/a', generateFrame);
		assert.strictEqual(generated, 1);
		assert.strictEqual(getSharedFrame(share(message, request), 4, 'topic/a'), undefined);

		const second = shareFrame(share(message, request), 4, 'topic/a', generateFrame);
		assert.strictEqual(generated, 2, 'a fan-out of one must not have retained anything');

		const third = shareFrame(share(message, request), 4, 'topic/a', generateFrame);
		assert.strictEqual(generated, 2, 'from the third subscriber on the frame is shared');
		assert.strictEqual(third, second);
		assert.deepStrictEqual(first, second);
	});

	it('reports a miss without allocating, so the caller only builds the frame once', function () {
		const encoding = share({ id: 8.5 }, subscriberRequest(COUNTED_TYPE));

		assert.strictEqual(getSharedFrame(encoding, 4, 'topic/a'), undefined);
		const stored = setSharedFrame(encoding, 4, 'topic/a', Buffer.from('frame'));
		assert.strictEqual(getSharedFrame(encoding, 4, 'topic/a'), stored);
	});

	it('keeps frames distinct per protocol version and topic', function () {
		const encoding = share({ id: 9 }, subscriberRequest(COUNTED_TYPE));

		const v4 = shareFrame(encoding, 4, 'topic/a', () => Buffer.from('v4'));
		const v5 = shareFrame(encoding, 5, 'topic/a', () => Buffer.from('v5'));
		const otherTopic = shareFrame(encoding, 4, 'topic/b', () => Buffer.from('other'));

		assert.strictEqual(v4.toString(), 'v4');
		assert.strictEqual(v5.toString(), 'v5');
		assert.strictEqual(otherTopic.toString(), 'other');
	});

	it('frames are scoped to the encoding, so a different content type gets its own', function () {
		const message = { id: 10 };
		const counted = share(message, subscriberRequest(COUNTED_TYPE));
		const alt = share(message, subscriberRequest(ALT_TYPE));

		const countedFrame = shareFrame(counted, 4, 'topic/a', () => Buffer.from('counted-frame'));
		const altFrame = shareFrame(alt, 4, 'topic/a', () => Buffer.from('alt-frame'));

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
		const encoding = share({ temperature: 21.5 }, subscriberRequest(COUNTED_TYPE));
		const shared = shareFrame(encoding, 4, 'sensors/room-1', () =>
			generate(
				{ cmd: 'publish', topic: 'sensors/room-1/temperature', payload: encoding.payload, qos: 0 },
				{ protocolVersion: 4 }
			)
		);
		const original = Buffer.from(shared); // independent copy to compare against afterwards

		const wss = new WebSocketServer({ port: 0 });
		const clients = [];
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
		} finally {
			// close in finally, otherwise an assertion failure leaves sockets open and surfaces as a
			// mocha timeout instead of the real error
			for (const client of clients) client.close();
			await new Promise((resolve) => wss.close(resolve));
		}
	});
});
