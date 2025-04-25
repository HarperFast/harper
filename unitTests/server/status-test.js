'use strict';

const assert = require('node:assert/strict');
const status = require('../../server/status');
const { Resource } = require('../../resources/Resource');

describe('server.status', function () {
	const clearStatus = async () => Promise.all(['primary', 'test', 'maintenance'].map((id) => status.clear({ id })));
	beforeEach(() => clearStatus());
	after(() => clearStatus());

	const assertAndOverrideTimestamps = (obj) => {
		assert.ok(obj.__updatedtime__ !== undefined);
		assert.ok(obj.__createdtime__ !== undefined);
		obj.__updatedtime__ = 42;
		obj.__createdtime__ = 42;
	};

	it('should set status', async function () {
		const statusObj = {
			status: 'starting',
		};
		const result = await status.set(statusObj);
		assert.ok(result === undefined);
	});

	it('should get specific status', async function () {
		const statusObj = {
			id: 'primary',
			status: 'testing',
		};
		const expected = {
			id: 'primary',
			status: 'testing',
			__updatedtime__: 42,
			__createdtime__: 42,
		};
		await status.set(statusObj);
		const result = await status.get({ id: 'primary' });
		// node assert/strict is blind to resource properties
		const resultObj = JSON.parse(JSON.stringify(result));
		assertAndOverrideTimestamps(resultObj);
		assert.deepEqual(expected, resultObj);
	});

	it('should get complete status with just primary set', async function () {
		const statusObj = {
			id: 'primary',
			status: 'testing',
		};
		const expected = [
			{
				id: 'primary',
				status: 'testing',
				__updatedtime__: 42,
				__createdtime__: 42,
			},
		];
		await status.set(statusObj);
		const result = await status.get({});
		// Pull result iterator into an array
		const resultArray = [];
		for await (const item of result) {
			assertAndOverrideTimestamps(item);
			resultArray.push(item);
		}
		assert.deepEqual(resultArray, expected);
	});

	it('should get complete status', async function () {
		const statusObjs = [
			{
				id: 'primary',
				status: 'testing',
			},
			{
				id: 'maintenance',
				status: 'testing will continue',
			},
		];
		// assuming the status objects are in id order
		const expected = [
			{
				id: 'maintenance',
				status: 'testing will continue',
				__updatedtime__: 42,
				__createdtime__: 42,
			},
			{
				id: 'primary',
				status: 'testing',
				__updatedtime__: 42,
				__createdtime__: 42,
			},
		];
		await Promise.all(statusObjs.map((sO) => status.set(sO)));
		const result = await status.get({});
		// Pull result iterator into an array
		const resultArray = [];
		for await (const item of result) {
			assertAndOverrideTimestamps(item);
			resultArray.push(item);
		}
		assert.deepEqual(resultArray, expected);
	});

	it('should fail validation on test status', async function () {
		const statusObjs = [
			{
				id: 'primary',
				status: 'testing',
			},
			{
				id: 'test',
				status: 'really testing',
			},
			{
				id: 'maintenance',
				status: 'testing will continue',
			},
		];
		await assert.rejects(async () => Promise.all(statusObjs.map((sO) => status.set(sO))), {
			name: 'Error',
			message: "'id' must be one of [primary, maintenance]",
		});
	});
});
