'use strict';

import { assert, expect } from 'chai';
import axios from 'axios';
import { decode, encode, DecoderStream } from 'cbor-x';
import { getVariables } from './utility.js';
import { setupTestApp } from './setupTestApp.mjs';
import why_is_node_running from 'why-is-node-still-running';
const { authorization, url } = getVariables();

describe('test REST calls', () => {
	let available_records;
	before(async () => {
		available_records = await setupTestApp();
	});
	beforeEach(async () => {
		//await removeAllSchemas();
	});

	it('do get with JSON', async () => {
		const headers = {
			//authorization,
		};
		console.log('sending');
		let response = await axios({
			url: 'http://localhost:9926/VariedProps/' + available_records[1],
			method: 'GET',
			responseType: 'arraybuffer',
			headers,
		});
		assert.equal(response.status, 200);
		// TODO: Ensure there is no __updatedtime__ or __createdtime__ or __updates___
		let data = JSON.parse(response.data);
		assert.equal(available_records[1], data.id);
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
		// TODO: Ensure there is no __updatedtime__ or __createdtime__ or __updates___
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
	it('PUT with CBOR', async () => {
		setTimeout(() => {
			//why_is_node_running.whyIsNodeStillRunning();
		}, 4000).unref();
		const headers = {
			//authorization,
			'content-type': 'application/cbor',
			accept: 'application/cbor'
		};
		let response = await axios.put('http://localhost:9926/VariedProps/33', encode({
			id: 33,
			name: 'new record',
		}), {
			responseType: 'arraybuffer',
			headers,
		});
		console.log('decoded arraybuffer data:', decode(response.data));

	});
});
