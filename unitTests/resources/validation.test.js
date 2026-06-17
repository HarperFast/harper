require('../testUtils');
const assert = require('assert');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');

describe('Types Validation', () => {
	let ValidationTest;
	before(async function () {
		setupTestDBPath();
		setMainIsWorker(true);
		ValidationTest = table({
			table: 'ValidationTest',
			database: 'test',
			sealed: true,
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'str', type: 'String' },
				{ name: 'num', type: 'Float' },
				{ name: 'int', type: 'Int' },
				{ name: 'long', type: 'Long' },
				{ name: 'bool', type: 'Boolean' },
				{ name: 'bytes', type: 'Bytes' },
				{ name: 'arrayOfStrings', type: 'array', elements: { type: 'String' } },
				{
					name: 'subObject',
					type: 'SubObject',
					sealed: true,
					properties: [{ name: 'name', type: 'String', nullable: false }],
				},
				{ name: 'computed', type: 'String', computed: true },
			],
		});
		ValidationTest.setComputedAttribute('computed', (instance) => instance.str + ' computed');
	});
	it('Accepts correct types', async function () {
		await ValidationTest.put(42, {
			str: 'hello',
			num: 3.14,
			int: 2147483640,
			long: 12147483648,
			bool: true,
			bytes: Buffer.from([1, 2, 3]),
			arrayOfStrings: ['hi', 'there'],
			subObject: {
				name: 'inside',
			},
		});
		let result = await ValidationTest.get(42);
		assert.equal(result.computed, 'hello computed');
		await ValidationTest.put(42, {
			str: null,
			num: null,
			bool: null,
			bytes: null,
			arrayOfStrings: null,
			subObject: null,
		});
	});
	it('Rejects without primary key', async function () {
		await assert.rejects(
			async () =>
				await ValidationTest.put({
					str: 'hello',
					num: 3.14,
					int: 2147483640,
					long: 12147483648,
					bool: true,
					bytes: Buffer.from([1, 2, 3]),
					arrayOfStrings: ['hi', 'there'],
					subObject: {
						name: 'inside',
					},
				})
		);
	});
	it('Rejects incorrect types', async function () {
		await assert.rejects(
			async () =>
				await ValidationTest.put(42, {
					str: 444,
				})
		);
		await assert.rejects(
			async () =>
				await ValidationTest.put(42, {
					num: 'wrong type',
				})
		);
		await assert.rejects(
			async () =>
				await ValidationTest.put(42, {
					bool: 'wrong type',
				})
		);
		await assert.rejects(
			async () =>
				await ValidationTest.put(42, {
					bytes: { name: 'wrong type' },
				})
		);
		await assert.rejects(
			async () =>
				await ValidationTest.put(42, {
					int: 2147483658,
				})
		);
		await assert.rejects(
			async () =>
				await ValidationTest.put(42, {
					long: 9007199254740999,
				})
		);
		await assert.rejects(
			async () =>
				await ValidationTest.put(42, {
					subObject: 'wrong type',
				})
		);
		await assert.rejects(
			async () =>
				await ValidationTest.put(42, {
					subObject: { name: 32 },
				})
		);
		await assert.rejects(
			async () =>
				await ValidationTest.put(42, {
					subObject: { name: null },
				})
		);
		await assert.rejects(
			async () =>
				await ValidationTest.put(42, {
					subObject: {},
				})
		);
		await assert.rejects(
			async () =>
				await ValidationTest.put(42, {
					arrayOfStrings: [32],
				})
		);
		await assert.rejects(
			async () =>
				await ValidationTest.put(42, {
					undeclaredProperty: 33, // not allowed because it is sealed
				})
		);
		await assert.rejects(
			async () =>
				await ValidationTest.put(42, {
					subObject: {
						name: 'valid',
						undeclaredSubProperty: 33, // not allowed because it is sealed
					},
				})
		);
	});
	after(async function () {
		await ValidationTest?.dropTable();
	});
});
