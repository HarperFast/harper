'use strict';

import { assert, expect } from 'chai';
import axios from 'axios';
import { decode, encode, DecoderStream } from 'cbor-x';
import { getVariables } from './utility.js';
import { setupTestApp } from './setupTestApp.mjs';
import { connect } from 'mqtt';
const { authorization, url } = getVariables();


describe('test MQTT connections and commands', () => {
	let available_records;
	let client;
	before(async () => {
		available_records = await setupTestApp();
		client = connect('ws://localhost:9926')

		await new Promise((resolve, reject) => {
			client.on('connect', resolve);
			client.on('error', reject);
		});
	});
	it('subscribe to retained record', async function () {
		this.timeout(10000);
		for (let j = 0; j < 100; j++) {
			let client = connect('ws://localhost:9926');
			for (let i = 0; i < 20; i++) {
				let path = 'VariedProps/' + available_records[i];
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
						//console.log(topic, record);
						resolve();
					});
				});
			}
			console.log('finished',j)
		}
	});
});