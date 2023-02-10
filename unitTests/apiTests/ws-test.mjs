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
			accept: 'application/cbor'
		};
		let ws = new WebSocket('ws://localhost:9926/user', {
			headers,
		});
		await new Promise((resolve, reject) => {
			ws.on('open', resolve);
			ws.on('error', reject);
		});
		ws.on('message', data => console.log('got ws message', decode(data)));
		ws.send(encode({
			method: 'get-sub',
			path: '33',
		}));
		console.log('sending');
		let response = await axios.post('http://localhost:9926/DenormalizedUser/33', encode({
			method: 'addTitle',
			titleId: 35,
		}), {
			method: 'POST',
			headers,
			responseType: 'arraybuffer',
		});
		console.log('decoded arraybuffer data:', response.data.length);

	});
	it('how many websockets', async function() {
		this.timeout(100000000);
		const headers = {
			authorization,
			'content-type': 'application/cbor',
			accept: 'application/cbor'
		};

		for (let i = 0; i < 1000; i++) {
			let ws = new WebSocket('ws+unix:/tmp/test:/user', {
				headers,
			});
			await new Promise((resolve, reject) => {
				ws.on('open', resolve);
				ws.on('error', reject);
			});
			let path = '' + Math.ceil(Math.random() * 40);
			ws.send(encode({
				method: 'get-sub',
				path,
			}));
			ws.on('message', data => console.log('got ws message', decode(data)));
			if (i % 1000 == 0)
				console.log({i})
		}
		await new Promise(resolve => setTimeout(resolve, 1000000));
	});
});
