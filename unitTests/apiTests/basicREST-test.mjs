import whyIsNodeStillRunning from 'why-is-node-still-running';
import { assert, expect } from 'chai';
import axios from 'axios';
import { decode, encode, DecoderStream } from 'cbor-x';
import { getVariables } from './utility.js';
import { setupTestApp } from './setupTestApp.mjs';
import http from 'node:http';
const { authorization, url } = getVariables();

describe('test REST calls', () => {
	let available_records;
	before(async function () {
		this.timeout(10000);
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
		assert(Date.parse(response.headers['last-modified']) > 1696617497581);
		let data = JSON.parse(response.data);
		assert.equal(available_records[1], data.id);
	});
	it('do get with CBOR', async () => {
		const headers = {
			//authorization,
			accept: 'application/cbor',
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
				'If-None-Match': response.headers.etag,
				...headers,
			},
			validateStatus: function (status) {
				return status >= 200 && status < 400;
			},
		});
		assert.equal(response.status, 304);
		response = await axios({
			url: 'http://localhost:9926/VariedProps/',
			method: 'GET',
			responseType: 'arraybuffer',
			headers,
		});
		assert.equal(response.status, 200);
		data = decode(response.data);
		assert(data[3].id);
	});
	it('PUT with CBOR', async () => {
		setTimeout(() => {
			//why_is_node_running.whyIsNodeStillRunning();
		}, 4000).unref();
		const headers = {
			//authorization,
			'content-type': 'application/cbor',
			'accept': 'application/cbor',
		};
		let response = await axios.put(
			'http://localhost:9926/VariedProps/33',
			encode({
				id: '33',
				name: 'new record',
			}),
			{
				responseType: 'arraybuffer',
				headers,
			}
		);
		assert.equal(response.status, 204);
		response = await axios('http://localhost:9926/VariedProps/33');
		assert.equal(response.data.name, 'new record');
	});
	it('POST a new record', async () => {
		const headers = {
			//authorization,
		};
		let response = await axios.post('http://localhost:9926/VariedProps/', {
			name: 'new record without an id',
		});
		assert.equal(response.status, 201);
		assert.equal(typeof response.data, 'string');
		let id = response.data;
		response = await axios.get('http://localhost:9926/VariedProps/' + id);
		assert.equal(response.data.id, id);
		response = await axios.delete('http://localhost:9926/VariedProps/' + id);
		assert.equal(response.status, 200);
		assert.equal(response.data, true);
	});
	it('POST a new record with a specified id', async () => {
		const headers = {
			//authorization,
		};
		let response = await axios.post('http://localhost:9926/VariedProps/', {
			name: 'new record with an id',
			id: '12345678901234567890',
		});
		assert.equal(response.status, 201);
		assert.equal(typeof response.data, 'string');
		assert.equal(response.data, '12345678901234567890');
		response = await axios.get('http://localhost:9926/VariedProps/12345678901234567890');
		assert.equal(response.data.id, '12345678901234567890');
		response = await axios.delete('http://localhost:9926/VariedProps/12345678901234567890');
		assert.equal(response.status, 200);
		assert.equal(response.data, true);
	});
	describe('describe', function () {
		it('table describe with root url', async () => {
			let response = await axios('http://localhost:9926/FourProp');
			assert.equal(response.status, 200);
			assert(response.data.recordCount >= 10);
			assert.equal(response.data.attributes.length, 7);
			assert.equal(response.data.name, 'FourProp');
		});
	});
	describe('querying with query parameters', function () {
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
		it('do query by starts with', async () => {
			let response = await axios('http://localhost:9926/FourProp/?name==name*');
			assert.equal(response.status, 200);
			assert.equal(response.data.length, 10);
		});
		it('do query by starts with and ends with', async () => {
			let response = await axios('http://localhost:9926/FourProp/?name==name*&name=ew=4');
			assert.equal(response.status, 200);
			assert.equal(response.data.length, 1);
		});
		it('do query with contains', async () => {
			let response = await axios('http://localhost:9926/FourProp/?name=sw=name&name=ct=4');
			assert.equal(response.status, 200);
			assert.equal(response.data.length, 1);
		});
		it('do a less than query by numeric property', async () => {
			let response = await axios('http://localhost:9926/FourProp/?age=lt=25');
			assert.equal(response.status, 200);
			assert.equal(response.data.length, 5);
			assert.equal(response.data[4].age, 24);
		});
		it('do a less than query or equal by numeric property', async () => {
			let response = await axios('http://localhost:9926/FourProp/?age=le=25');
			assert.equal(response.status, 200);
			assert.equal(response.data.length, 6);
			assert.equal(response.data[5].age, 25);
		});
		it('do a less than query or equal and FIQL not-equal by numeric property', async () => {
			let response = await axios('http://localhost:9926/FourProp/?age=ne=22&age=le=25');
			assert.equal(response.status, 200);
			assert.equal(response.data.length, 5);
			assert.equal(response.data[4].age, 25);
		});
		it('do a less than query or equal and not-equal by numeric property', async () => {
			let response = await axios('http://localhost:9926/FourProp/?age!=22&age=le=25');
			assert.equal(response.status, 200);
			assert.equal(response.data.length, 5);
			assert.equal(response.data[4].age, 25);
		});
		it('do a less than or equal and operator precedence', async () => {
			let response = await axios('http://localhost:9926/FourProp/?age=le=29&[age=ge=27|[age=gt=21&age=lt=23]]');
			assert.equal(response.status, 200);
			assert.equal(response.data.length, 4);
			assert.equal(response.data[0].age, 22);
			assert.equal(response.data[3].age, 29);
		});
		it('do a less than query by numeric property with limit and offset', async () => {
			let response = await axios('http://localhost:9926/FourProp/?age=lt=25&limit(1,3)');
			assert.equal(response.status, 200);
			assert.equal(response.data.length, 2);
			assert.equal(response.data[1].age, 22);
		});

		it('do a less than query by numeric property with limit', async () => {
			let response = await axios('http://localhost:9926/FourProp/?age=lt=25&limit(3)');
			assert.equal(response.status, 200);
			assert.equal(response.data.length, 3);
			assert.equal(response.data[2].age, 22);
		});
		it('do query by numeric computed index', async () => {
			let response = await axios('http://localhost:9926/FourProp/?ageInMonths=lt=300');
			assert.equal(response.status, 200);
			assert.equal(response.data.length, 5);
			assert.equal(response.data[4].age, 24);
			assert.equal(response.data[4].ageInMonths, undefined); // computed property shouldn't be returned by default
			assert.equal(response.data[4].nameTitle, undefined); // computed property shouldn't be returned by default
		});
		it('do query by numeric computed index and return computed property', async () => {
			let response = await axios(
				'http://localhost:9926/FourProp/?ageInMonths=288&select(id,age,ageInMonths,nameTitle)'
			);
			assert.equal(response.status, 200);
			assert.equal(response.data.length, 1);
			assert.equal(response.data[0].age, 24);
			assert.equal(response.data[0].ageInMonths, 288);
			assert.equal(response.data[0].nameTitle, 'name4 title4');
		});

		it('by primary key', async () => {
			// this test also tests to ensure deleted values are not reachable
			let response = await axios('http://localhost:9926/VariedProps/?id=sw=8');
			assert.equal(response.status, 200);
			if (response.data.length > 2) console.log('Record starting with 8', response.data);
			assert.equal(response.data.length, 2);
			assert.equal(response.data[0].id[0], '8');
		});

		it('query with select two properties', async () => {
			let response = await axios('http://localhost:9926/FourProp?age=lt=22&select(age,id)');
			assert.equal(response.status, 200);
			assert.equal(response.data.length, 2);
			assert.equal(response.data[1].age, 21);
			assert.equal(response.data[1].id, 1);
			assert.equal(response.data[0].name, undefined);
			assert.equal(response.data[1].name, undefined);
		});
		it('query with select one properties', async () => {
			let response = await axios('http://localhost:9926/FourProp?age=lt=22&select(age)');
			assert.equal(response.status, 200);
			assert.equal(response.data.length, 2);
			assert.equal(response.data[1], 21);
		});
		it('query with select one properties and limit', async () => {
			let response = await axios('http://localhost:9926/FourProp?select(id)&limit(2)');
			assert.equal(response.status, 200);
			assert.equal(response.data.length, 2);
			assert.equal(response.data[1], '1');
		});
		it('query with only limit', async () => {
			let response = await axios('http://localhost:9926/FourProp?limit(2)');
			assert.equal(response.status, 200);
			assert.equal(response.data.length, 2);
			assert.equal(response.data[1].id, '1');
		});
		it('query with select two properties as array', async () => {
			let response = await axios('http://localhost:9926/FourProp?age=lt=22&select([age,id])');
			assert.equal(response.status, 200);
			assert.equal(response.data.length, 2);
			assert.equal(response.data[1][0], 21);
			assert.equal(response.data[1][1], 1);
		});
		it('query by date', async () => {
			let response = await axios('http://localhost:9926/FourProp?birthday=gt=1993-01-22&birthday=lt=1994-11-22');
			assert.equal(response.status, 200);
			assert.equal(response.data.length, 2);
			assert.equal(response.data[0].birthday.slice(0, 4), '1993');
			assert.equal(response.data[1].birthday.slice(0, 4), '1994');
		});
		it('query by typed epoch date', async () => {
			let response = await axios(
				'http://localhost:9926/FourProp?birthday=gt=date:727660800000&birthday=lt=date:1994-11-22'
			);
			assert.equal(response.status, 200);
			assert.equal(response.data.length, 2);
			assert.equal(response.data[0].birthday.slice(0, 4), '1993');
			assert.equal(response.data[1].birthday.slice(0, 4), '1994');
		});
		it('query by typed date compared with number', async () => {
			// a little silly, but just verify that a date can be compared with a number in case the number is an epoch date
			let response = await axios('http://localhost:9926/FourProp?age=lt=date:1994-11-22');
			assert.equal(response.status, 200);
			assert.equal(response.data.length, 10);
		});
		it('query and return text/csv', async () => {
			let response = await axios('http://localhost:9926/FourProp?birthday=gt=1993-01-22&birthday=lt=1994-11-22', {
				headers: { accept: 'text/csv' },
			});
			assert.equal(response.status, 200);
			assert.deepEqual(response.data.split('\n')[0].split(',').map(JSON.parse), [
				'id',
				'name',
				'age',
				'title',
				'birthday',
			]);
		});

		it('query with parenthesis in value', async () => {
			// at least shouldn't throw an error
			let response = await axios('http://localhost:9926/FourProp?birthday=no(match)for this)');
			assert.equal(response.status, 200);
			assert.equal(response.data.length, 0);
		});
		it('query has restricted properties for restricted user', async () => {
			let response = await axios('http://localhost:9926/FourProp?limit(2)', {
				headers: {
					Authorization: 'Basic ' + Buffer.from('test:test').toString('base64'),
				},
			});
			assert.equal(response.status, 200);
			assert.equal(response.data.length, 2);
			assert.equal(response.data[0].name, 'name0');
			assert.equal(response.data[0].birthday, undefined); // shouldn't be returned
		});
		it('query can access table that is not exported for rest', async () => {
			let response = await axios('http://localhost:9926/ManyToMany/', {
				headers: {
					Authorization: 'Basic ' + Buffer.from('test:test').toString('base64'),
				},
				validateStatus: function (status) {
					return true;
				},
			});
			assert.equal(response.status, 404);
		});
	});
	it('invalidate and get from cache and check headers', async () => {
		let response = await axios.post('http://localhost:9926/SimpleCache/3', {
			invalidate: true,
		});
		response = await axios('http://localhost:9926/SimpleCache/3');
		assert.equal(response.status, 200);
		assert(response.headers['server-timing'].includes('miss'));
		assert.equal(response.data.name, 'name3');
		response = await axios('http://localhost:9926/SimpleCache/3');
		assert.equal(response.status, 200);
		assert(!response.headers['server-timing'].includes('miss'));
		assert.equal(response.data.name, 'name3');
	});
	it('query from cache with errors', async () => {
		// ensure that the error entry exists so we can query with it.
		let response = await axios.post('http://localhost:9926/SimpleCache/error', {
			invalidate: true,
		});
		response = await axios.post('http://localhost:9926/SimpleCache/error2', {
			invalidate: true,
		});
		response = await axios.post('http://localhost:9926/SimpleCache/undefined', {
			invalidate: true,
		});
		response = await axios('http://localhost:9926/SimpleCache/?select(id,name)');
		assert.equal(response.status, 200);
		assert(response.data.length > 10);
		assert(response.data[response.data.length - 2].error.includes('Error'));
		assert(response.data[response.data.length - 2].message.includes('Test error'));
		assert(response.data[response.data.length - 2].id.includes('error'));
		response = await axios('http://localhost:9926/SimpleCache/?id=gt=3');
		assert.equal(response.status, 200);
		assert(response.data.length < 10);
		assert(response.data[response.data.length - 2].message.includes('Test error'));
		assert(response.data[response.data.length - 2].id.includes('error'));
		// TODO: Test computed properties
	});
	it('delete with body', async () => {
		// we have to use native request module here, axios doesn't actually support
		// sending a body with a DELETE request
		return new Promise((resolve, reject) => {
			const body = JSON.stringify({
				doesThisTransmit: true,
			});
			const req = http.request(
				{
					method: 'DELETE',
					hostname: 'localhost',
					port: 9926,
					path: '/SimpleCache/35555',
					headers: {
						'Content-Type': 'application/json',
						'Content-Length': body.length,
					},
				},
				(res) => {
					try {
						assert(tables.SimpleCache.lastDeleteData.doesThisTransmit);
						resolve(res.statusCode === 200);
					} catch (error) {
						reject(error);
					}
				}
			);
			req.end(body);
		});
	});
	it('post with custom response', async () => {
		const response = await axios.post('http://localhost:9926/SimpleCache/35555', {
			customResponse: true,
		});
		assert.equal(response.status, 222);
		assert.equal(response.headers['x-custom-header'], 'custom value');
		assert.equal(response.data.property, 'custom response');
	});
	describe('BigInt', function () {
		let bigint64BitAsString = '12345678901234567890';
		let json = `{"anotherBigint":-12345678901234567890,"id":12345678901234567890,"name":"new record with a bigint"}`;
		const headers = {
			'content-type': 'application/json',
			'accept': 'application/json',
		};
		before(async () => {
			let response = await axios.put('http://localhost:9926/HasBigInt/12345678901234567890', json, { headers });
			assert.equal(response.status, 204);
		});
		it('GET with BigInt', async () => {
			let response = await axios.get('http://localhost:9926/HasBigInt/12345678901234567890', {
				responseType: 'arraybuffer',
				headers,
			});
			assert.equal(response.status, 200);
			const returned_json = response.data.toString();
			assert.equal(returned_json, json);
			assert(returned_json.includes(bigint64BitAsString));
			// make sure it parses and the number is correct as far as JS is concerned
			let data = JSON.parse(response.data);
			assert.equal(data.anotherBigint, -Number(bigint64BitAsString));
		});
		it('Query with BigInt', async () => {
			let response = await axios.get('http://localhost:9926/HasBigInt/?id=12345678901234567890', {
				responseType: 'arraybuffer',
				headers,
			});
			assert.equal(response.status, 200);
			const returned_json = response.data.toString();
			assert(returned_json.includes('"anotherBigint":-12345678901234567890'));
			assert(returned_json.includes('"id":12345678901234567890'));
			// make sure it parses and the number is correct as far as JS is concerned
			let data = JSON.parse(response.data);
			assert.equal(data[0].anotherBigint, -Number(bigint64BitAsString));
		});
	});
	it('conflicted endpoints return error', async () => {
		const response = await axios.get('http://localhost:9926/Conflicted/35555', {
			customResponse: true,
			validateStatus: function (status) {
				return true;
			},
		});
		assert.equal(response.status, 500);
		assert(response.data.includes('Conflicting paths'));
	});
});
