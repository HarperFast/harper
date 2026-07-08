'use strict';

import { assert } from 'chai';
import axios from 'axios';
import { setupTestApp, baseUrl } from './setupTestApp.mjs';
import { setTimeout as delay } from 'node:timers/promises';
import { waitFor } from '../waitFor.js';

describe('test REST calls with cache table', () => {
	before(async () => {
		await setupTestApp();
	});

	it('do get with JSON', async () => {
		let response = await axios(`${baseUrl}/SimpleCache/3`);
		assert.equal(response.status, 200);
		assert.equal(response.data.id, 3);
		assert.equal(response.data.name, 'name3');
	});
	it('invalidate and get', async () => {
		let response = await axios.post(`${baseUrl}/SimpleCache/3`, {
			invalidate: true,
		});
		assert.equal(response.status, 204);
		response = await axios(`${baseUrl}/SimpleCache/3`);
		assert.equal(response.status, 200);
		assert.equal(response.data.id, 3);
		assert.equal(response.data.name, 'name3');
	});
	it('change source and get', async () => {
		let response = await axios(`${baseUrl}/FourProp/3`);
		let data = response.data;
		data.name = 'name change';
		delete data.nameTitle; // don't send a computed property
		response = await axios.put(`${baseUrl}/FourProp/3`, data);
		assert.equal(response.status, 204);
		await delay(20);
		response = await axios(`${baseUrl}/SimpleCache/3`);
		assert.equal(response.status, 200);
		assert.equal(response.data.id, 3);
		assert.equal(response.data.name, 'name change');
	});
	it('put with immediate expiration on sourced table should expire immediately', async () => {
		let data = { name: 'not going to expire' };
		let response = await axios.put(`${baseUrl}/CacheOfResource/33`, data);
		assert.equal(response.status, 204);
		let start_count = tables.CacheOfResource.sourceGetsPerformed;
		response = await axios(`${baseUrl}/CacheOfResource/33`, {
			validateStatus: function (_status) {
				return true;
			},
		});
		assert.equal(tables.CacheOfResource.sourceGetsPerformed, start_count);
		assert.equal(response.status, 200);
		data = { name: 'going to expire' };
		response = await axios.put(`${baseUrl}/CacheOfResource/33`, data, {
			headers: {
				'Cache-Control': 'max-age=0',
			},
		});
		assert.equal(response.status, 204);
		start_count = tables.CacheOfResource.sourceGetsPerformed;
		response = await axios(`${baseUrl}/CacheOfResource/33`, {
			validateStatus: function (_status) {
				return true;
			},
		});
		assert(tables.CacheOfResource.sourceGetsPerformed > start_count);
		assert.equal(response.status, 200);
	});
	describe('Cache sourced from HTTP responses', () => {
		it('get resolved with fetch', async () => {
			let source = await axios.get(`${baseUrl}/FourProp/2`);
			let response = await axios.get(`${baseUrl}/CacheOfHttp/direct-fetch`);
			assert.equal(response.status, 200);
			assert.equal(response.data.id, '2');
			assert.equal(response.data.name, 'name2');
			assert(response.headers.get('ETag'));
			assert.equal(response.headers.get('ETag'), source.headers.get('ETag'));
		});
		it('get resolved with Response', async () => {
			let response = await axios.get(`${baseUrl}/CacheOfHttp/created-response`);
			assert.equal(response.status, 200);
			assert.equal(response.data, 'test');
			assert.equal(response.headers.get('cache-control'), 'max-age=10, s-maxage=20');
			assert.equal(response.headers.get('x-custom-header'), 'custom value');
		});
		it('stored record headers survive the response path (#1702)', async () => {
			// finalizeResponse must not mutate the live record queued for the deferred cache commit
			// (it previously overwrote `headers` with a web Headers, persisting `{}` under LMDB).
			// The first get warms the cache and queues the async commit; subsequent gets are cache
			// hits served from the persisted record, so they fail if the stored headers were
			// corrupted by the first request's response handling. Poll rather than fixed-delay so the
			// deferred-commit wait doesn't race a loaded runner (AGENTS.md #1138).
			await axios.get(`${baseUrl}/CacheOfHttp/created-response`);
			const response = await waitFor(
				async () => {
					const r = await axios.get(`${baseUrl}/CacheOfHttp/created-response`);
					return r.headers.get('cache-control') === 'max-age=10, s-maxage=20' ? r : false;
				},
				{ timeout: 2000, interval: 20, message: 'stored cache headers did not survive the response path (#1702)' }
			);
			assert.equal(response.status, 200);
			assert.equal(response.data, 'test');
			assert.equal(response.headers.get('x-custom-header'), 'custom value');
		});
		it('get resolved with fetch body as text', async () => {
			let response = await axios.get(`${baseUrl}/CacheOfHttp/fetch-body`);
			assert.equal(response.status, 200);
			assert.equal(typeof response.data, 'string');
			assert.equal(JSON.parse(response.data).name, 'name2');
		});
		it('get resolved as html', async () => {
			let response = await axios.get(`${baseUrl}/CacheOfHttp/html-response`);
			assert.equal(response.status, 200);
			assert.equal(typeof response.data, 'string');
			assert(response.data.startsWith('<html>'));
			assert.equal(response.headers.get('content-type'), 'text/html');
		});
		it('get resolved as object with headers', async () => {
			let response = await axios.get(`${baseUrl}/CacheOfHttp/headers-in-data`);
			assert.equal(response.status, 200);
			assert.equal(response.data.name, 'test-sibling-to-headers');
			assert.equal(response.headers.get('x-custom-header'), 'custom value');
		});
	});
});
