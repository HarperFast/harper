'use strict';

import { assert, expect } from 'chai';
import axios from 'axios';
import { decode, encode, DecoderStream } from 'cbor-x';
import EventSource from 'eventsource';
import { getVariables, callOperation } from './utility.js';
import { WebSocket } from 'ws';
import { setupTestApp } from './setupTestApp.mjs';
const { authorization, url } = getVariables();


describe('test WebSockets connections and messaging', () => {
	let available_records;
	let ws1;
	before(async function() {
		available_records = await setupTestApp();
		ws1 = new WebSocket('ws://localhost:9926/Echo');

		await new Promise((resolve, reject) => {
			ws1.on('open', resolve);
			ws1.on('error', reject);
		});
	});
	it('ping echo server', async function () {
		let resolver;
		ws1.send(JSON.stringify({
			action: 'ping',
		}));
		let message = await new Promise(resolve => {
			resolver = resolve;
			ws1.on('message', message => {
				resolver(JSON.parse(message));
			});
		});
		assert.equal(message.action, 'ping');
		ws1.send(JSON.stringify({
			action: 'another ping',
		}));
		message = await new Promise(resolve => {
			resolver = resolve;
		})
		assert.equal(message.action, 'another ping');
	});
	it('ping echo EventSource', async function () {
		let event_source = new EventSource('http://localhost:9926/Echo');
		let greetings_message;

		let message = await new Promise(resolve => {
			event_source.addEventListener('open', () => {
				console.log('open');
			})
			event_source.addEventListener('message', (event) => {
				greetings_message = event.data;
			});
			event_source.addEventListener('another-message', (event) => {
				resolve(event);
			});
		});
		event_source.close();
		assert.equal(greetings_message, 'greetings');
		assert.equal(message.data, 'hello again');
	});
	it('default subscribe on WS', async function() {
		let ws2 = new WebSocket('ws://localhost:9926/SimpleRecord/5');
		await new Promise((resolve, reject) => {
			ws2.on('open', resolve);
			ws2.on('error', reject);
		});
		let message = await new Promise(async resolve => {
			ws2.on('message', message => {
				resolve(JSON.parse(message));
			});
			let response = await axios.put('http://localhost:9926/SimpleRecord/5', {
				id: 5,
				name: 'new name',
			});
			assert.equal(response.status, 204);
		});
		assert.equal(message.value.name, 'new name');
	});
});