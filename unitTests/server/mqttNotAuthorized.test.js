const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const mqttPacket = require('mqtt-packet');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const Resources = require('#src/resources/Resources');
const { Resource } = require('#src/resources/Resource');
const { handleApplication } = require('#src/server/mqtt');
const { server } = require('#src/server/Server');
const { forComponent } = require('#src/utility/logging/harper_logger');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { waitFor } = require('../waitFor');
require('#src/server/serverHelpers/serverUtilities');

const NOT_AUTHORIZED = 0x87;
const UNSPECIFIED_ERROR = 0x80;
const TOPIC_FILTER_INVALID = 0x8f;
const TOPIC_NAME_INVALID = 0x90;

const anonymous = undefined;
// no username: a named principal absent from hdb_user is revoked by live re-authorization
const unprivileged = { role: { permission: {} } };
const superUser = { role: { permission: { super_user: true } } };

let sequence = 0;
function protectedTable() {
	const name = `NotAuthorized${++sequence}`;
	const T = table({
		table: name,
		database: `mqtt_not_authorized_${name}`,
		audit: true,
		attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'value' }],
	});
	Resources.resources.set(name, T, { mqtt: true });
	return name;
}

function mqttListener() {
	let listener;
	const mqtt = { sessions: new Set(), events: new EventEmitter() };
	const server = { ws: (fn) => ((listener = fn), []), socket: () => ({}), mqtt };
	handleApplication({ options: { getAll: () => ({ webSocket: {} }) }, server });
	const open = (user) => {
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
			{ headers: { asObject: headers, get: (name) => headers[name.toLowerCase()] }, user },
			Promise.resolve({ status: 200 }),
			() => {}
		);
		return { socket, sessions: mqtt.sessions };
	};
	open.mqtt = mqtt;
	return open;
}

async function connect(
	open,
	{
		user = anonymous,
		protocolVersion = 5,
		properties,
		clientId = `not-authorized-${++sequence}`,
		clean = true,
		username,
		password,
	} = {}
) {
	const { socket, sessions } = open(user);
	const registeredBefore = new Set(sessions);
	const parse = () => {
		const parser = mqttPacket.parser({ protocolVersion });
		const packets = [];
		parser.on('packet', (packet) => packets.push(packet));
		for (const sent of socket.sends) parser.parse(sent);
		return packets;
	};
	const write = (packet) => socket.handlers.message(mqttPacket.generate(packet, { protocolVersion }));
	write({
		cmd: 'connect',
		protocolId: 'MQTT',
		protocolVersion,
		clientId,
		clean,
		properties,
		username,
		password,
	});
	await waitFor(() => parse().find((packet) => packet.cmd === 'connack'), { message: 'no CONNACK' });
	// the listener's registry is shared by every client of this suite, so a client is told apart by identity
	const session = [...sessions].find((registered) => !registeredBefore.has(registered));
	let messageId = 0;
	return {
		socket,
		sessions,
		session,
		parse,
		connack: parse().find((packet) => packet.cmd === 'connack'),
		async request(packet, answer) {
			const id = ++messageId;
			write({ messageId: id, ...packet });
			const found = () => parse().find((candidate) => candidate.cmd === answer && candidate.messageId === id);
			await waitFor(found, { message: () => `no ${answer} for ${packet.cmd}; got ${parse().map((p) => p.cmd)}` });
			return found();
		},
		subscribe(topics, qos = 1) {
			const subscriptions = [].concat(topics).map((topic) => ({ topic, qos, nl: false, rap: false, rh: 0 }));
			return this.request({ cmd: 'subscribe', subscriptions }, 'suback');
		},
		publish(topic, qos = 1, value = 1) {
			const payload = Buffer.from(JSON.stringify({ id: 'a', value }));
			return this.request(
				{ cmd: 'publish', topic, payload, qos, retain: false, dup: false },
				qos === 2 ? 'pubrec' : 'puback'
			);
		},
	};
}

function captureLog(method) {
	const logger = forComponent('mqtt');
	const original = logger[method];
	const lines = [];
	logger[method] = (...args) => lines.push(args);
	return {
		lines,
		restore: () => {
			if (original === undefined) delete logger[method];
			else logger[method] = original;
		},
	};
}

describe('mqtt.ts reason codes for a refused request', () => {
	let open;
	before(() => {
		setupTestDBPath();
		setMainIsWorker(true);
		if (!Resources.resources) Resources.resetResources();
		open = mqttListener();
	});

	describe('SUBACK', () => {
		it('reports a request with no user as Not authorized, with "Must login"', async () => {
			const client = await connect(open);
			const suback = await client.subscribe(`${protectedTable()}/#`);
			assert.deepStrictEqual(suback.granted, [NOT_AUTHORIZED]);
			assert.strictEqual(suback.properties?.reasonString, 'Must login');
		});

		it('reports a user without permission as Not authorized, with the access violation message', async () => {
			const client = await connect(open, { user: unprivileged });
			const suback = await client.subscribe(`${protectedTable()}/#`);
			assert.deepStrictEqual(suback.granted, [NOT_AUTHORIZED]);
			assert.strictEqual(suback.properties?.reasonString, 'Unauthorized access to resource');
		});

		it('still grants a permitted principal', async () => {
			const client = await connect(open, { user: superUser });
			const suback = await client.subscribe(`${protectedTable()}/#`);
			assert.deepStrictEqual(suback.granted, [1]);
			assert.strictEqual(suback.properties?.reasonString, undefined);
		});

		it('keeps an unknown topic at "topic filter invalid"', async () => {
			const client = await connect(open);
			const suback = await client.subscribe(`NoSuchResource${++sequence}/#`);
			assert.deepStrictEqual(suback.granted, [TOPIC_FILTER_INVALID]);
		});

		it('keeps 0x80, the only failure code of MQTT 3.1.1, for a request with no user', async () => {
			const client = await connect(open, { protocolVersion: 4 });
			const suback = await client.subscribe(`${protectedTable()}/#`);
			assert.deepStrictEqual(suback.granted, [UNSPECIFIED_ERROR]);
		});

		it('keeps the order of a mixed result and describes the first refusal', async () => {
			const client = await connect(open);
			const suback = await client.subscribe([`NoSuchResource${++sequence}/#`, `${protectedTable()}/#`]);
			assert.deepStrictEqual(suback.granted, [TOPIC_FILTER_INVALID, NOT_AUTHORIZED]);
			assert.match(suback.properties?.reasonString, /^The topic NoSuchResource\d+\/# does not exist/);
		});

		it('sends no reason string to a client that turned problem information off', async () => {
			const client = await connect(open, { properties: { requestProblemInformation: false } });
			const suback = await client.subscribe(`${protectedTable()}/#`);
			assert.deepStrictEqual(suback.granted, [NOT_AUTHORIZED]);
			assert.strictEqual(suback.properties?.reasonString, undefined);
		});

		it('trims a long reason string to its byte limit without splitting a character', async () => {
			const client = await connect(open);
			// the message is "The topic <topic> does not exist…": the 10-byte prefix and 245 ASCII bytes put the
			// first 2-byte character on byte 255, so the 256-byte cut falls between its two halves
			const suback = await client.subscribe(`${'x'.repeat(245)}${'é'.repeat(10)}`);
			const { reasonString } = suback.properties;
			assert.strictEqual(Buffer.byteLength(reasonString), 255);
			assert.ok(!reasonString.includes('�'), 'a character was cut in half');
		});

		describe('against the largest packet the client accepts', () => {
			const filterCount = 20;
			const encodedSize = (reasonString) =>
				mqttPacket.generate(
					{
						cmd: 'suback',
						messageId: 1,
						granted: new Array(filterCount).fill(NOT_AUTHORIZED),
						properties: reasonString ? { reasonString } : undefined,
					},
					{ protocolVersion: 5 }
				).length;
			const refuse = async (maximumPacketSize) => {
				const client = await connect(open, { properties: { maximumPacketSize } });
				const name = protectedTable();
				const filters = Array.from({ length: filterCount }, (_, i) => `${name}/${i}`);
				const suback = await client.subscribe(filters);
				const raw = client.socket.sends.at(-1);
				return { suback, size: raw.length };
			};

			it('drops a reason string that would push the packet over the limit', async () => {
				const limit = encodedSize();
				assert.ok(encodedSize('Must login') > limit + 10, 'the string must not fit in the old fixed allowance');
				const { suback, size } = await refuse(limit + 10);
				assert.deepStrictEqual(suback.granted, new Array(filterCount).fill(NOT_AUTHORIZED));
				assert.strictEqual(suback.properties?.reasonString, undefined);
				assert.ok(size <= limit + 10, `${size} bytes exceeds the limit`);
			});

			it('sends the reason string when the packet fits exactly, and drops it one byte under', async () => {
				const fits = encodedSize('Must login');
				const exact = await refuse(fits);
				assert.strictEqual(exact.suback.properties?.reasonString, 'Must login');
				assert.strictEqual(exact.size, fits);
				const under = await refuse(fits - 1);
				assert.strictEqual(under.suback.properties?.reasonString, undefined);
				assert.strictEqual(under.size, encodedSize());
			});
		});
	});

	describe('DISCONNECT for a durable session whose subscription is refused on resume', () => {
		for (const [label, resumingUser, reasonString] of [
			['no user', anonymous, 'Must login'],
			['a user without permission', unprivileged, 'Unauthorized access to resource'],
		]) {
			it(`reports ${label} as Not authorized`, async () => {
				const name = protectedTable();
				const clientId = `resume-${++sequence}`;
				const original = await connect(open, { user: superUser, clientId, clean: false });
				await original.subscribe(`${name}/#`);
				original.socket.handlers.close();
				const resumed = await connect(open, { user: resumingUser, clientId, clean: false });
				const disconnect = () => resumed.parse().find((packet) => packet.cmd === 'disconnect');
				await waitFor(disconnect, { message: () => `no DISCONNECT; got ${resumed.parse().map((p) => p.cmd)}` });
				assert.strictEqual(disconnect().reasonCode, NOT_AUTHORIZED);
				assert.strictEqual(disconnect().properties?.reasonString, reasonString);
			});
		}
	});

	describe('PUBACK and PUBREC', () => {
		it('reports a request with no user as Not authorized, with "Must login"', async () => {
			const client = await connect(open);
			const puback = await client.publish(`${protectedTable()}/a`, 1);
			assert.strictEqual(puback.reasonCode, NOT_AUTHORIZED);
			assert.strictEqual(puback.properties?.reasonString, 'Must login');
		});

		it('answers a QoS 2 PUBLISH with a failed PUBREC', async () => {
			const client = await connect(open);
			const pubrec = await client.publish(`${protectedTable()}/a`, 2);
			assert.strictEqual(pubrec.reasonCode, NOT_AUTHORIZED);
		});

		it('reports a user without permission as Not authorized', async () => {
			const client = await connect(open, { user: unprivileged });
			const puback = await client.publish(`${protectedTable()}/a`, 1);
			assert.strictEqual(puback.reasonCode, NOT_AUTHORIZED);
			assert.strictEqual(puback.properties?.reasonString, 'Unauthorized access to resource');
		});

		it('sends no reason string to a client that turned problem information off', async () => {
			const client = await connect(open, { properties: { requestProblemInformation: false } });
			const puback = await client.publish(`${protectedTable()}/a`, 1);
			assert.strictEqual(puback.reasonCode, NOT_AUTHORIZED);
			assert.strictEqual(puback.properties?.reasonString, undefined);
		});

		it('keeps an unknown topic at "topic name invalid"', async () => {
			const client = await connect(open);
			const puback = await client.publish(`NoSuchResource${++sequence}/a`, 1);
			assert.strictEqual(puback.reasonCode, TOPIC_NAME_INVALID);
		});

		it('delivers a permitted publish and nothing from a refused one', async () => {
			const name = protectedTable();
			const subscriber = await connect(open, { user: superUser });
			await subscriber.subscribe(`${name}/#`);
			const refused = await (await connect(open)).publish(`${name}/a`, 1, 'refused');
			assert.strictEqual(refused.reasonCode, NOT_AUTHORIZED);
			const accepted = await (await connect(open, { user: superUser })).publish(`${name}/a`, 1, 'accepted');
			assert.strictEqual(accepted.reasonCode, 0);
			const delivered = () =>
				subscriber
					.parse()
					.filter((packet) => packet.cmd === 'publish')
					.map((packet) => JSON.parse(packet.payload).value);
			await waitFor(() => delivered().includes('accepted'), { message: () => `delivered ${delivered()}` });
			// the refused publish was answered first, so a leak would have been delivered ahead of the accepted one
			assert.deepStrictEqual(delivered(), ['accepted']);
		});
	});

	/** A subscription the test feeds by hand, so it controls when, and after what, each update arrives. */
	function handFedTopic() {
		const name = `HandFed${++sequence}`;
		const feed = { nexts: 0, returned: 0, deliver: undefined };
		class HandFed extends Resource {
			static subscribe() {
				const iterator = {
					next: () => {
						feed.nexts++;
						return new Promise((resolve) => (feed.deliver = (update) => resolve({ value: update, done: false })));
					},
					return: () => {
						feed.returned++;
						return Promise.resolve({ done: true });
					},
				};
				return { [Symbol.asyncIterator]: () => iterator, end() {} };
			}
		}
		Resources.resources.set(name, HandFed, { mqtt: true });
		return { name, feed };
	}

	async function subscribed(user = superUser, protocolVersion = 5) {
		const { name, feed } = handFedTopic();
		const client = await connect(open, { user, protocolVersion });
		assert.ok(client.sessions.has(client.session), 'the CONNECT did not register a session');
		await client.subscribe(`${name}/#`);
		await waitFor(() => feed.deliver, { message: 'the session never read its subscription' });
		return { name, feed, client };
	}

	const publishesSent = (client) => client.parse().filter((packet) => packet.cmd === 'publish');

	describe('a delivery to a connected session', () => {
		for (const protocolVersion of [4, 5]) {
			it(`sends a plain Uint8Array view as a valid PUBLISH (protocol ${protocolVersion})`, async () => {
				const { name, feed, client } = await subscribed(superUser, protocolVersion);
				// as decoded from the transaction log on a worker other than the publisher's
				const view = new Uint8Array([0xee, 104, 105, 0xee]).subarray(1, 3);
				feed.deliver({ type: 'message', id: 'k', value: { contentType: 'application/octet-stream', data: view } });
				await waitFor(() => publishesSent(client).length === 1, { message: 'no PUBLISH was sent' });
				const [publish] = publishesSent(client);
				assert.strictEqual(publish.topic, `${name}/k`);
				assert.strictEqual(publish.payload.toString(), 'hi');
				assert.strictEqual(client.socket.terminations, 0);
			});

			it(`closes the connection when a message cannot be serialized (protocol ${protocolVersion})`, async () => {
				const { feed, client } = await subscribed(superUser, protocolVersion);
				const error = captureLog('error');
				try {
					const value = {
						toJSON() {
							throw new Error('unserializable');
						},
					};
					feed.deliver({ type: 'message', id: 'k', value });
					await waitFor(() => !client.sessions.has(client.session), { message: 'the session was left registered' });
					assert.strictEqual(client.socket.terminations, 1, 'the connection was left open');
					assert.ok(error.lines.some((line) => line[0]?.message === 'unserializable'));
				} finally {
					error.restore();
				}
			});
		}
	});

	describe('a delivery that reaches a disconnected session', () => {
		it('stops delivering and names the topic at debug level, not as an error', async () => {
			const { name, feed, client } = await subscribed();
			const debug = captureLog('debug');
			const error = captureLog('error');
			try {
				client.socket.handlers.close();
				feed.deliver({ type: 'message', id: 'k', value: { value: 1 }, version: 1 });
				const ours = () => debug.lines.filter((line) => String(line[0]).includes(`${name}/k`));
				await waitFor(() => ours().length > 0, { message: 'no debug line naming the topic' });
				assert.match(String(ours()[0][0]), new RegExp(`disconnected while trying to send message to ${name}/k`));
				// the message built without the topic must be caught too, so the filter is on its wording, not on the fixture's names
				assert.deepStrictEqual(
					error.lines.filter((line) => /disconnected while trying to send/.test(String(line[0]?.message ?? line[0]))),
					[],
					'an expected disconnect race must not be an error'
				);
				await waitFor(() => feed.returned === 1, { message: 'the delivery loop did not stop' });
				assert.strictEqual(feed.nexts, 1, 'the session read past the refused delivery');
				assert.strictEqual(publishesSent(client).length, 0);
				assert.strictEqual(client.sessions.has(client.session), false, 'the session was left registered');
			} finally {
				debug.restore();
				error.restore();
			}
		});

		it('still logs a failed send as an error', async () => {
			const { name, feed, client } = await subscribed();
			const error = captureLog('error');
			try {
				client.socket.send = () => {
					throw new Error(`send failed for ${name}`);
				};
				feed.deliver({ type: 'message', id: 'k', value: { value: 1 }, version: 1 });
				await waitFor(() => error.lines.some((line) => String(line[0]?.message).includes(`send failed for ${name}`)), {
					message: 'the send failure was not logged',
				});
				await waitFor(() => feed.returned === 1, { message: 'the delivery loop did not stop' });
				await waitFor(() => !client.sessions.has(client.session), { message: 'the session was left registered' });
				assert.strictEqual(client.socket.terminations, 1, 'the connection was left open');
			} finally {
				error.restore();
			}
		});
	});

	describe('CONNACK', () => {
		const BAD_CREDENTIALS = 0x86;
		const BAD_CREDENTIALS_311 = 4;
		const NOT_AUTHORIZED_311 = 5;
		const versions = [
			{ name: 'v5', protocolVersion: 5, badCredentials: BAD_CREDENTIALS, notAuthorized: NOT_AUTHORIZED, other: 0x80 },
			{
				name: 'v3.1.1',
				protocolVersion: 4,
				badCredentials: BAD_CREDENTIALS_311,
				notAuthorized: NOT_AUTHORIZED_311,
				other: NOT_AUTHORIZED_311,
			},
		];
		// mqtt-packet reads reasonCode from a v5 CONNACK and returnCode from a 3.1.1 one
		const codeOf = (connack, protocolVersion) => (protocolVersion === 5 ? connack.reasonCode : connack.returnCode);
		let originalGetUser;
		before(() => {
			originalGetUser = server.getUser;
			server.getUser = async () => {
				throw new Error('wrong password');
			};
		});
		after(() => {
			server.getUser = originalGetUser;
			delete open.mqtt.authorizeClient;
			delete open.mqtt.requireAuthentication;
		});
		afterEach(() => {
			delete open.mqtt.authorizeClient;
			delete open.mqtt.requireAuthentication;
		});
		const refuseWith = (error) => {
			open.mqtt.authorizeClient = () => {
				throw error;
			};
		};

		for (const { name, protocolVersion, badCredentials, notAuthorized, other } of versions) {
			describe(name, () => {
				it('refuses a wrong password with the bad-credentials code', async () => {
					const { connack } = await connect(open, { protocolVersion, username: 'someone', password: 'wrong' });
					assert.strictEqual(codeOf(connack, protocolVersion), badCredentials);
				});

				it('refuses an anonymous client when authentication is required with the bad-credentials code', async () => {
					open.mqtt.requireAuthentication = true;
					const { connack } = await connect(open, { protocolVersion });
					assert.strictEqual(codeOf(connack, protocolVersion), badCredentials);
				});

				it('reports an authorizeClient refusal carrying an HTTP 403 statusCode as Not authorized', async () => {
					refuseWith(Object.assign(new Error('denied'), { statusCode: 403 }));
					const { connack } = await connect(open, { protocolVersion });
					assert.strictEqual(codeOf(connack, protocolVersion), notAuthorized);
				});

				it('maps a numeric HTTP status in error.code instead of passing it through', async () => {
					refuseWith(Object.assign(new Error('denied'), { code: 403 }));
					const { connack } = await connect(open, { protocolVersion });
					assert.strictEqual(codeOf(connack, protocolVersion), notAuthorized);
				});

				it('reports an error with no code as a generic refusal', async () => {
					refuseWith(new Error('nope'));
					const { connack } = await connect(open, { protocolVersion });
					assert.strictEqual(codeOf(connack, protocolVersion), other);
				});

				it('sends no code outside the refusal range for an unrelated numeric error.code', async () => {
					refuseWith(Object.assign(new Error('nope'), { code: 500 }));
					const { connack } = await connect(open, { protocolVersion });
					assert.strictEqual(codeOf(connack, protocolVersion), other);
				});
			});
		}

		it('passes on a v5 refusal code the error names, and not to a 3.1.1 client', async () => {
			refuseWith(Object.assign(new Error('banned'), { code: 0x8a }));
			assert.strictEqual((await connect(open, { protocolVersion: 5 })).connack.reasonCode, 0x8a);
			assert.strictEqual((await connect(open, { protocolVersion: 4 })).connack.returnCode, NOT_AUTHORIZED_311);
		});

		it('passes on a 3.1.1 refusal code the error names, and not to a v5 client', async () => {
			refuseWith(Object.assign(new Error('unavailable'), { code: 3 }));
			assert.strictEqual((await connect(open, { protocolVersion: 4 })).connack.returnCode, 3);
			assert.strictEqual((await connect(open, { protocolVersion: 5 })).connack.reasonCode, UNSPECIFIED_ERROR);
		});
	});
});
