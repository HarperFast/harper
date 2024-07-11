'use strict';

import { assert, expect } from 'chai';
import { decode, encode, DecoderStream } from 'cbor-x';
import { getVariables, callOperation } from './utility.js';
import { setupTestApp } from './setupTestApp.mjs';
import { get as env_get, setProperty } from '../../utility/environment/environmentManager.js';
import { connect } from 'mqtt';
import { readFileSync } from 'fs';
import { start as startMQTT } from '../../ts-build/server/mqtt.js';
import axios from 'axios';
import {
	setNATSReplicator,
	setPublishToStream,
	publishToStream,
	setSubscription,
} from '../../ts-build/server/nats/natsReplicator.js';
const { authorization, url } = getVariables();
describe('test MQTT connections and commands', () => {
	let available_records;
	let client, client2;
	let natsPublishToStream = publishToStream;
	let natsSetSubscription = setSubscription;
	let replicated_published_messages = [];
	before(async () => {
		available_records = await setupTestApp();
		setPublishToStream(
			(subject, stream, header, message) => {
				replicated_published_messages.push(message);
			},
			() => {}
		);
		setNATSReplicator('SimpleRecord', 'data', tables.SimpleRecord);

		client = connect('ws://localhost:9926', {
			wsOptions: {
				headers: {
					Accept: 'application/cbor',
				},
			},
		});

		await new Promise((resolve, reject) => {
			client.on('connect', resolve);
			client.on('error', reject);
		});
		client2 = connect('mqtts://localhost:8883', {
			protocolVersion: 5,
			rejectUnauthorized: false,
		});
		await new Promise((resolve, reject) => {
			client2.on('connect', (connack) => {
				resolve();
			});
			client2.on('error', (error) => {
				reject(error);
			});
		});
	});

	it('subscribe to retained/persisted record', async function () {
		let path = 'VariedProps/' + available_records[1];
		await new Promise((resolve, reject) => {
			client.subscribe(path, function (err) {
				if (err) reject(err);
				else {
					//	client.publish('VariedProps/' + available_records[2], 'Hello mqtt')
				}
			});
			client.once('message', (topic, payload, packet) => {
				let record = decode(payload);
				resolve();
			});
		});
	});
	it('subscribe to retained/persisted record but with retain handling disabling retain messages', async function () {
		let path = 'VariedProps/' + available_records[1];
		await new Promise((resolve, reject) => {
			client2.subscribe(path, { rh: 2 }, function (err) {
				if (err) reject(err);
			});
			const onMessage = (topic, payload, packet) => {
				let record = decode(payload);
				console.log(topic, record);
				reject(new Error('Should not receive any retained messages'));
			};
			client2.once('message', onMessage);
			setTimeout(() => {
				client2.off('message', onMessage);
				resolve();
			}, 50);
		});
	});

	it('can repeatedly publish', async () => {
		const vus = 5;
		const tableName = 'SimpleRecord';
		let intervals = [];
		let clients = [];
		let published = 0;
		let received = [];
		let subscriptions = [];
		for (let x = 1; x < vus + 1; x++) {
			const topic = `${tableName}/1`;
			const client = connect({
				clientId: `vu${x}`,
				host: 'localhost',
				clean: true,
				connectTimeout: 2000,
				protocol: 'mqtt',
			});
			clients.push(client);
			subscriptions.push(
				new Promise((resolve) => {
					client.on('connect', function (connack) {
						client.subscribe(topic, function (err) {
							if (!err) {
								resolve();
								intervals.push(
									setInterval(() => {
										published++;
										client.publish(topic, JSON.stringify({ name: 'radbot 9000', pub_time: Date.now() }), {
											qos: 1,
											retain: false,
										});
									}, 1)
								);
							}
						});
					});
				})
			);

			client.on('message', function (topic, message) {
				let now = Date.now();
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
		//console.log({ published, received });
		assert(replicated_published_messages.length > 10);
	});

	it('last will should be published on connection loss', async () => {
		const topic = `SimpleRecord/52`;
		const client_to_die = connect({
			host: 'localhost',
			clean: true,
			will: {
				topic,
				payload: JSON.stringify({ name: 'last will and testimony' }),
				qos: 1,
				retain: false,
			},
		});
		await new Promise((resolve, reject) => {
			client_to_die.on('connect', function (connack) {
				resolve(connack);
			});
			client_to_die.on('error', reject);
		});
		await new Promise((resolve, reject) => {
			client.subscribe(topic, function (err) {
				if (err) reject(err);
			});

			client.once('message', function (topic, message) {
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
		const client_to_die = connect({
			host: 'localhost',
			clean: true,
			will: {
				topic,
				payload: JSON.stringify({ name: 'last will and testimony' }),
				qos: 1,
				retain: false,
			},
		});
		let onMessage;
		await new Promise((resolve, reject) => {
			client_to_die.on('connect', function (connack) {
				resolve(connack);
			});
			client_to_die.on('error', reject);
		});
		await new Promise((resolve, reject) => {
			client.subscribe(topic, function (err) {
				if (err) reject(err);
			});
			onMessage = function (topic, message) {
				try {
					reject('Should not get a message on topic ' + topic);
				} catch (error) {
					reject(error);
				}
			};
			client.once('message', onMessage);
			setTimeout(resolve, 50);
			client_to_die.end(); // this closes the connection with a disconnect packet
		});

		client.off('message', onMessage);
	});

	it('can publish non-JSON', async () => {
		const topic = `SimpleRecord/51`;
		const client = connect({
			host: 'localhost',
			clean: true,
			connectTimeout: 2000,
			protocol: 'mqtt',
		});
		await new Promise((resolve) => {
			client.on('connect', function (connack) {
				client.subscribe(topic, function (err) {
					console.error(err);
					client.publish(topic, Buffer.from([1, 2, 3, 4, 5]), {
						qos: 1,
						retain: false,
					});
				});
			});

			client.on('message', function (topic, message) {
				let now = Date.now();
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
		const client_authorized = connect({
			host: 'localhost',
			clean: true,
			connectTimeout: 2000,
			protocol: 'mqtt',
		});
		const client = connect({
			host: 'localhost',
			clean: true,
			connectTimeout: 2000,
			protocol: 'mqtt',
			username: 'restricted',
			password: 'restricted',
			will: {
				topic,
				payload: JSON.stringify({ name: 'last will and testimony that should not be published' }),
				qos: 1,
			}
		});
		let published_messages = [];
		await new Promise((resolve, reject) => {
			client.on('connect', function () {
				client.subscribe(topic, function (err, subscriptions) {
					assert.equal(subscriptions[0].qos, 128);
					client_authorized.subscribe(topic, function (err, subscriptions) {
						console.log(err);
						client.publish(topic, JSON.stringify({ name: 'should not be published ' }), {
							qos: 1,
							retain: false,
						});
						setTimeout(resolve, 50);
					});
				});
			});

			client_authorized.on('message', function (topic, message) {
				published_messages.push(topic);
			});

			client.on('error', function (error) {
				// message is Buffer
				console.error('Error connecting to restricted client', error);
				reject(error);
			});
		});
		client.end(true); // force close to trigger the will message
		await delay(50);
		assert.equal(published_messages.length, 0);
	});
	it('subscribe to retained record with upsert operation', async function () {
		let path = 'SimpleRecord/77';
		let client;
		await new Promise((resolve, reject) => {
			client = connect('mqtt://localhost:1883');
			client.on('connect', resolve);
			client.on('error', reject);
		});
		console.log('connected for retained record test');
		await new Promise((resolve, reject) => {
			client.subscribe(path, function (err) {
				//console.log('subscribed', err);
				if (err) reject(err);
				else {
					//	client.publish('VariedProps/' + available_records[2], 'Hello mqtt')
				}
			});
			client.once('message', (topic, payload, packet) => {
				let record = JSON.parse(payload);
				console.log('got message', topic, record);
				resolve();
			});
			console.log('trying to call upsert operation');
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
					console.log('got response', response.status);
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
		let client;
		await new Promise((resolve, reject) => {
			client = connect('mqtt://localhost:1883', {
				clean: false,
				clientId: 'with-patches',
			});
			client.on('connect', resolve);
			client.on('error', reject);
		});
		let headers = {
			'Content-Type': 'application/json',
		};

		await new Promise(async (resolve, reject) => {
			let messages = [];
			client.subscribe(path, { qos: 1 }, function (err) {
				if (err) reject(err);
			});
			let last_sent = 0;
			const onMessage = (topic, payload, packet) => {
				console.log('got message', performance.now());
				let record = JSON.parse(payload);
				messages.push(record);
				if (messages.length == 2) {
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
			console.log('sent message', performance.now());
			await axios.put('http://localhost:9926/SimpleRecord/78', { name: 'a starting point', count: 2 }, { headers });
			console.log('sent message', performance.now());
			await axios.patch(
				'http://localhost:9926/SimpleRecord/78',
				{ name: 'an updated name', newProperty: 'new value', count: { __op__: 'add', value: 1 } },
				{ headers }
			);
			console.log('finished patch');
		});
		await new Promise((resolve) => client.end(resolve));
		await delay(10);
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
			client = connect('mqtt://localhost:1883', {
				clean: false,
				clientId: 'with-patches',
			});
			client.on('error', reject);
			client.on('message', (topic, payload, packet) => {
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
			});
			await axios.patch(
				'http://localhost:9926/SimpleRecord/78',
				{ name: 'update 4', count: { __op__: 'add', value: 1 } },
				{ headers }
			);
		});

		client.end();
	});
	it('subscribe twice', async function () {
		let client = connect('mqtt://localhost:1883', {
			clean: true,
			clientId: 'test-client-sub2',
		});
		await new Promise((resolve, reject) => {
			client.on('connect', resolve);
			client.on('error', reject);
		});
		await new Promise((resolve, reject) => {
			client.subscribe(
				'SimpleRecord/22',
				{
					qos: 1,
				},
				function (err) {
					if (err) reject(err);
					else {
						client.subscribe(
							'SimpleRecord/22',
							{
								qos: 1,
							},
							function (err) {
								if (err) reject(err);
								else resolve();
							}
						);
					}
				}
			);
		});
		await new Promise((resolve, reject) => {
			client.on('message', (topic, payload, packet) => {
				let record = JSON.parse(payload);
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
		client.end();
	});
	it('received binary/string messages', async function () {
		let client = connect('mqtt://localhost:1883', {
			clean: true,
			clientId: 'test-client-sub2',
		});
		await new Promise((resolve, reject) => {
			client.on('connect', resolve);
			client.on('error', reject);
		});
		await new Promise((resolve, reject) => {
			client.subscribe(
				'SimpleRecord/22',
				{
					qos: 0,
				},function (err) {
					if (err) reject(err);
					else resolve();
				}
			);
		});
		await new Promise((resolve, reject) => {
			client.on('message', (topic, payload, packet) => {
				assert.equal(payload.toString(), 'This is a test of a plain string');
				resolve();
			});
			client.publish(
				'SimpleRecord/22',
				'This is a test of a plain string',
				{
					retain: true,
					qos: 1,
				}
			);
		});
		client.end();
		client = connect('mqtt://localhost:1883', {
			clean: true,
			clientId: 'test-client-sub2',
		});
		await new Promise((resolve, reject) => {
			client.on('connect', resolve);
			client.on('error', reject);
		});
		await new Promise((resolve, reject) => {
			client.on('message', (topic, payload, packet) => {
				assert.equal(payload.toString(), 'This is a test of a plain string');
				resolve();
			});

			client.subscribe(
				'SimpleRecord/22',
				{
					qos: 0,
				},function (err) {
					if (err) reject(err);
				}
			);
		});
	});
	it('subscribe and unsubscribe with mTLS', async function () {
		let server;
		await new Promise((resolve, reject) => {
			server = startMQTT({
				server: global.server,
				securePort: 8884,
				network: { mtls: { user: 'HDB_ADMIN', required: true } },
			}).listen(8884, resolve);
			server.on('error', reject);
		});
		let bad_client = connect('mqtts://localhost:8884', {
			clientId: 'test-bad-mtls',
		});

		const private_key_path = env_get('tls_privateKey');
		const certificate_path = env_get('tls_certificate');
		const certificate_authority_path = env_get('tls_certificateAuthority');
		let client = connect('mqtts://localhost:8884', {
			key: readFileSync(private_key_path),
			// if they have a CA, we append it, so it is included
			cert:
				readFileSync(certificate_path) +
				(certificate_authority_path ? '\n\n' + readFileSync(certificate_authority_path) : ''),
			ca: certificate_authority_path && readFileSync(certificate_authority_path),
			clean: true,
			clientId: 'test-client-mtls',
		});
		await new Promise((resolve, reject) => {
			bad_client.on('connect', () => {
				reject('Client should not be able to connect to mTLS without a certificate');
			});
			client.on('connect', resolve);
			client.on('error', reject);
		});
		await new Promise((resolve, reject) => {
			client.subscribe(
				'SimpleRecord/23',
				{
					qos: 1,
				},
				function (err) {
					if (err) reject(err);
					else {
						client.unsubscribe('SimpleRecord/23', function (err) {
							if (err) reject(err);
							else resolve();
						});
					}
				}
			);
		});
		await new Promise((resolve, reject) => {
			client.on('message', (topic, payload, packet) => {
				let record = JSON.parse(payload);
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
				}).listen(8885, resolve);
				server.on('error', reject);
			});
			let bad_client = connect('wss://localhost:8885', {
				clientId: 'test-bad-mtls',
			});

			const private_key_path = env_get('tls_privateKey');
			const certificate_path = env_get('tls_certificate');
			const certificate_authority_path = env_get('tls_certificateAuthority');
			let client = connect('wss://localhost:8885', {
				key: readFileSync(private_key_path),
				// if they have a CA, we append it, so it is included
				cert:
					readFileSync(certificate_path) +
					(certificate_authority_path ? '\n\n' + readFileSync(certificate_authority_path) : ''),
				ca: certificate_authority_path && readFileSync(certificate_authority_path),
				clean: true,
				clientId: 'test-client-mtls',
			});
			await new Promise((resolve, reject) => {
				bad_client.on('connect', () => {
					reject('Client should not be able to connect to mTLS without a certificate');
				});
				client.on('connect', resolve);
				client.on('error', reject);
			});
			await new Promise((resolve, reject) => {
				client.subscribe(
					'SimpleRecord/23',
					{
						qos: 1,
					},
					function (err) {
						if (err) reject(err);
						else {
							client.unsubscribe('SimpleRecord/23', function (err) {
								if (err) reject(err);
								else resolve();
							});
						}
					}
				);
			});
			await new Promise((resolve, reject) => {
				client.on('message', (topic, payload, packet) => {
					let record = JSON.parse(payload);
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
		await new Promise((resolve, reject) => {
			client2.subscribe('DoesNotExist/+', function (err, granted) {
				console.log('subscribed', err);
				if (err) reject(err);
				else {
					resolve(assert.equal(granted[0].qos, 0x8f));
				}
			});
		});
	});
	it('Invalid packet', async function () {
		let client = connect('mqtt://localhost:1883', {
			clean: true,
			clientId: 'test-client1',
		});
		await new Promise((resolve, reject) => {
			client.on('connect', resolve);
			client.on('error', reject);
		});
		// directly send an invalid packet, which should cause the connection to close
		client.stream.write(Buffer.from([67,255]));

		await new Promise((resolve, reject) => {
			client.on('close', resolve);
		});
	});
	it('subscribe to single-level wildcard/full table', async function () {
		const topic_expectations = {
			'SimpleRecord/+': ['SimpleRecord/', 'SimpleRecord/44', 'SimpleRecord/47'],
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
			await new Promise((resolve, reject) => {
				client2.subscribe(subscription_topic, function (err) {
					if (err) reject(err);
					else {
						resolve();
					}
				});
			});
			let message_count = 0;
			let message_listener;
			await new Promise((resolve, reject) => {
				client2.on(
					'message',
					(message_listener = (topic, payload, packet) => {
						assert(expected_topics.includes(topic));
						let record = JSON.parse(payload);
						assert(record.name);
						if (++message_count == expected_topics.length) resolve();
					})
				);
				client2.publish(
					'SimpleRecord/44',
					JSON.stringify({
						name: 'This is a test 1',
					}),
					{
						retain: false,
						qos: 1,
					}
				);
				client2.publish(
					'SimpleRecord/sub/33',
					JSON.stringify({
						name: 'This is a test to a sub-topic',
					}),
					{
						retain: false,
						qos: 1,
					}
				);
				client2.publish(
					'SimpleRecord/sub/sub2/33',
					JSON.stringify({
						name: 'This is a test to a deeper sub-topic',
					}),
					{
						retain: false,
						qos: 1,
					}
				);

				client.publish(
					'SimpleRecord/47',
					JSON.stringify({
						name: 'This is a test 2',
					}),
					{
						retain: true,
						qos: 1,
					}
				);

				client.publish(
					'SimpleRecord/',
					JSON.stringify({
						name: 'This is a test to the generic table topic',
					}),
					{
						qos: 1,
					}
				);
			});
			client2.off('message', message_listener);
			await new Promise((resolve, reject) => {
				client2.unsubscribe(subscription_topic, function (err) {
					if (err) reject(err);
					else resolve();
				});
			});
		}
	});
	it('subscribe to multi-level wildcard/full table', async function () {
		await new Promise((resolve, reject) => {
			client2.subscribe('SimpleRecord/#', function (err) {
				if (err) reject(err);
				else resolve();
			});
		});
		let message_count = 0;
		let message_listener;
		await new Promise((resolve, reject) => {
			client2.on(
				'message',
				(message_listener = (topic, payload, packet) => {
					let record = JSON.parse(payload);
					assert(record.name);
					if (++message_count == 4) resolve();
				})
			);
			client2.publish(
				'SimpleRecord/44',
				JSON.stringify({
					name: 'This is a test 1',
				}),
				{
					retain: false,
					qos: 1,
				}
			);
			client2.publish(
				'SimpleRecord/sub/33',
				JSON.stringify({
					name: 'This is a test to a sub-topic', // should go to multi-level wildcard
				}),
				{
					retain: false,
					qos: 1,
				}
			);

			client.publish(
				'SimpleRecord/47',
				JSON.stringify({
					name: 'This is a test 2',
				}),
				{
					retain: true,
					qos: 1,
				}
			);

			client.publish(
				'SimpleRecord/',
				JSON.stringify({
					name: 'This is a test to the generic table topic',
				}),
				{
					qos: 1,
				}
			);
		});
		client2.off('message', message_listener);
		await new Promise((resolve, reject) => {
			client2.unsubscribe('SimpleRecord/#', function (err) {
				if (err) reject(err);
				else resolve();
			});
		});
	});
	it('subscribe to wildcards we do not support', async function () {
		await new Promise((resolve, reject) => {
			client2.subscribe('SimpleRecord/+test', function (err, granted) {
				if (err) resolve(err);
				else {
					resolve(assert.equal(granted[0].qos, 128)); // assert that the subscription was rejected
				}
			});
		});
		await new Promise((resolve, reject) => {
			client2.subscribe('+/SimpleRecord/test', function (err, granted) {
				if (err) reject(err);
				else {
					resolve(assert.equal(granted[0].qos, 0x8f)); // assert that the subscription was rejected
				}
			});
		});
	});
	it('subscribe with QoS=1 and reconnect with non-clean session', async function () {
		// this first connection is a tear down to remove any previous durable session with this id
		let client = connect('mqtt://localhost:1883', {
			clean: true,
			clientId: 'test-client1',
		});
		await new Promise((resolve, reject) => {
			client.on('connect', resolve);
			client.on('error', reject);
		});
		await client.end();
		await delay(10);
		client = connect('mqtt://localhost:1883', {
			clean: false,
			clientId: 'test-client1',
		});
		await new Promise((resolve, reject) => {
			client.on('connect', resolve);
			client.on('error', reject);
		});
		await new Promise((resolve, reject) => {
			client.subscribe(
				['SimpleRecord/41', 'SimpleRecord/42'],
				{
					qos: 1,
				},
				function (err) {
					console.log('subscribed', err);
					if (err) reject(err);
					else {
						resolve();
					}
				}
			);
		});
		await client.end();
		await delay(10);
		client = connect('mqtt://localhost:1883', {
			clean: false,
			clientId: 'test-client1',
		});
		await new Promise((resolve, reject) => {
			client.on('connect', resolve);
			client.on('error', reject);
		});
		await new Promise((resolve, reject) => {
			client.on('message', (topic, payload, packet) => {
				let record = JSON.parse(payload);
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
		client.end();
		await delay(50);
		client2.publish(
			'SimpleRecord/41',
			JSON.stringify({
				name: 'This is a test of publishing to a disconnected durable session',
			}),
			{
				qos: 1,
			}
		);
		client2.publish(
			'SimpleRecord/42',
			JSON.stringify({
				name: 'This is a test of publishing to a disconnected durable session 2',
			}),
			{
				qos: 1,
			}
		);
		await new Promise((resolve) =>
			client2.publish(
				'SimpleRecord/42',
				JSON.stringify({
					name: 'This is a test of publishing to a disconnected durable session 3',
				}),
				{
					qos: 1,
				},
				resolve
			)
		);
		await delay(10);
		client = connect('mqtt://localhost:1883', {
			clean: false,
			clientId: 'test-client1',
			protocolVersion: 5,
		});
		let messages = [];
		await new Promise((resolve, reject) => {
			client._handlePublish = async function (packet, done) {
				const message = packet.payload;
				messages.push(message.toString());
				done();
				if (message.toString().includes('session 2')) {
					// skip the first one to trigger out of order acking
					return;
				}
				client._sendPacket({ cmd: 'puback', messageId: packet.messageId, reasonCode: 0 }, () => {});
				if (message.toString().includes('session 3')) resolve();
			};
		});
		await delay(50);
		client.end();
		if (messages.length !== 3) console.error('Incorrect messages', { messages });
		assert(messages.length === 3);
		messages = [];
		client = connect('mqtt://localhost:1883', {
			clean: false,
			clientId: 'test-client1',
			protocolVersion: 5,
		});
		await new Promise((resolve, reject) => {
			client.on('message', (message) => {
				messages.push(message);
				resolve();
			});
		});
		assert.equal(messages.length, 1);
	});
	it('subscribe with QoS=2', async function () {
		// this first connection is a tear down to remove any previous durable session with this id
		let client = connect('mqtt://localhost:1883', {
			clean: true,
			clientId: 'test-client1',
		});
		await new Promise((resolve, reject) => {
			client.on('connect', resolve);
			client.on('error', reject);
		});
		await client.end();
		await delay(10);
		client = connect('mqtt://localhost:1883', {
			clean: false,
			clientId: 'test-client1',
		});
		await new Promise((resolve, reject) => {
			client.subscribe(
				'SimpleRecord/41',
				{
					qos: 2,
				},
				function (err) {
					if (err) reject(err);
					else {
						resolve();
					}
				}
			);
		});
		await new Promise((resolve, reject) => {
			client.on('message', (topic, payload, packet) => {
				let record = JSON.parse(payload);
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
		server.mqtt.events.on('connection', (a1, a2) => {
			events_received.push('connection');
		});
		server.mqtt.events.on('connected', (a1, a2) => {
			events_received.push('connected');
		});
		server.mqtt.events.on('disconnected', (a1, a2) => {
			events_received.push('disconnected');
		});
		server.mqtt.events.on('error', (a1, a2) => {
			events_received.push('error');
		});
		let client = connect('mqtt://localhost:1883', {
			clean: true,
			clientId: 'test-client1',
		});
		await new Promise((resolve, reject) => {
			client.on('connect', resolve);
			client.on('error', reject);
		});
		await new Promise((resolve) => client.subscribe('this does not exist', { qos: 1 }, resolve));
		client.end();
		await new Promise((resolve, reject) => {
			setTimeout(resolve, 20);
		});
		assert(events_received.includes('connection'));
		assert(events_received.includes('connected'));
		assert(events_received.includes('disconnected'));
		assert(events_received.includes('error'));
	});
	it('subscribe root with history', async function () {
		// this first connection is a tear down to remove any previous durable session with this id
		let client = connect('mqtt://localhost:1883', {
			clean: true,
			clientId: 'test-client1',
		});
		await new Promise((resolve, reject) => {
			client.on('connect', resolve);
			client.on('error', reject);
		});
		let messages = [];
		client.on('message', (topic, payload, packet) => {
			messages.push(topic, payload.length > 0 ? JSON.parse(payload) : 'deleted');
		});
		await new Promise((resolve, reject) => {
			client.subscribe(
				'FourPropWithHistory/#',
				{
					qos: 1,
				},
				function (err) {
					if (err) reject(err);
					else {
						setTimeout(resolve, 300);
					}
				}
			);
		});
		const { FourPropWithHistory } = await import('../testApp/resources.js');
		assert.equal(messages.length, 20);
		assert.equal(FourPropWithHistory.acknowledgements, 10);
		await FourPropWithHistory.put('something new', { name: 'something new' });
		await delay(50);
		assert.equal(messages.length, 22);
		assert.equal(FourPropWithHistory.acknowledgements, 11);
		client.end();
	});
	it('subscribe sub-topic with history', async function () {
		// this first connection is a tear down to remove any previous durable session with this id
		const { FourPropWithHistory } = await import('../testApp/resources.js');
		FourPropWithHistory.acknowledgements = 0;
		let client = connect('mqtt://localhost:1883', {
			clean: true,
			clientId: 'test-client1',
		});
		await new Promise((resolve, reject) => {
			client.on('connect', resolve);
			client.on('error', reject);
		});
		let messages = [];
		client.on('message', (topic, payload, packet) => {
			messages.push(topic, payload.length > 0 ? JSON.parse(payload) : 'deleted');
		});
		await new Promise((resolve, reject) => {
			client.subscribe(
				'FourPropWithHistory/12',
				{
					qos: 1,
				},
				function (err) {
					if (err) reject(err);
					else {
						setTimeout(resolve, 300);
					}
				}
			);
		});
		assert.equal(messages.length, 4);
		assert.equal(FourPropWithHistory.acknowledgements, 2);
	});
	after(() => {
		client?.end();
		client2?.end();
	});
});
function delay(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
