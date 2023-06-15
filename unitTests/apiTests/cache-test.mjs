'use strict';

import { assert, expect } from 'chai';
import axios from 'axios';
import { decode, encode, DecoderStream } from 'cbor-x';
import { getVariables } from './utility.js';
import { setupTestApp } from './setupTestApp.mjs';
import why_is_node_running from 'why-is-node-still-running';
const { authorization, url } = getVariables();

describe('test REST calls with cache table', () => {
	let available_records;
	before(async () => {
		available_records = await setupTestApp();
	});

	it('do get with JSON', async () => {
		let response = await axios('http://localhost:9926/SimpleCache/3');
		assert.equal(response.status, 200);
		assert.equal(response.data.id, 3);
		assert.equal(response.data.name, 'name3');
	});
	it('invalidate and get', async () => {
		let response = await axios.post('http://localhost:9926/SimpleCache/3', {
			invalidate: true
		});
		assert.equal(response.status, 204);
		response = await axios('http://localhost:9926/SimpleCache/3');
		assert.equal(response.status, 200);
		assert.equal(response.data.id, 3);
		assert.equal(response.data.name, 'name3');
	});
	it('change source and get', async () => {
		let response = await axios('http://localhost:9926/FourProp/3');
		let data = response.data;
		data.name = 'name change'
		response = await axios.put('http://localhost:9926/FourProp/3', data);
		assert.equal(response.status, 204);
		response = await axios('http://localhost:9926/SimpleCache/3');
		assert.equal(response.status, 200);
		assert.equal(response.data.id, 3);
		assert.equal(response.data.name, 'name change');
	});
});
