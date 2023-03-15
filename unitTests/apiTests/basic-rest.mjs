'use strict';

import { assert, expect } from 'chai';
import axios from 'axios';
import { decode, encode, DecoderStream } from 'cbor-x';
import { getVariables } from './utility.js';
import { setupTestApp } from './setupTestApp.mjs';
const { authorization, url } = getVariables();

describe('test REST calls', () => {
	let available_records;
	before(async () => {
		available_records = await setupTestApp();
	});
	beforeEach(async () => {
		//await removeAllSchemas();
	});

	it('do get with CBOR', async () => {
		const headers = {
			//authorization,
			accept: 'application/cbor'
		};
		console.log('sending');
		let response = await axios({
			url: 'http://localhost:9926/VariedProps/' + available_records[1],
			method: 'GET',
			responseType: 'arraybuffer',
			headers,
		});
		assert.equal(response.status, 200);
		let data = decode(response.data);
		assert.equal(available_records[1], data.id);
		response = await axios({
			url: 'http://localhost:9926/VariedProps/' + available_records[1],
			method: 'GET',
			responseType: 'arraybuffer',
			headers: {
				'If-Modified-Since': response.headers['last-modified'],
				...headers
			},
			validateStatus: function (status) {
				return status >= 200 && status < 400;
			},
		});
		assert.equal(response.status, 304);
	});
	it('do post/update with CBOR', async () => {
		const headers = {
			//authorization,
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
