'use strict';

import { assert, expect } from 'chai';
import axios from 'axios';
import { decode, encode, DecoderStream } from 'cbor-x';
import { getVariables } from './utility.js';
const { authorization, url } = getVariables();

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
			url: 'http://localhost:9926/user/39',
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
		let response = await axios.post('http://localhost:9926/DenormalizedUser/33', encode({
			method: 'addTitle',
			titleId: 35,
		}), {
			method: 'POST',
			responseType: 'arraybuffer',
			headers,
		});
		console.log('decoded arraybuffer data:', decode(response.data));

	});
});
