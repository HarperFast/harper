'use strict';
/**
 * MQTT fan-out encoding benchmark — measures the per-publish encoding cost of delivering one
 * message to N subscribers of a topic, comparing the per-subscriber encoding this replaces
 * against the shared encoding in server/serverHelpers/sharedMessageEncoding.ts.
 *
 * The point is the shape of the curve: per-publish cost should become roughly flat in N rather
 * than linear. Only the encoding work is modelled (serialize + PUBLISH packet generation) — the
 * socket writes that follow are unchanged and stay per subscriber either way.
 *
 * Run (after npm run build):
 *   node benchmarks/mqtt-fanout-encoding.js [MESSAGES] [CONTENT_TYPE]
 *
 * Examples:
 *   node benchmarks/mqtt-fanout-encoding.js                          # 200 messages, JSON
 *   node benchmarks/mqtt-fanout-encoding.js 200 application/cbor     # binary content type
 */

const { performance } = require('node:perf_hooks');
const { generate } = require('mqtt-packet');
const { serializeMessage } = require('#src/server/serverHelpers/contentTypes');
const {
	getSharedMessageEncoding,
	getSharedFrame,
	setSharedFrame,
} = require('#src/server/serverHelpers/sharedMessageEncoding');

const MESSAGES = parseInt(process.argv[2]) || 200;
const CONTENT_TYPE = process.argv[3] || 'application/json';
const SUBSCRIBER_COUNTS = [1, 100, 1000];
const TOPIC = 'sensors/room-1/telemetry';
const PROTOCOL_VERSION = 4;
const MQTT_OPTIONS = { protocolVersion: PROTOCOL_VERSION };

// Every subscriber of a topic shares one connection-level request per negotiated content type,
// which is the axis serializeMessage varies on.
const request = { headers: { accept: CONTENT_TYPE } };

function makeMessage(index) {
	return {
		id: `reading-${index}`,
		recordedAt: 1750000000000 + index,
		temperature: 20 + (index % 100) / 10,
		humidity: 40 + (index % 50) / 10,
		battery: 0.5 + (index % 50) / 100,
		tags: ['telemetry', 'room-1', 'floor-3'],
		readings: Array.from({ length: 8 }, (_, i) => ({ sensor: `s${i}`, value: index + i })),
	};
}

const messages = Array.from({ length: MESSAGES }, (_, index) => makeMessage(index));

/** What every subscriber did before this change: serialize the message and generate its own packet. */
function perSubscriberEncoding(message, subscribers, qos) {
	let bytes = 0;
	for (let i = 0; i < subscribers; i++) {
		const payload = serializeMessage(message, request);
		const packet = generate(
			{
				cmd: 'publish',
				topic: TOPIC,
				payload,
				messageId: qos > 0 ? i + 1 : Math.floor(Math.random() * 100000000),
				qos,
			},
			MQTT_OPTIONS
		);
		bytes += packet.length;
	}
	return bytes;
}

/** What subscribers do now: one serialization per message, and for QoS 0 one packet per topic. */
function sharedEncoding(message, subscribers, qos) {
	let bytes = 0;
	for (let i = 0; i < subscribers; i++) {
		const encoding = getSharedMessageEncoding(message, request);
		const payload = encoding.payload;
		if (qos > 0) {
			bytes += generate({ cmd: 'publish', topic: TOPIC, payload, messageId: i + 1, qos }, MQTT_OPTIONS).length;
		} else {
			// same lookup-then-generate shape as the outbound listener in server/mqtt.ts
			let packet = getSharedFrame(encoding, PROTOCOL_VERSION, TOPIC);
			if (packet === undefined)
				packet = setSharedFrame(
					encoding,
					PROTOCOL_VERSION,
					TOPIC,
					generate({ cmd: 'publish', topic: TOPIC, payload, qos: 0 }, MQTT_OPTIONS)
				);
			bytes += packet.length;
		}
	}
	return bytes;
}

function run(encode, subscribers, qos) {
	// each publish gets a fresh message object, exactly as the fan-out does
	const batch = messages.map((message) => ({ ...message }));
	let bytes = 0;
	// warm up so the comparison is not measuring first-call deoptimisation
	encode(batch[0], Math.min(subscribers, 10), qos);
	const start = performance.now();
	for (const message of batch) bytes += encode(message, subscribers, qos);
	const elapsed = performance.now() - start;
	return { msPerPublish: elapsed / MESSAGES, totalMs: elapsed, bytes };
}

function format(value) {
	return value.toFixed(4).padStart(11);
}

console.log(`MQTT fan-out encoding: ${MESSAGES} messages, content type ${CONTENT_TYPE}, MQTT v${PROTOCOL_VERSION}`);
console.log(`message size: ${Buffer.byteLength(JSON.stringify(messages[0]))} bytes (as JSON)\n`);

for (const qos of [0, 1]) {
	console.log(`QoS ${qos}${qos === 0 ? '  (payload + packet shared)' : '  (payload shared, packet per subscriber)'}`);
	console.log('  subscribers   ms/publish before    ms/publish after      speedup');
	for (const subscribers of SUBSCRIBER_COUNTS) {
		const before = run(perSubscriberEncoding, subscribers, qos);
		const after = run(sharedEncoding, subscribers, qos);
		console.log(
			`  ${String(subscribers).padStart(11)}   ${format(before.msPerPublish)}        ${format(
				after.msPerPublish
			)}   ${(before.msPerPublish / after.msPerPublish).toFixed(1).padStart(10)}x`
		);
		if (before.bytes !== after.bytes) {
			throw new Error(`byte count mismatch at ${subscribers} subscribers: ${before.bytes} vs ${after.bytes}`);
		}
	}
	console.log();
}
