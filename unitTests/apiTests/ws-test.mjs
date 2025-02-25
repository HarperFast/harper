'use strict';

import { assert, expect } from 'chai';
import axios from 'axios';
import { pack, unpack } from 'msgpackr';
import { EventSource } from 'eventsource';
import { getVariables, callOperation } from './utility.js';
import { WebSocket } from 'ws';
import { setupTestApp } from './setupTestApp.mjs';
const { authorization, url } = getVariables();

describe('test WebSockets connections and messaging', () => {
	let available_records;
	let ws1, ws2;
	before(async function () {
		this.timeout(5000);
		available_records = await setupTestApp();
		ws1 = new WebSocket('ws://localhost:9926/Echo');

		await new Promise((resolve, reject) => {
			ws1.on('open', resolve);
			ws1.on('error', reject);
		});
	});
	after(function () {
		ws1.close();
		if (ws2) ws2.close();
	});
	it('ping echo server', async function () {
		let resolver;
		ws1.send(
			JSON.stringify({
				action: 'ping',
			})
		);
		let message = await new Promise((resolve) => {
			resolver = resolve;
			ws1.on('message', (message) => {
				resolver(JSON.parse(message));
			});
		});
		assert.equal(message.action, 'ping');
		ws1.send(
			JSON.stringify({
				action: 'another ping',
			})
		);
		message = await new Promise((resolve) => {
			resolver = resolve;
		});
		assert.equal(message.action, 'another ping');
	});
	it('ping echo server with content type', async function () {
		let resolver;
		let ws = new WebSocket('ws://localhost:9926/Echo.msgpack');
		await new Promise((resolve, reject) => {
			ws.on('open', resolve);
			ws.on('error', reject);
		});
		let encoded = pack({
			action: 'ping',
		});
		ws.send(encoded);
		let message = await new Promise((resolve) => {
			resolver = resolve;
			ws.on('message', (message) => {
				resolver(unpack(message));
			});
		});
		assert.equal(message.action, 'ping');
	});
	it('ping echo EventSource', async function () {
		let event_source = new EventSource('http://localhost:9926/Echo');
		let greetings_message;

		let message = await new Promise((resolve) => {
			event_source.addEventListener('open', () => {
				console.log('open');
			});
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
	it('default subscribe on WS', async function () {
		ws2 = new WebSocket('ws://localhost:9926/SimpleRecord/5');
		await new Promise((resolve, reject) => {
			ws2.on('open', resolve);
			ws2.on('error', reject);
		});
		let messages = [];
		await new Promise(async (resolve, reject) => {
			ws2.on('message', (message) => {
				messages.push(JSON.parse(message));
				if (messages.length === 2) {
					resolve();
				}
			});
			try {
				let response = await axios.put('http://localhost:9926/SimpleRecord/5', {
					id: '5',
					name: 'new name',
				});
				assert.equal(response.status, 204);
				response = await axios.patch('http://localhost:9926/SimpleRecord/5', {
					id: '5',
					newProperty: 'test',
				});
				assert.equal(response.status, 204);
			} catch (error) {
				console.error(error);
				reject(error);
			}
		});
		assert.equal(messages[0].value.name, 'new name');
		assert.equal(messages[0].type, 'put');
		assert.equal(messages[1].value.name, 'new name');
		assert.equal(messages[1].value.newProperty, 'test');
		assert.equal(messages[1].type, 'put');
	});
});
