const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const mqttPacket = require('mqtt-packet');
const { setupTestDBPath } = require('../testUtils');
const Resources = require('#src/resources/Resources');
const { Resource } = require('#src/resources/Resource');
const { handleApplication } = require('#src/server/mqtt');
const { forComponent } = require('#src/utility/logging/harper_logger');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { waitFor } = require('../waitFor');
require('#src/server/serverHelpers/serverUtilities');

const superUser = { role: { permission: { super_user: true } } };

let sequence = 0;
/** Registers a topic whose subscription yields the given values, as a custom Resource would. */
function topicYielding(...values) {
	const name = `Delivery${++sequence}`;
	class Yielding extends Resource {
		subscribe() {
			return {
				async *[Symbol.asyncIterator]() {
					for (const value of values) yield { type: 'message', id: 'item', value };
				},
				end() {},
			};
		}
	}
	Resources.resources.set(name, Yielding, { mqtt: true });
	return name;
}

function mqttListener() {
	let listener;
	const mqtt = { sessions: new Set(), events: new EventEmitter() };
	const server = { ws: (fn) => ((listener = fn), []), socket: () => ({}), mqtt };
	handleApplication({ options: { getAll: () => ({ webSocket: {} }) }, server });
	return () => {
		const socket = { sends: [], handlers: {}, closes: 0, terminations: 0, _socket: { remoteAddress: '127.0.0.1' } };
		socket.close = () => socket.closes++;
		// a terminated ws emits 'close' straight away, without waiting on the peer
		socket.terminate = () => {
			socket.terminations++;
			setImmediate(() => socket.handlers.close?.());
		};
		socket.send = (message) => socket.sends.push(message);
		socket.on = (event, handler) => (socket.handlers[event] = handler);
		const headers = { 'sec-websocket-protocol': 'mqtt' };
		listener(
			socket,
			{ headers: { asObject: headers, get: (name) => headers[name.toLowerCase()] }, user: superUser },
			Promise.resolve({ status: 200 }),
			() => {}
		);
		return { socket, sessions: mqtt.sessions };
	};
}

async function connect(open, protocolVersion) {
	const { socket, sessions } = open();
	const parse = () => {
		const parser = mqttPacket.parser({ protocolVersion });
		const packets = [];
		parser.on('packet', (packet) => packets.push(packet));
		for (const sent of socket.sends) parser.parse(sent);
		return packets;
	};
	const write = (packet) => socket.handlers.message(mqttPacket.generate(packet, { protocolVersion }));
	write({ cmd: 'connect', protocolId: 'MQTT', protocolVersion, clientId: `delivery-${++sequence}`, clean: true });
	await waitFor(() => parse().find((packet) => packet.cmd === 'connack'), { message: 'no CONNACK' });
	const session = [...sessions].at(-1);
	return {
		socket,
		sessions,
		session,
		parse,
		async subscribe(topic) {
			write({ cmd: 'subscribe', messageId: 1, subscriptions: [{ topic, qos: 0, nl: false, rap: false, rh: 0 }] });
			await waitFor(() => parse().find((packet) => packet.cmd === 'suback'), { message: 'no SUBACK' });
		},
	};
}

describe('mqtt.ts delivery to a subscriber', () => {
	let open;
	before(() => {
		setupTestDBPath();
		setMainIsWorker(true);
		if (!Resources.resources) Resources.resetResources();
		open = mqttListener();
	});

	for (const protocolVersion of [4, 5]) {
		describe(`MQTT ${protocolVersion === 5 ? 'v5' : 'v3.1.1'}`, () => {
			it('sends a valid PUBLISH for a message whose data is a plain Uint8Array view', async () => {
				const backing = new Uint8Array([0xee, 104, 105, 0xee]);
				const topic = topicYielding({ contentType: 'application/octet-stream', data: backing.subarray(1, 3) });
				const client = await connect(open, protocolVersion);
				await client.subscribe(`${topic}/#`);

				const publish = await waitFor(() => client.parse().find((packet) => packet.cmd === 'publish'), {
					message: 'no PUBLISH',
				});

				assert.strictEqual(publish.topic, `${topic}/item`);
				assert.strictEqual(publish.payload.toString(), 'hi');
				assert.strictEqual(client.socket.terminations, 0);
			});

			it('aborts the connection when a delivery throws, and ends the session', async () => {
				const logged = forComponent('mqtt');
				const originalError = logged.error;
				const errors = [];
				logged.error = (error) => errors.push(error);
				try {
					const topic = topicYielding({
						toJSON() {
							throw new Error('unserializable');
						},
					});
					const client = await connect(open, protocolVersion);
					assert.ok(client.sessions.has(client.session));
					await client.subscribe(`${topic}/#`);

					await waitFor(() => !client.sessions.has(client.session), {
						message: 'the session was not ended',
					});

					assert.strictEqual(client.socket.terminations, 1, 'the transport must be closed, not left open');
					assert.ok(errors.some((error) => error?.message === 'unserializable'));
				} finally {
					logged.error = originalError;
				}
			});
		});
	}
});
