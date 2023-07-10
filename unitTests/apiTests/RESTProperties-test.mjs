'use strict';

import { assert, expect } from 'chai';
import axios from 'axios';
import { decode, encode, DecoderStream } from 'cbor-x';
import { getVariables } from './utility.js';
import { setupTestApp } from './setupTestApp.mjs';
import why_is_node_running from 'why-is-node-still-running';
const { authorization, url } = getVariables();

describe('test REST with property updates', () => {
	let available_records;
	before(async () => {
		available_records = await setupTestApp();
	});

	it('post with sub-property manipulation', async () => {
		let response = await axios.put('http://localhost:9926/namespace/SubObject/5', {
			id: 5,
			subObject: { name: 'a sub-object' },
			subArray: [{ name: 'a sub-object of an array' }],
		});
		assert.equal(response.status, 204);
		response = await axios.post('http://localhost:9926/namespace/SubObject/5', {
			subPropertyValue: 'a new value',
			subArrayItem: 'a new item',
		});
		assert.equal(response.status, 200);
		response = await axios.get('http://localhost:9926/namespace/SubObject/5');
		assert.equal(response.status, 200);
		assert.equal(response.data.subObject.subProperty, 'a new value');
		assert.equal(response.data.subArray[1], 'a new item');
	});
	it('get with sub-property access via dot', async () => {
		let response = await axios.put('http://localhost:9926/namespace/SubObject/6', {
			id: 5,
			subObject: { name: 'a sub-object' },
			subArray: [{ name: 'a sub-object of an array' }],
		});
		assert.equal(response.status, 204);
		response = await axios.get('http://localhost:9926/namespace/SubObject/6.subObject');
		assert.equal(response.status, 200);
		assert.equal(response.data.name, 'a sub-object');
	});
	it('get with sub-property access via ?select', async () => {
		let response = await axios.put('http://localhost:9926/namespace/SubObject/6', {
			id: 5,
			subObject: { name: 'a sub-object' },
			subArray: [{ name: 'a sub-object of an array' }],
		});
		assert.equal(response.status, 204);
		response = await axios.get('http://localhost:9926/namespace/SubObject/6?select=subObject');
		assert.equal(response.status, 200);
		assert.equal(response.data.name, 'a sub-object');
	});
	it('put with wrong type on attribute', async () => {
		const headers = {
			//authorization,
			'content-type': '',
			'accept': 'application/json',
		};
		let response = await axios.put(
			'http://localhost:9926/FourProp/555',
			JSON.stringify({
				id: 555,
				name: 33,
				age: 'not a number',
			}),
			{
				headers,
				validateStatus: function (status) {
					return true;
				},
			}
		);
		assert.equal(response.status, 400);
		assert(response.data.includes('Property name must be a string'));
		assert(response.data.includes('Property age must be an integer'));
	});

	it('put with nested path', async () => {
		let response = await axios.put('http://localhost:9926/namespace/SubObject/multi/part/id/3', {
			subObject: { name: 'deeply nested' },
			subArray: [],
		});
		assert.equal(response.status, 204);
		response = await axios.get('http://localhost:9926/namespace/SubObject/multi/part/id/3');
		assert.equal(response.status, 200);
		assert.equal(response.data.subObject.name, 'deeply nested');
		assert.deepEqual(response.data.id, ['multi','part', 'id', 3]);
	});

	describe('check operations', function () {
		it('search_by_value returns all attributes', async function () {
			let response = await axios.post('http://localhost:9925', {
				operation: 'search_by_value',
				schema: 'data',
				table: 'FourProp',
				search_attribute: 'id',
				search_value: '*',
			});
			assert.equal(response.data[0].title, 'title0');
		});
		it('sql returns all attributes of four property object', async function () {
			let response = await axios.post('http://localhost:9925', {
				operation: 'sql',
				sql: 'SELECT * FROM data.FourProp',
			});
			assert.equal(response.data[0].title, 'title0');
		});
		it('sql returns all attributes and sub-object of array', async function () {
			let response = await axios.put('http://localhost:9926/namespace/SubObject/6', {
				id: 6,
				subObject: { name: 'another sub-object' },
				subArray: [{ name: 'another sub-object of an array' }],
			});
			response = await axios.post('http://localhost:9925', {
				operation: 'sql',
				sql: 'SELECT * FROM data.SubObject',
			});
			assert.equal(response.data[1].subObject.name, 'another sub-object');
		});
	});
});
