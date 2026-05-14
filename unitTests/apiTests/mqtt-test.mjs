'use strict';

/** @typedef {import("mqtt/build").MqttClient} MqttClient */

import assert from 'node:assert/strict';
import { once } from 'node:events';
import { decode } from 'cbor-x';
import { callOperation } from './utility.js';
import { setupTestApp } from './setupTestApp.mjs';
import environmentManager from '#js/utility/environment/environmentManager';
const { get: env_get, setProperty } = environmentManager;
import { connect, connectAsync } from 'mqtt';
import { readFileSync } from 'fs';
import { handleApplication as handleMQTTApplication } from '#src/server/mqtt';

// Adapter: creates a minimal scope and delegates to the new plugin API,
// capturing socket/ws server instances so callers can call .listen() on them.
function startMQTT(config) {
	const serverInstances = [];
	const mockServer = {
		get mqtt() {
			return global.server.mqtt;
		},
		set mqtt(value) {
			global.server.mqtt = value;
		},
		socket(listener, options) {
			const instance = global.server.socket(listener, options);
			serverInstances.push(instance);
			return instance;
		},
		ws(listener, options) {
			const result = global.server.ws(listener, options);
			serverInstances.push(...(Array.isArray(result) ? result : [result]));
			return result;
		},
	};
	handleMQTTApplication({
		options: { getAll: () => config },
		server: mockServer,
	});
	return serverInstances;
}
import axios from 'axios';

async function subscribeAllowingSubackError(client, topic, options) {
	try {
		return await client.subscribeAsync(topic, options);
	} catch (error) {
		if (error.packet?.cmd === 'suback') {
			return error.packet.granted.map((qos) => ({ topic, qos }));
		}
		throw error;
	}
}

async function connectWithMessageListener(brokerUrl, options, listener) {
	const client = connect(brokerUrl, options);
	client.on('message', listener);
	await once(client, 'connect');
	return client;
}

describe('test MQTT connections and commands', function () {
	this.timeout(10000);
	let available_records;
	/** @type {MqttClient} */
	let clientV4;
	/** @type {MqttClient} */
	let clientV5;
	beforeEach(async () => {
		available_records = await setupTestApp();

		clientV4 = await connectAsync('ws://localhost:9926', {
			protocolVersion: 4,
			wsOptions: {
				headers: {
					Accept: 'application/cbor',
				},
			},
		});

		clientV5 = await connectAsync('mqtts://localhost:8883', {
			protocolVersion: 5,
			rejectUnauthorized: false,
		});
	});

	it('subscribe to retained/persisted record', async function () {
		let path = 'VariedProps/' + available_records[1];
		await new Promise((resolve, reject) => {
			const timeout = setTimeout(() => {
				clientV4.off('message', onMessage);
				reject(new Error('Timeout waiting for retained message'));
			}, 1000);
			const onMessage = (topic, payload) => {
				clearTimeout(timeout);
				try {
					assert.equal(topic, path);
					const data = decode(payload);
					assert.ok(data, 'Should have received a valid payload');
					resolve();
				} catch (e) {
					reject(e);
				}
			};
			clientV4.once('message', onMessage);
			clientV4.subscribeAsync(path).catch(reject);
		});
	});
	it('subscribe to retained/persisted record but with retain handling disabling retain messages', async function () {
		let path = 'VariedProps/' + available_records[1];
		await clientV5.subscribeAsync(path, { rh: 2 });
		await new Promise((resolve, reject) => {
			const onMessage = (topic, payload) => {
				decode(payload);
				reject(new Error('Should not receive any retained messages'));
			};
			clientV5.once('message', onMessage);
			setTimeout(() => {
				clientV5.off('message', onMessage);
				resolve();
			}, 50);
		});
	});
	it('subscribe to top level without wildcard should not match record', async function () {
		await clientV5.subscribeAsync('VariedProps/');
		await new Promise((resolve, reject) => {
			const onMessage = () => {
				reject(new Error('Should not receive any top-level messages'));
			};
			clientV5.once('message', onMessage);
			setTimeout(() => {
				clientV5.off('message', onMessage);
				resolve();
			}, 50);
		});
	});

	it('can repeatedly publish', async () => {
		const vus = 5;
		const tableName = 'SimpleRecord';
		let intervals = [];
		let clients = [];
		let received = [];
		let subscriptions = [];
		for (let x = 1; x < vus + 1; x++) {
			const topic = `${tableName}/1`;

			/** @type {MqttClient} */
			const client = await connectAsync({
				clientId: `vu${x}`,
				host: 'localhost',
				clean: true,
				connectTimeout: 2000,
				protocol: 'mqtt',
				protocolVersion: 4,
			});
			clients.push(client);
			subscriptions.push(
				(async () => {
					await client.subscribeAsync(topic);
					intervals.push(
						setInterval(() => {
							client.publish(topic, JSON.stringify({ name: 'radbot 9000', pub_time: Date.now() }), {
								qos: 1,
								retain: false,
							});
						}, 1)
					);
				})()
			);

			client.on('message', function (topic, message) {
				// message is Buffer
				let obj = JSON.parse(message.toString());
				received.push(obj);
			});

			client.on('error', function (error) {
				// message is Buffer
				console.error(error);
			});
		}
		await Promise.all(subscriptions);
		await new Promise((resolve) => setTimeout(resolve, 200));
		for (let interval of intervals) clearInterval(interval);
		await new Promise((resolve) => setTimeout(resolve, 20));
		for (let client of clients) client.end();
		assert(received.length > 10);
		assert.equal(received[0].name, 'radbot 9000');
	});

	it('last will should be published on connection loss', async () => {
		const topic = `SimpleRecord/52`;

		/** @type {MqttClient} */
		const client_to_die = await connectAsync({
			host: 'localhost',
			clean: true,
			protocolVersion: 4,
			will: {
				topic,
				payload: JSON.stringify({ name: 'last will and testimony' }),
				qos: 1,
				retain: false,
			},
		});

		await clientV4.subscribeAsync(topic);

		await new Promise((resolve, reject) => {
			clientV4.once('message', function (topic, message) {
				try {
					let data = decode(message);
					// message is Buffer
					assert.deepEqual(data, { name: 'last will and testimony' });
					resolve();
				} catch (error) {
					reject(error);
				}
			});
			client_to_die.end(true); // this closes the connection without a disconnect packet
		});
	});

	it('last will should not be published on explicit disconnect', async () => {
		const topic = `SimpleRecord/53`;
		const client_to_die = await connectAsync({
			host: 'localhost',
			clean: true,
			protocolVersion: 4,
			will: {
				topic,
				payload: JSON.stringify({ name: 'last will and testimony' }),
				qos: 1,
				retain: false,
			},
		});
		let onMessage;
		await clientV4.subscribeAsync(topic);

		await new Promise((resolve, reject) => {
			onMessage = function (topic) {
				try {
					reject('Should not get a message on topic ' + topic);
				} catch (error) {
					reject(error);
				}
			};
			clientV4.once('message', onMessage);
			setTimeout(resolve, 50);
			client_to_die.end(); // this closes the connection with a disconnect packet
		});

		clientV4.off('message', onMessage);
	});

	it('can publish non-JSON', async () => {
		const topic = `SimpleRecord/51`;
		const client = await connectAsync({
			host: 'localhost',
			clean: true,
			connectTimeout: 2000,
			protocol: 'mqtt',
			protocolVersion: 4,
		});
		await client.subscribeAsync(topic);
		await new Promise((resolve) => {
			client.publish(topic, Buffer.from([1, 2, 3, 4, 5]), {
				qos: 1,
				retain: false,
			});

			client.on('message', function (topic, message) {
				// message is Buffer
				assert.deepEqual(Array.from(message), [1, 2, 3, 4, 5]);
				resolve();
			});

			client.on('error', function (error) {
				// message is Buffer
				console.error(error);
			});
		});
	});
	it('publish and subscribe are restricted', async () => {
		const topic = `SimpleRecord/51`;
		const client_authorized = await connectAsync({
			host: 'localhost',
			clean: true,
			connectTimeout: 2000,
			protocol: 'mqtt',
			protocolVersion: 4,
		});
		const client = await connectAsync({
			host: 'localhost',
			clean: true,
			connectTimeout: 2000,
			protocol: 'mqtt',
			protocolVersion: 4,
			username: 'restricted',
			password: 'restricted',
			will: {
				topic,
				payload: JSON.stringify({ name: 'last will and testimony that should not be published' }),
				qos: 1,
			},
		});
		let published_messages = [];
		const granted = await subscribeAllowingSubackError(client, topic);
		assert.equal(granted[0].qos, 128);
		await client_authorized.subscribeAsync(topic);

		await new Promise((resolve) => {
			client.publish(topic, JSON.stringify({ name: 'should not be published ' }), {
				qos: 1,
				retain: false,
			});
			client_authorized.on('message', function (topic) {
				published_messages.push(topic);
			});

			client.on('error', function (error) {
				// message is Buffer
				console.error('Error connecting to restricted client', error);
			});
			setTimeout(resolve, 50);
		});
		client.end(true); // force close to trigger the will message
		await delay(50);
		assert.equal(published_messages.length, 0);
	});
	it('can not subscribe to resource with mqtt export disabled', async () => {
		const client = await connectAsync({
			host: 'localhost',
			clean: true,
			connectTimeout: 2000,
			protocolVersion: 4,
		});
		const granted = await subscribeAllowingSubackError(client, 'Related/#');
		assert.equal(granted[0].qos, 128);
	});

	it('subscribe to retained record with upsert operation', async function () {
		let path = 'SimpleRecord/77';
		let client = await connectAsync('mqtt://localhost:1883', {
			protocolVersion: 4,
		});
		await new Promise((resolve, reject) => {
			client.subscribeAsync(path).catch(reject);
			client.once('message', (topic, payload) => {
				JSON.parse(payload);
				resolve();
			});
			callOperation({
				operation: 'upsert',
				schema: 'data',
				table: 'SimpleRecord',
				records: [
					{
						id: '77',
						name: 'test record from operation',
					},
				],
			}).then(
				(response) => {
					response.json().then((data) => {
						console.log(data);
					});
				},
				(error) => {
					reject(error);
				}
			);
		});
		client.end();
	});
	it('subscribe to retained record with patch operations', async function () {
		let path = 'SimpleRecord/78';
		let client = await connectAsync('mqtt://localhost:1883', {
			clean: false,
			clientId: 'with-patches',
			protocolVersion: 4,
		});
		let headers = {
			'Content-Type': 'application/json',
		};

		await new Promise(async (resolve) => {
			let messages = [];
			const onMessage = (topic, payload) => {
				let record = JSON.parse(payload);
				messages.push(record);
				if (messages.length === 2) {
					assert.equal(messages[0].name, 'a starting point');
					assert.equal(messages[0].count, 2);
					assert.equal(messages[1].count, 3);
					assert.equal(messages[1].name, 'an updated name');
					assert.equal(messages[1].newProperty, 'new value');
					resolve();
					client.off('message', onMessage);
				}
			};
			client.on('message', onMessage);
			await client.subscribeAsync(path, { qos: 1 });
			await axios.put('http://localhost:9926/SimpleRecord/78', { name: 'a starting point', count: 2 }, { headers });
			// Small delay so the PUT notification is delivered before the PATCH; without this the
			// two messages can arrive out of order on a loaded CI runner.
			await delay(20);
			await axios.patch(
				'http://localhost:9926/SimpleRecord/78',
				{ name: 'an updated name', newProperty: 'new value', count: { __op__: 'add', value: 1 } },
				{ headers }
			);
		});
		await client.endAsync();
		// Give the broker time to fully process the disconnect before we make more patches,
		// so those patches are queued for the offline client rather than delivered live.
		await delay(50);
		await axios.patch(
			'http://localhost:9926/SimpleRecord/78',
			{ name: 'update 2', newProperty: 'newer value', count: { __op__: 'add', value: 1 } },
			{ headers }
		);
		await axios.patch(
			'http://localhost:9926/SimpleRecord/78',
			{ name: 'update 3', count: { __op__: 'add', value: 1 } },
			{ headers }
		);
		await new Promise(async (resolve, reject) => {
			let messages = [];
			client = await connectWithMessageListener(
				'mqtt://localhost:1883',
				{
					clean: false,
					clientId: 'with-patches',
					protocolVersion: 4,
				},
				(topic, payload, _packet) => {
					let record = JSON.parse(payload);
					messages.push(record);
					if (messages.length == 3) {
						assert.equal(messages[0].name, 'update 2');
						assert.equal(messages[0].count, 4);
						assert.equal(messages[1].newProperty, 'newer value');
						assert.equal(messages[1].name, 'update 3');
						assert.equal(messages[1].count, 5);
						assert.equal(messages[2].name, 'update 4');
						assert.equal(messages[2].count, 6);
						resolve();
					}
				}
			);
			client.on('error', reject);
			await axios.patch(
				'http://localhost:9926/SimpleRecord/78',
				{ name: 'update 4', count: { __op__: 'add', value: 1 } },
				{ headers }
			);
		});

		client.end();
	});
	it('subscribe twice', async function () {
		let client = await connectAsync('mqtt://localhost:1883', {
			clean: true,
			clientId: 'test-client-sub2',
			protocolVersion: 4,
		});
		await client.subscribeAsync('SimpleRecord/22', { qos: 1 });
		await client.subscribeAsync('SimpleRecord/22', { qos: 1 });

		await new Promise((resolve) => {
			client.once('message', (topic, payload) => {
				JSON.parse(payload);
				resolve();
			});
			client.publish(
				'SimpleRecord/22',
				JSON.stringify({
					name: 'This is a test again',
				}),
				{
					retain: false,
					qos: 1,
				}
			);
		});
		await client.endAsync();
	});
	it('received binary/string messages', async function () {
		let client = await connectAsync('mqtt://localhost:1883', {
			clean: true,
			clientId: 'test-client-sub2',
			protocolVersion: 4,
		});
		await client.subscribeAsync('SimpleRecord/22', { qos: 0 });
		await new Promise((resolve) => {
			client.on('message', (topic, payload) => {
				assert.equal(payload.toString(), 'This is a test of a plain string');
				resolve();
			});
			client.publish('SimpleRecord/22', 'This is a test of a plain string', {
				retain: true,
				qos: 1,
			});
		});
		await client.endAsync();
		client = await connectAsync('mqtt://localhost:1883', {
			clean: true,
			clientId: 'test-client-sub2',
			protocolVersion: 4,
		});
		await new Promise((resolve, reject) => {
			client.on('message', (topic, payload) => {
				assert.equal(payload.toString(), 'This is a test of a plain string');
				resolve();
			});

			client.subscribeAsync('SimpleRecord/22', { qos: 0 }).catch(reject);
		});
		await client.endAsync();
	});
	it('subscribe and unsubscribe with mTLS', async function () {
		let server;
		await new Promise((resolve, reject) => {
			server = startMQTT({
				server: global.server,
				network: { securePort: 8884, mtls: { user: 'HDB_ADMIN', required: true } },
			})[0].listen(8884, resolve);
			server.on('error', reject);
		});
		let bad_client = await connectAsync('mqtts://localhost:8884', {
			clientId: 'test-bad-mtls',
			protocolVersion: 4,
			reconnectPeriod: 0,
		}).catch(() => null);

		const private_key_path = env_get('tls_privateKey');
		let cert, ca;
		for await (const certificate of databases.system.hdb_certificate.search([])) {
			if (certificate.is_authority) ca = certificate.certificate;
			else if (certificate.name === 'localhost') cert = certificate.certificate;
		}
		let client = await connectAsync('mqtts://localhost:8884', {
			key: readFileSync(private_key_path),
			// if they have a CA, we append it, so it is included
			cert,
			ca,
			clean: true,
			clientId: 'test-client-mtls',
			protocolVersion: 4,
		});

		if (bad_client && bad_client.connected) {
			throw new Error('Client should not be able to connect to mTLS without a certificate');
		}

		await client.subscribeAsync('SimpleRecord/23', { qos: 1 });
		await client.unsubscribeAsync('SimpleRecord/23');

		await new Promise((resolve, reject) => {
			client.on('message', (topic, payload) => {
				JSON.parse(payload);
				reject('Should not receive a message that we are unsubscribed to');
			});
			client.publish(
				'SimpleRecord/23',
				JSON.stringify({
					name: 'This is a test again',
				}),
				{
					retain: false,
					qos: 1,
				}
			);
			setTimeout(resolve, 50);
		});
		client.end();
	});
	it('subscribe and unsubscribe with WSS mTLS', async function () {
		let server;
		try {
			await new Promise((resolve, reject) => {
				setProperty('http_mtls', { user: 'HDB_ADMIN', required: true });
				server = startMQTT({
					server: global.server,
					webSocket: {
						securePort: 8885,
						network: { mtls: { user: 'HDB_ADMIN', required: true } },
					},
				})[0].listen(8885, resolve);
				server.on('error', reject);
			});

			const private_key_path = env_get('tls_privateKey');
			let cert, ca;
			for await (const certificate of databases.system.hdb_certificate.search([])) {
				if (certificate.is_authority) ca = certificate.certificate;
				else if (certificate.name === 'localhost') cert = certificate.certificate;
			}
			let bad_client = await connectAsync('wss://localhost:8885', {
				reconnectPeriod: 0,
				clientId: 'test-bad-mtls',
				protocolVersion: 4,
			}).catch(() => null);
			let client = await connectAsync('wss://localhost:8885', {
				key: readFileSync(private_key_path),
				// if they have a CA, we append it, so it is included
				cert,
				ca,
				clean: true,
				reconnectPeriod: 0,
				clientId: 'test-client-mtls',
				protocolVersion: 4,
			});

			if (bad_client && bad_client.connected) {
				throw new Error('Client should not be able to connect to mTLS without a certificate');
			}

			await subscribeAllowingSubackError(client, 'SimpleRecord/23', { qos: 1 });
			await client.unsubscribeAsync('SimpleRecord/23');
			await new Promise((resolve, reject) => {
				client.on('message', (topic, payload) => {
					JSON.parse(payload);
					reject('Should not receive a message that we are unsubscribed to');
				});
				client.publish(
					'SimpleRecord/23',
					JSON.stringify({
						name: 'This is a test again',
					}),
					{
						retain: false,
						qos: 1,
					}
				);
				setTimeout(resolve, 50);
			});
			client.end();
		} finally {
			setProperty('http_mtls', false);
		}
	});

	it('subscribe to bad topic', async function () {
		const granted = await subscribeAllowingSubackError(clientV5, 'DoesNotExist/+');
		assert.equal(granted[0].qos, 0x8f);
	});
	it('Invalid packet', async function () {
		let client = await connectAsync('mqtt://localhost:1883', {
			clean: true,
			clientId: 'test-client1',
			protocolVersion: 4,
		});
		// directly send an invalid packet, which should cause the connection to close
		client.stream.write(Buffer.from([67, 255]));

		await new Promise((resolve) => {
			client.on('close', resolve);
		});
	});

	const wildcardsTests = () =>
		async function () {
			const topic_expectations = {
				//'SimpleRecord/+': ['SimpleRecord/', 'SimpleRecord/44', 'SimpleRecord/47'],
				'SimpleRecord/+/33': ['SimpleRecord/sub/33'],
				'SimpleRecord/sub/+': ['SimpleRecord/sub/33'],
				'SimpleRecord/sub/+/33': ['SimpleRecord/sub/sub2/33'],
				'SimpleRecord/+/+/+': ['SimpleRecord/sub/sub2/33'],
				'SimpleRecord/+/sub2/+': ['SimpleRecord/sub/sub2/33'],
				'SimpleRecord/+/+': ['SimpleRecord/sub/33'],
				'SimpleRecord/sub/#': ['SimpleRecord/sub/33', 'SimpleRecord/sub/sub2/33'],
				'SimpleRecord/+/sub2/#': ['SimpleRecord/sub/sub2/33'],
			};
			for (const subscription_topic in topic_expectations) {
				let expected_topics = topic_expectations[subscription_topic];
				await clientV5.subscribeAsync(subscription_topic);
				let message_count = 0;
				let message_listener;
				await new Promise((resolve) => {
					clientV5.on(
						'message',
						(message_listener = (topic, payload) => {
							assert(expected_topics.includes(topic));
							let record = JSON.parse(payload);
							assert(record.name);
							if (++message_count == expected_topics.length) resolve();
						})
					);
					clientV5.publish(
						'SimpleRecord/44',
						JSON.stringify({
							name: 'This is a test 1',
						}),
						{
							retain: false,
							qos: 1,
						}
					);
					clientV5.publish(
						'SimpleRecord/sub/33',
						JSON.stringify({
							name: 'This is a test to a sub-topic',
						}),
						{
							retain: false,
							qos: 1,
						}
					);
					clientV5.publish(
						'SimpleRecord/sub/sub2/33',
						JSON.stringify({
							name: 'This is a test to a deeper sub-topic',
						}),
						{
							retain: false,
							qos: 1,
						}
					);

					clientV4.publish(
						'SimpleRecord/47',
						JSON.stringify({
							name: 'This is a test 2',
						}),
						{
							retain: true,
							qos: 1,
						}
					);

					clientV4.publish(
						'SimpleRecord/',
						JSON.stringify({
							name: 'This is a test to the generic table topic',
						}),
						{
							qos: 1,
						}
					);
				});
				clientV5.off('message', message_listener);
				await clientV5.unsubscribeAsync(subscription_topic);
			}
		};
	it('subscribe to single-level wildcard/full table', wildcardsTests());
	it('subscribe to multi-level wildcard/full table', async function () {
		await clientV5.subscribeAsync('SimpleRecord/#');
		let message_count = 0;
		let message_listener;
		await new Promise((resolve) => {
			clientV5.on(
				'message',
				(message_listener = (topic, payload) => {
					let record = JSON.parse(payload);
					assert(record.name);
					if (++message_count == 4) resolve();
				})
			);
			clientV5.publish(
				'SimpleRecord/44',
				JSON.stringify({
					name: 'This is a test 1',
				}),
				{
					retain: false,
					qos: 1,
				}
			);
			clientV5.publish(
				'SimpleRecord/sub/33',
				JSON.stringify({
					name: 'This is a test to a sub-topic', // should go to multi-level wildcard
				}),
				{
					retain: false,
					qos: 1,
				}
			);

			clientV4.publish(
				'SimpleRecord/47',
				JSON.stringify({
					name: 'This is a test 2',
				}),
				{
					retain: true,
					qos: 1,
				}
			);

			clientV4.publish(
				'SimpleRecord/',
				JSON.stringify({
					name: 'This is a test to the generic table topic',
				}),
				{
					qos: 1,
				}
			);
		});
		clientV5.off('message', message_listener);
		await clientV5.unsubscribeAsync('SimpleRecord/#');
	});
	it('subscribe to wildcards we do not support', async function () {
		await assert.rejects(clientV5.subscribeAsync('SimpleRecord/+test'), /Invalid topic/);
		const granted = await subscribeAllowingSubackError(clientV5, '+/SimpleRecord/test');
		assert.equal(granted[0].qos, 0x8f); // assert that the subscription was rejected
	});
	it('subscribe with QoS=1 and reconnect with non-clean session', async function () {
		// this first connection is a tear down to remove any previous durable session with this id
		let client = await connectAsync('mqtt://localhost:1883', {
			clean: true,
			clientId: 'test-client1',
			protocolVersion: 4,
		});
		await client.endAsync();
		await delay(10);
		client = await connectAsync('mqtt://localhost:1883', {
			clean: false,
			clientId: 'test-client1',
			protocolVersion: 4,
		});
		await client.subscribeAsync(['SimpleRecord/41', 'SimpleRecord/42'], { qos: 1 });
		await client.endAsync();
		await delay(10);
		client = await connectAsync('mqtt://localhost:1883', {
			clean: false,
			clientId: 'test-client1',
			protocolVersion: 4,
		});
		await new Promise((resolve) => {
			client.on('message', (topic, payload) => {
				JSON.parse(payload);
				resolve();
			});

			client.publish(
				'SimpleRecord/41',
				JSON.stringify({
					name: 'This is a test of durable session with subscriptions restarting',
				}),
				{
					qos: 1,
				}
			);
		});
		await delay(10);
		await client.endAsync();
		await delay(50);
		clientV5.publish(
			'SimpleRecord/41',
			JSON.stringify({
				name: 'This is a test of publishing to a disconnected durable session',
			}),
			{
				qos: 1,
			}
		);
		await clientV5.publishAsync(
			'SimpleRecord/42',
			JSON.stringify({
				name: 'This is a test of publishing to a disconnected durable session 2',
			}),
			{
				qos: 1,
			}
		);
		await clientV5.publishAsync(
			'SimpleRecord/42',
			JSON.stringify({
				name: 'This is a test of publishing to a disconnected durable session 3',
			}),
			{
				qos: 1,
			}
		);
		await delay(10);
		let messages = [];
		client = await connectWithMessageListener(
			'mqtt://localhost:1883',
			{
				clean: false,
				clientId: 'test-client1',
				protocolVersion: 5,
				properties: {
					sessionExpiryInterval: 3600,
				},
			},
			(topic, message) => {
				messages.push(message.toString());
			}
		);
		await new Promise((resolve) => {
			const interval = setInterval(() => {
				if (messages.length === 3) {
					clearInterval(interval);
					resolve();
				}
			}, 1);
		});
		await delay(50);
		await client.endAsync();
		if (messages.length !== 3) console.error('Incorrect messages', { messages });
		assert(messages.length === 3);
	});
	it('subscribe with QoS=2', async function () {
		// this first connection is a tear down to remove any previous durable session with this id
		let client = await connectAsync('mqtt://localhost:1883', {
			clean: true,
			clientId: 'test-client1',
			protocolVersion: 4,
		});
		await client.end();
		await delay(10);
		client = await connectAsync('mqtt://localhost:1883', {
			clean: false,
			clientId: 'test-client1',
			protocolVersion: 4,
		});
		await client.subscribeAsync('SimpleRecord/41', { qos: 2 });
		await new Promise((resolve) => {
			client.on('message', (topic, payload) => {
				JSON.parse(payload);
				resolve();
			});

			client.publish(
				'SimpleRecord/41',
				JSON.stringify({
					name: 'This is a test of a message with qos 2',
				}),
				{
					qos: 2,
				}
			);
		});
		client.end();
	});
	it('connection events', async function () {
		let events_received = [];
		server.mqtt.events.on('connection', (_a1, _a2) => {
			events_received.push('connection');
		});
		server.mqtt.events.on('connected', (_a1, _a2) => {
			events_received.push('connected');
		});
		server.mqtt.events.on('disconnected', (_a1, _a2) => {
			events_received.push('disconnected');
		});
		server.mqtt.events.on('error', (_a1, _a2) => {
			events_received.push('error');
		});
		let client = await connectAsync('mqtt://localhost:1883', {
			clean: true,
			clientId: 'test-client1',
			protocolVersion: 4,
		});
		await subscribeAllowingSubackError(client, 'this does not exist', { qos: 1 });
		client.end();
		await new Promise((resolve) => {
			setTimeout(resolve, 20);
		});
		assert(events_received.includes('connection'));
		assert(events_received.includes('connected'));
		assert(events_received.includes('disconnected'));
		assert(events_received.includes('error'));
	});
	it('subscribe root with history', async function () {
		// this first connection is a tear down to remove any previous durable session with this id
		let client = await connectAsync('mqtt://localhost:1883', {
			clean: true,
			clientId: 'test-client1',
			protocolVersion: 4,
		});
		let messages = [];
		client.on('message', (topic, payload) => {
			messages.push(topic, payload.length > 0 ? JSON.parse(payload) : 'deleted');
		});
		await client.subscribeAsync('FourPropWithHistory/#', { qos: 1 });
		await delay(300);

		const { FourPropWithHistory } = await import('../testApp/resources.js');
		assert.equal(messages.length, 20);
		assert.equal(FourPropWithHistory.acknowledgements, 10);
		await FourPropWithHistory.put('something new', { name: 'something new' });
		await delay(50);
		assert.equal(messages.length, 22);
		assert.equal(FourPropWithHistory.acknowledgements, 11);
		client.end();
	});
	// This requires https://github.com/HarperFast/harper/issues/147 to be re-enabled
	it.skip('subscribe sub-topic with history', async function () {
		// this first connection is a tear down to remove any previous durable session with this id
		const { FourPropWithHistory } = await import('../testApp/resources.js');
		tables.FourProp.acknowledgements = 0; // reset
		let client = await connectAsync('mqtt://localhost:1883', {
			clean: true,
			clientId: 'test-client1',
			protocolVersion: 4,
		});
		let messages = [];
		client.on('message', (topic, payload) => {
			messages.push(topic, payload.length > 0 ? JSON.parse(payload) : 'deleted');
		});
		await client.subscribeAsync('FourPropWithHistory/12', { qos: 1 });
		await delay(300);
		assert.equal(messages.length, 4);
		assert.equal(FourPropWithHistory.acknowledgements, 2);
	});
	it('publish and receive blob data', async function () {
		const topic = `SimpleRecord/52`;
		const testString = 'this is a test of blobs'.repeat(1000);
		await clientV5.subscribeAsync(topic);
		clientV5.publish(topic, JSON.stringify({ name: 'testBlob', blobData: testString }), {
			qos: 1,
			retain: false,
		});

		await new Promise((resolve, reject) => {
			clientV5.once('message', function (topic, message) {
				try {
					let data = JSON.parse(message);
					// message is Buffer
					assert.equal(data.blobData, testString);
					resolve();
				} catch (error) {
					reject(error);
				}
			});
		});
	});

	after(() => {
		clientV4?.end();
		clientV5?.end();
	});
});
function delay(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
