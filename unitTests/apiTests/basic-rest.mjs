'use strict';

import { assert, expect } from 'chai';
import axios from 'axios';
import { decode, DecoderStream } from 'cbor-x';

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

		response = await axios({
			url: 'http://localhost:9926/OracleUser/33',
			method: 'GET',
			responseType: 'arraybuffer',
			headers,
			transformResponse: [decode],
		});
		console.log('decoded arraybuffer data with transformResponse:', response.data);

		response = await axios({
			url: 'http://localhost:9926/OracleUser/33',
			method: 'GET',
			responseType: 'stream',
			headers,
		});
		let decoderStream = new DecoderStream({ mapsAsObjects: true });
		response.data.pipe(decoderStream);
		decoderStream.on('data', (data) => console.log('decoded data from stream:', data));
		await new Promise(r => decoderStream.on('end', r));

	});
});
