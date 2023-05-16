'use strict';

import { assert, expect } from 'chai';
import axios from 'axios';
import { decode, encode, DecoderStream } from 'cbor-x';
import { getVariables, callOperation } from './utility.js';
import { setupTestApp } from './setupTestApp.mjs';
import { connect } from 'mqtt';
const { authorization, url } = getVariables();


describe('test MQTT connections and commands', () => {
	let available_records;
	let client, client2;
	before(async () => {
		available_records = await setupTestApp();
		client = connect('ws://localhost:9926', {
			wsOptions: {
				headers: {
					Accept: 'application/cbor'
				}
			}
		});

		await new Promise((resolve, reject) => {
			client.on('connect', resolve);
			client.on('error', reject);
		});
		client2 = connect('mqtts://localhost:8883', {
			rejectUnauthorized: false,
		});

		await new Promise((resolve, reject) => {
			client2.on('connect', resolve);
			client2.on('error', reject);
		});
	});
	after(() => {
		client.end();
		client2.end();
	})
	it('subscribe to retained/persisted record', async function () {
		let path = 'VariedProps/' + available_records[1];
		await new Promise((resolve, reject) => {
			client.subscribe(path, function (err) {
				//console.log('subscribed', err);
				if (err) reject(err);
				else {
					//	client.publish('VariedProps/' + available_records[2], 'Hello mqtt')
				}
			});
			client.once('message', (topic, payload, packet) => {
				let record = decode(payload);
				console.log(topic, record);
				resolve();
			});
		});
	});
	it('can repeatedly publish', async () => {
		const vus = 1;
		const tableName = 'SimpleRecord';
		let intervals = [];
		let clients = [];
		for(let x = 1; x < vus +1; x++) {
			const topic = `${tableName}/${x}`;
			const client = connect({
				clientId: `vu${x}`,
				host: 'localhost',
				clean: true,
				connectTimeout: 2000,
				protocol: 'mqtt'
			});
			clients.push(client);
			let interval;
			client.on('connect', function (connack) {
				client.subscribe(topic, function (err) {
					console.error(err);
					if (!err) {
						intervals.push(setInterval(() => {
							client.publish(topic, JSON.stringify({name: 'radbot 9000', pub_time: Date.now()}), {
								qos: 1,
								retain: false
							});
						}, 1));
					}
				})
			})

			client.on('message', function (topic, message) {
				let now = Date.now();
				// message is Buffer
				let obj = JSON.parse(message.toString());
			});

			client.on('error', function (error) {
				// message is Buffer
				console.error(error);
			});
		}
		await new Promise(resolve => setTimeout(resolve, 100));
		for (let interval of intervals)
			clearInterval(interval);
		for (let client of clients) client.end();
	});
	it('subscribe to retained record with upsert operation', async function () {
		let path = 'SimpleRecord/77';
		let client
		await new Promise((resolve, reject) => {
			client = connect('mqtt://localhost:1883');
			client.on('connect', resolve);
			client.on('error', reject);
		});
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
				console.log(topic, record);
				resolve();
			});
			callOperation({
				"operation": "upsert",
				"schema": "data",
				"table": "simple_record",
				"records": [{
					id: '77',
					name: 'test record from operation'
				}]
			}).then(response => {
				response.json().then(data=> {
				console.log(data)});
			}, response => {
				reject(response.json());
			});
		});
		client.end();
	});
	it('subscribe twice', async function () {
		let client = connect('mqtt://localhost:1883', {
			clean: true,
			clientId: 'test-client-sub2'
		});
		await new Promise((resolve, reject) => {
			client.on('connect', resolve);
			client.on('error', reject);
		});
		await new Promise((resolve, reject) => {
			client.subscribe('SimpleRecord/22', {
				qos: 1
			}, function (err) {
				if (err) reject(err);
				else {
					client.subscribe('SimpleRecord/22', {
						qos: 1
					}, function (err) {
						if (err) reject(err);
						else resolve();
					});
				}
			});
		});
		await new Promise((resolve, reject) => {
			client.on('message', (topic, payload, packet) => {
				let record = JSON.parse(payload, packet);
				console.log('second', topic, record);
				resolve();
			});
			client.publish('SimpleRecord/22', JSON.stringify({
				name: 'This is a test again'
			}), {
				retain: false,
				qos: 1,
			});
		});
		client.end();
	});
	it('subscribe and unsubscribe', async function () {
		let client = connect('mqtt://localhost:1883', {
			clean: true,
			clientId: 'test-client-sub2'
		});
		await new Promise((resolve, reject) => {
			client.on('connect', resolve);
			client.on('error', reject);
		});
		await new Promise((resolve, reject) => {
			client.subscribe('SimpleRecord/23', {
				qos: 1
			}, function (err) {
				if (err) reject(err);
				else {
					client.unsubscribe('SimpleRecord/23', function (err) {
						if (err) reject(err);
						else resolve();
					});
				}
			});
		});
		await new Promise((resolve, reject) => {
			client.on('message', (topic, payload, packet) => {
				let record = JSON.parse(payload, packet);
				reject('Should not receive a message that we are unsubscribed to');
			});
			client.publish('SimpleRecord/23', JSON.stringify({
				name: 'This is a test again'
			}), {
				retain: false,
				qos: 1,
			});
			setTimeout(resolve, 50);
		});
		client.end();
	});
	it('subscribe to wildcard/full table', async function () {
		this.timeout(10000);
		await new Promise((resolve, reject) => {
			client2.subscribe('SimpleRecord/+', function (err) {
				console.log('subscribed', err);
				if (err) reject(err);
				else {
					resolve();
				}
			});
		});
		let message_count = 0;
		await new Promise((resolve, reject) => {
			client2.on('message', (topic, payload, packet) => {
				let record = JSON.parse(payload, packet);
				console.log('second', topic, record);
				if (++message_count == 2)
					resolve();
			});
			client2.publish('SimpleRecord/44', JSON.stringify({
				name: 'This is a test 1'
			}), {
				retain: false,
				qos: 1,
			});

			client.publish('SimpleRecord/47', JSON.stringify({
				name: 'This is a test 2'
			}), {
				retain: true,
				qos: 1,
			});
		});
	});
	it.skip('subscribe with QoS=1 and reconnect with non-clean session', async function () {
		this.timeout(10000);
		let client = connect('mqtt://localhost:1883', {
			clean: false,
			clientId: 'test-client1'
		});
		await new Promise((resolve, reject) => {
			client.on('connect', resolve);
			client.on('error', reject);
		});
		await new Promise((resolve, reject) => {
			client.subscribe('SimpleRecord/+', {
				qos: 1
			}, function (err) {
				console.log('subscribed', err);
				if (err) reject(err);
				else {
					resolve();
				}
			});
		});
		await new Promise((resolve, reject) => {
			client.subscribe('SimpleRecord/+', {
				qos: 1
			}, function (err) {
				console.log('subscribed', err);
				if (err) reject(err);
				else {
					resolve();
				}
			});
		});
	});
});