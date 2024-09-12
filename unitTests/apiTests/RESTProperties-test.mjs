'use strict';

import { assert, expect } from 'chai';
import axios from 'axios';
import { decode, encode, DecoderStream } from 'cbor-x';
import { getVariables } from './utility.js';
import { setupTestApp } from './setupTestApp.mjs';
import { request } from 'http';
import why_is_node_running from 'why-is-node-still-running';
const { authorization, url } = getVariables();

describe('test REST with property updates', () => {
	let available_records;
	before(async function () {
		available_records = await setupTestApp();
	});

	it('post with sub-property manipulation', async () => {
		let response = await axios.put('http://localhost:9926/namespace/SubObject/5', {
			id: '5',
			subObject: { name: 'a sub-object' },
			subArray: [{ name: 'a sub-object of an array' }],
		});
		assert.equal(response.status, 204);
		response = await axios.post('http://localhost:9926/namespace/SubObject/5', {
			subPropertyValue: 'a new value',
			subArrayItem: { name: 'a new item' },
		});
		assert.equal(response.status, 200);
		response = await axios.get('http://localhost:9926/namespace/SubObject/5');
		assert.equal(response.status, 200);
		assert.equal(response.data.subObject.subProperty, 'a new value');
		assert.equal(response.data.subArray[1].name, 'a new item');
	});
	it('get with sub-property access via dot', async () => {
		let response = await axios.put('http://localhost:9926/namespace/SubObject/6', {
			id: '5',
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
			id: '5',
			any: { name: 'can be an object' },
			subObject: { name: 'a sub-object' },
			subArray: [{ name: 'a sub-object of an array' }],
		});
		assert.equal(response.status, 204);
		response = await axios.get('http://localhost:9926/namespace/SubObject/6?select(subObject)');
		assert.equal(response.status, 200);
		assert.equal(response.data.name, 'a sub-object');
		response = await axios.get('http://localhost:9926/namespace/SubObject/6?select(any,)');
		assert.equal(response.data.any.name, 'can be an object');
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
				id: '555',
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
		assert(response.data.includes('property name must be a string'));
		assert(response.data.includes('property age must be an integer'));
	});

	it('put with nested path', async () => {
		let response = await axios.put('http://localhost:9926/namespace/SubObject/multi/part/id/3', {
			any: 'can be a string',
			subObject: { name: 'deeply nested' },
			subArray: [],
		});
		assert.equal(response.status, 204);
		response = await axios.get('http://localhost:9926/namespace/SubObject/multi/part/id/3');
		assert.equal(response.status, 200);
		assert.equal(response.data.subObject.name, 'deeply nested');
		assert.deepEqual(response.data.id, ['multi', 'part', 'id', '3']);
		assert.deepEqual(response.data.any, 'can be a string');
		response = await axios.get('http://localhost:9926/namespace/SubObject/multi/');
		assert.equal(response.status, 200);
		assert.equal(response.data[0].subObject.name, 'deeply nested');
		assert.equal(response.data.length, 1);
		response = await axios.get('http://localhost:9926/namespace/SubObject/multi/part/');
		assert.equal(response.status, 200);
		assert.equal(response.data[0].subObject.name, 'deeply nested');
		assert.equal(response.data.length, 1);
		response = await axios.get('http://localhost:9926/namespace/SubObject/multi/?any=not-here');
		assert.equal(response.status, 200);
		assert.equal(response.data.length, 0);

		response = await axios.delete('http://localhost:9926/namespace/SubObject/multi/part/');
		response = await axios.get('http://localhost:9926/namespace/SubObject/multi/part/');
		assert.equal(response.status, 200);
		assert.equal(response.data.length, 0);
	});

	it('put with encoded slashes, dots', async () => {
		let response = await axios.put('http://localhost:9926/namespace/SubObject/i%2Flike%2Fslashes%2E', {
			any: 'can be a string',
			subObject: { name: 'deeply nested' },
			subArray: [],
		});
		assert.equal(response.status, 204);
		response = await axios.get('http://localhost:9926/namespace/SubObject/i%2Flike%2Fslashes%2E');
		assert.equal(response.status, 200);
	});

	it('get with timestamps and no PK on record', async () => {
		let response = await axios.put('http://localhost:9926/HasTimeStampsNoPK/33', {
			name: 'Look Ma, no primary key!',
		});
		assert.equal(response.status, 204);
		response = await axios.get('http://localhost:9926/HasTimeStampsNoPK/33');
		assert.equal(response.status, 200);
		assert.equal(response.data.name, 'Look Ma, no primary key!');
		assert(response.data.updated > 1689025407526);
		assert(response.data.created > 1689025407526);
		assert.equal(Object.keys(response.data).length, 3);
	});

	it('check headers on get', async () => {
		let response = await axios.get('http://localhost:9926/namespace/SubObject/6', {
			headers: {
				'Custom-Header': 'custom-value',
			},
		});
		assert.equal(headersTest.get('Custom-Header'), 'custom-value');
		assert.equal(headersTest.get('CUSTOM-HEADER'), 'custom-value'); // shouldn't be case sensitive
		let entries = [];
		for (let entry of headersTest) {
			entries.push(entry);
		}
		assert(entries.some((entry) => entry[0] === 'custom-header'));
		let names = Array.from(headersTest.keys());
		assert(names.includes('custom-header'));
		assert(Array.from(headersTest.values()).includes('custom-value'));
	});

	describe('joins', async () => {
		before(async () => {
			let response = await axios.put('http://localhost:9926/Related/6', {
				id: '6',
				name: 'Related 6',
				another: 'Another value',
			});
			response = await axios.put('http://localhost:9926/namespace/SubObject/33', {
				id: '33',
				subObject: { name: 'a sub-object' },
				subArray: [{ name: 'a sub-object of an array' }],
				relatedId: '6',
			});
			response = await axios.put('http://localhost:9926/namespace/SubObject/34', {
				id: '34',
				subObject: { name: 'a sub-object' },
				subArray: [{ name: 'a sub-object of an array' }],
				relatedId: '6',
			});
		});
		it('get data with related data joined', async function () {
			let response = await axios.get('http://localhost:9926/namespace/SubObject/34?select(id,related)');
			assert.equal(response.status, 200);
			assert.equal(response.data.related.name, 'Related 6');
		});
		it('query for data with related data joined', async function () {
			let response = await axios.get('http://localhost:9926/namespace/SubObject/?id=33&select(id,related)');
			assert.equal(response.status, 200);
			assert.equal(response.data[0].related.name, 'Related 6');
		});
		it('query for data by related id with related data joined', async function () {
			let response = await axios.get('http://localhost:9926/namespace/SubObject/?relatedId=6&select(id,related)');
			assert.equal(response.status, 200);
			assert.equal(response.data[1].related.name, 'Related 6');
		});
		it('query for data by related value with related data joined', async function () {
			let response = await axios.get(
				'http://localhost:9926/namespace/SubObject/?related.name=Related 6' + '&sort(-related.name)&select(id,related)'
			);
			assert.equal(response.status, 200);
			assert.equal(response.data[1].related.name, 'Related 6');
			assert.equal(response.data[1].related.id, '6');
		});
		it('query for data by related value with nested query with sub-select', async function () {
			let response = await new Promise((resolve) => {
				let req = request(
					{
						hostname: 'localhost',
						method: 'GET',
						port: 9926,
						path:
							'/namespace/SubObject/?related.name=Related%206|(relatedId=5&id>10)' +
							'&select(id,related{name,otherTable})',
					},
					(res) => {
						res.data = '';
						res.on('data', (data) => {
							res.data += data;
						});
						res.on('end', () => {
							resolve(res);
						});
					}
				);
				req.end();
			});

			assert.equal(response.statusCode, 200);
			const data = JSON.parse(response.data);
			assert.equal(data[1].related.name, 'Related 6');
			assert.equal(data[1].related.id, undefined);
		});
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
			assert(response.data.some((record) => record.title === 'title0'));
		});
		it('search_by_conditions with join', async function () {
			let response = await axios.post(
				'http://localhost:9925',
				{
					operation: 'search_by_conditions',
					schema: 'data',
					table: 'SubObject',
					get_attributes: ['id', 'related'],
					conditions: [{ search_attribute: ['related', 'name'], search_value: 'Related 6' }],
				},
				{
					validateStatus: function (status) {
						return true;
					},
				}
			);
			assert(response.data.some((record) => record.related.name === 'Related 6'));
		});
		it('search_by_conditions with different properties', async function () {
			let response = await axios.post(
				'http://localhost:9925',
				{
					operation: 'search_by_conditions',
					table: 'SubObject',
					select: ['id', 'relatedId'],
					operator: 'or',
					conditions: [
						{ search_attribute: ['relatedId'], value: '6' },
						{
							operator: 'and',
							conditions: [
								{ search_attribute: ['relatedId'], value: '7' },
								{ search_attribute: 'id', value: 'non-existent' },
							],
						},
					],
					sort: {
						attribute: 'id',
						descending: true,
						next: {
							attribute: 'relatedId',
						},
					},
				},
				{
					validateStatus: function (status) {
						return true;
					},
				}
			);
			assert(response.data.some((record) => record.relatedId === '6'));
			assert.equal(response.data[0].id, '34');
			assert.equal(response.data[1].id, '33');
		});

		it('sql returns all attributes of four property object', async function () {
			let response = await axios.post(
				'http://localhost:9925',
				{
					operation: 'sql',
					sql: 'SELECT * FROM data.FourProp',
				},
				{
					validateStatus: function (status) {
						return true;
					},
				}
			);
			if (response.status > 400) console.error(response.data);
			assert(response.data.some((record) => record.title === 'title0'));
		});
		it('sql returns all attributes and sub-object of array', async function () {
			let response = await axios.put('http://localhost:9926/namespace/SubObject/6', {
				id: '6',
				subObject: { name: 'another sub-object' },
				subArray: [{ name: 'another sub-object of an array' }],
			});
			response = await axios.post('http://localhost:9925', {
				operation: 'sql',
				sql: 'SELECT * FROM data.SubObject',
			});
			assert(response.data.some((record) => record.subObject?.name === 'another sub-object'));
		});
	});
});
