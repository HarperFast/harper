'use strict';

import { assert, expect } from 'chai';
import axios from 'axios';
import { decode, encode, DecoderStream } from 'cbor-x';
import { getVariables } from './utility.js';
import { WebSocket } from 'ws';
const { authorization, url } = getVariables();

describe('test WebSocket connections', () => {
	beforeEach(async () => {
		//await removeAllSchemas();
	});

	it('do post/update with CBOR', async () => {
		const headers = {
			authorization,
			'content-type': 'application/cbor',
			'accept': 'application/cbor',
		};
		let ws = new WebSocket('ws://localhost:9926/DenormalizedUser', {
			headers,
		});
		await new Promise((resolve, reject) => {
			ws.on('open', resolve);
			ws.on('error', reject);
		});
		ws.on('message', (data) => console.log('got ws message', decode(data)));
		ws.send(
			encode({
				method: 'get-sub',
				path: '33',
			})
		);
		console.log('sending');
		let response = await axios.post(
			'http://localhost:9926/DenormalizedUser/33',
			encode({
				method: 'addTitle',
				titleId: 35,
			}),
			{
				method: 'POST',
				headers,
				responseType: 'arraybuffer',
			}
		);
		console.log('decoded arraybuffer data:', response.data.length);
	});
	it('do put with CBOR', async function () {
		this.timeout(100000000);
		const headers = {
			authorization,
			'content-type': 'application/cbor',
			'accept': 'application/cbor',
		};
		console.log('sending');
		let response;
		let promises = [];
		for (let i = 0; i < 2000; i++) {
			let id = Math.ceil(Math.random() * 1000);
			promises.push(
				axios.put(
					'http://localhost:9926/our_data/' + id,
					encode({
						nane: 'a new record',
						id,
					}),
					{
						headers,
						responseType: 'arraybuffer',
					}
				)
			);
			if (promises.length > 10) {
				response = await Promise.all(promises);
				promises = [];
			}
		}
		console.log('decoded arraybuffer data:', response[0].data.length);
	});
	it('how many websockets', async function () {
		this.timeout(100000000);
		const headers = {
			authorization,
			'content-type': 'application/cbor',
			'accept': 'application/cbor',
		};

		let message_count = 0;
		let printing_connection_count;
		let i = 0;
		for (; i < 20; ) {
			//			let ws = new WebSocket('ws+unix:/tmp/test:/our_data', {
			let ws = new WebSocket('ws://localhost:9926/our_data', {
				headers,
			});
			await new Promise((resolve, reject) => {
				ws.on('open', resolve);
				ws.on('error', reject);
			});
			let path = '' + Math.ceil(Math.random() * 1000);
			ws.send(
				encode({
					method: 'get-sub',
					path,
				})
			);
			let first = true;
			ws.on('message', (data) => {
				if (message_count === 0) {
					setTimeout(() => {
						console.log('messages received in last second:', message_count, 'last message:', decode(data));
						message_count = 0;
					}, 1000);
				}
				message_count++;
			});
			i++;
			if (!printing_connection_count) {
				setTimeout(() => {
					console.log('connection count', i);
					printing_connection_count = false;
				}, 1000);
				printing_connection_count = true;
			}
		}
		await new Promise((resolve) => setTimeout(resolve, 1000000));
	});
});
