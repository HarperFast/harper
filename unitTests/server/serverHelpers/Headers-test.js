'use strict';
const assert = require('assert');

const { Headers, appendHeader, mergeHeaders } = require('../../../ts-build/server/serverHelpers/Headers');
describe('Test Headers', () => {
	describe(`Create and modify headers`, function () {
		it('should handle headers', async function () {
			const headers = new Headers();
			assert.equal(Array.from(headers).length, 0);
			assert.equal(headers.get('NaMe'), undefined);
			assert.equal(headers.has('NaMe'), false);
			headers.set('nAmE', 'value');
			assert.equal(headers.get('NaMe'), 'value');
			assert.equal(headers.has('NaMe'), true);
			headers.setIfNone('name', 'value changed');
			assert.equal(headers.get('NaMe'), 'value');
			assert.equal(headers.has('NAME'), true);
			headers.append('naMe', 'value2');
			assert.deepEqual(headers.get('NaMe'), ['value', 'value2']);
			assert.equal(Array.from(headers).length, 1);
		});
		it('should handle append with commas', async function () {
			const headers = new Headers();
			headers.append('name-with-commas', 'value', true);
			headers.append('name-with-commas', 'value2', true);
			appendHeader(headers, 'name-with-commas', 'value3', true);
			assert.equal(headers.get('name-with-commas'), 'value, value2, value3');
		});
		it('should handle append with commas on a Map', async function () {
			const headers = new Map();
			appendHeader(headers, 'name-with-commas', 'value', true);
			appendHeader(headers, 'name-with-commas', 'value2', true);
			appendHeader(headers, 'name-with-commas', 'value3', true);
			assert.equal(headers.get('name-with-commas'), 'value, value2, value3');
		});
		it('construct headers from object', async function () {
			const headers = new Headers({ name: 'value', name2: 'value2' });
			assert.equal(headers.get('name'), 'value');
			assert.equal(headers.get('name2'), 'value2');
		});
		it('construct headers from Map and merge', async function () {
			let map = new Map();
			map.set('name', 'value');
			map.set('name2', 'value2');
			let headers = new Headers(map);
			assert.equal(headers.get('name'), 'value');
			assert.equal(headers.get('name2'), 'value2');
			headers = mergeHeaders(headers, new Headers({ name2: 'value3', name3: 'value4' }));
			assert.equal(headers.get('name'), 'value');
			assert.equal(headers.get('name2'), 'value2');
			assert.equal(headers.get('name3'), 'value4');
		});
	});
});
