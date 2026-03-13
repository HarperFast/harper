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
		delete data.nameTitle; // don't send a computed property
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
			validateStatus: function (_status) {
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
			validateStatus: function (_status) {
				return true;
			},
		});
		assert(tables.CacheOfResource.sourceGetsPerformed > start_count);
		assert.equal(response.status, 200);
	});
	describe('Cache sourced from HTTP responses', () => {
		it('get resolved with fetch', async () => {
			let source = await axios.get('http://localhost:9926/FourProp/2');
			let response = await axios.get('http://localhost:9926/CacheOfHttp/direct-fetch');
			assert.equal(response.status, 200);
			assert.equal(response.data.id, '2');
			assert.equal(response.data.name, 'name2');
			assert(response.headers.get('ETag'));
			assert.equal(response.headers.get('ETag'), source.headers.get('ETag'));
		});
		it('get resolved with Response', async () => {
			let response = await axios.get('http://localhost:9926/CacheOfHttp/created-response');
			assert.equal(response.status, 200);
			assert.equal(response.data, 'test');
			assert.equal(response.headers.get('cache-control'), 'max-age=10, s-maxage=20');
			assert.equal(response.headers.get('x-custom-header'), 'custom value');
		});
		it('get resolved with fetch body as text', async () => {
			let response = await axios.get('http://localhost:9926/CacheOfHttp/fetch-body');
			assert.equal(response.status, 200);
			assert.equal(typeof response.data, 'string');
			assert.equal(JSON.parse(response.data).name, 'name2');
		});
		it('get resolved as html', async () => {
			let response = await axios.get('http://localhost:9926/CacheOfHttp/html-response');
			assert.equal(response.status, 200);
			assert.equal(typeof response.data, 'string');
			assert(response.data.startsWith('<html>'));
			assert.equal(response.headers.get('content-type'), 'text/html');
		});
		it('get resolved as object with headers', async () => {
			let response = await axios.get('http://localhost:9926/CacheOfHttp/headers-in-data');
			assert.equal(response.status, 200);
			assert.equal(response.data.name, 'test-sibling-to-headers');
			assert.equal(response.headers.get('x-custom-header'), 'custom value');
		});
	});
});
