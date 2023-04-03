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
		let response = await axios({
			url: 'http://localhost:9926/VariedProps/' + available_records[1],
			method: 'GET',
			responseType: 'arraybuffer',
			headers,
		});
		assert.equal(response.status, 200);
		let data = JSON.parse(response.data);
		assert.equal(available_records[1], data.id);
	});
	it('do get with CBOR', async () => {
		const headers = {
			//authorization,
			accept: 'application/cbor'
		};
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
				'If-Match': response.headers.etag,
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
	describe('querying with query parameters', function() {
		it('do query by string property', async () => {
			let response = await axios('http://localhost:9926/FourProp/?name=name3');
			assert.equal(response.status, 200);
			assert.equal(response.data.length, 1);
			assert.equal(response.data[0].name, 'name3');
		});
		it('do query by numeric property', async () => {
			let response = await axios('http://localhost:9926/FourProp/?age=25');
			assert.equal(response.status, 200);
			assert.equal(response.data.length, 1);
			assert.equal(response.data[0].age, 25);
		});
		it('do query by two properties with no match', async () => {
			let response = await axios('http://localhost:9926/FourProp/?name=name2&age=28');
			assert.equal(response.status, 200);
			assert.equal(response.data.length, 0);
		});
		it('do query by two properties with one match', async () => {
			let response = await axios('http://localhost:9926/FourProp/?name=name2&age=22');
			assert.equal(response.status, 200);
			assert.equal(response.data.length, 1);
		});
		it('do query for missing property', async () => {
			let response = await axios('http://localhost:9926/FourProp/?notaprop=22', {
				validateStatus: function (status) {
					return true;
				},
			});
			assert.equal(response.status, 404);
		});
		it('do a less than query by numeric property', async () => {
			let response = await axios('http://localhost:9926/FourProp/?age=lt=25');
			assert.equal(response.status, 200);
			assert.equal(response.data.length, 5);
			assert.equal(response.data[4].age, 24);
		});
		it('do a less than query by numeric property with limit and offset', async () => {
			let response = await axios('http://localhost:9926/FourProp/?age=lt=25&offset=1&limit=2');
			assert.equal(response.status, 200);
			assert.equal(response.data.length, 2);
			assert.equal(response.data[1].age, 22);
		});

		it('query with select', async () => {
			let response = await axios('http://localhost:9926/FourProp?age=lt=22&select=age,id');
			assert.equal(response.status, 200);
			assert.equal(response.data.length, 2);
			assert.equal(response.data[1].age, 21);
			assert.equal(response.data[1].id, 1);
			assert.equal(response.data[0].name, undefined);
			assert.equal(response.data[1].name, undefined);
		});

	});
});
