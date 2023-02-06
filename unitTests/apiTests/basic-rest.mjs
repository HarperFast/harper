'use strict';

import { assert, expect } from 'chai';
import axios from 'axios';
import { decode, encode, DecoderStream } from 'cbor-x';
import { WebSocket } from 'ws';

const authorization = 'Basic YWRtaW46QWJjMTIzNCE=';//'Basic ' + btoa('admin:Abc1234!');
const TEST_URL = 'http://localhost:9925';

describe('test REST calls', () => {
	beforeEach(async () => {
		//await removeAllSchemas();
	});

	it('do get with CBOR', async () => {
		const headers = {
			authorization,
			accept: 'application/cbor'
		};
		console.log('sending');
		let response = await axios({
			url: 'http://localhost:9926/OracleUser/33',
			method: 'GET',
			responseType: 'arraybuffer',
			headers,
		});
		console.log('decoded arraybuffer data:', decode(response.data));

	});
	it('do post/update with CBOR', async () => {
		const headers = {
			authorization,
			'content-type': 'application/cbor',
			accept: 'application/cbor'
		};
		let ws = new WebSocket('ws://localhost:9926/DenormalizedUser', {
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
		});
		console.log('decoded arraybuffer data:', decode(response.data));

	});

});
