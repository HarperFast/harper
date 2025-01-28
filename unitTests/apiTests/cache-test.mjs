'use strict';

import { assert } from 'chai';
import axios from 'axios';
import { setupTestApp } from './setupTestApp.mjs';

describe('test REST calls with cache table', () => {
	before(async () => {
		await setupTestApp();
	});

	it('do get with JSON', async () => {
		let response = await axios('http://localhost:9926/SimpleCache/3');
		assert.equal(response.status, 200);
		assert.equal(response.data.id, 3);
		assert.equal(response.data.name, 'name3');
	});
	it('invalidate and get', async () => {
		let response = await axios.post('http://localhost:9926/SimpleCache/3', {
			invalidate: true,
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
		data.name = 'name change';
		response = await axios.put('http://localhost:9926/FourProp/3', data);
		assert.equal(response.status, 204);
		response = await axios('http://localhost:9926/SimpleCache/3');
		assert.equal(response.status, 200);
		assert.equal(response.data.id, 3);
		assert.equal(response.data.name, 'name change');
	});
	it('put with immediate expiration on sourced table should expire immediately', async () => {
		let data = { name: 'not going to expire' };
		let response = await axios.put('http://localhost:9926/CacheOfResource/33', data);
		assert.equal(response.status, 204);
		let start_count = tables.CacheOfResource.sourceGetsPerformed;
		response = await axios('http://localhost:9926/CacheOfResource/33', {
			validateStatus: function (status) {
				return true;
			},
		});
		assert.equal(tables.CacheOfResource.sourceGetsPerformed, start_count);
		assert.equal(response.status, 200);
		data = { name: 'going to expire' };
		response = await axios.put('http://localhost:9926/CacheOfResource/33', data, {
			headers: {
				'Cache-Control': 'max-age=0',
			},
		});
		assert.equal(response.status, 204);
		start_count = tables.CacheOfResource.sourceGetsPerformed;
		response = await axios('http://localhost:9926/CacheOfResource/33', {
			validateStatus: function (status) {
				return true;
			},
		});
		assert(tables.CacheOfResource.sourceGetsPerformed > start_count);
		assert.equal(response.status, 200);
	});
});
