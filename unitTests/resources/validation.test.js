require('../testUtils');
const assert = require('assert');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { transaction } = require('#src/resources/transaction');
const { setMainIsWorker } = require('#src/server/threads/manageThreads');

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

describe('Validation of patch operations, coercion write-back and object sub-types', () => {
	let CoercionTest;
	before(function () {
		setupTestDBPath();
		setMainIsWorker(true);
		CoercionTest = table({
			table: 'CoercionTest',
			database: 'test',
			audit: true,
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'balance', type: 'BigInt' },
				{ name: 'count', type: 'Int' },
				{ name: 'when', type: 'Date' },
				{ name: 'sharedLabel', type: 'String' },
				{ name: 'bigList', type: 'array', elements: { type: 'BigInt' } },
				{
					name: 'sub',
					type: 'CoercionSub',
					properties: [
						{ name: 'fromStr', type: 'BigInt' },
						{ name: 'fromNum', type: 'BigInt' },
						{ name: 'subComputed', type: 'String', computed: true },
						{ name: 'sharedLabel', type: 'String', computed: true },
					],
				},
				{
					name: 'strictSub',
					type: 'CoercionStrictSub',
					properties: [
						{ name: 'reqField', type: 'String', nullable: false },
						{ name: 'length', type: 'BigInt' },
					],
				},
			],
		});
	});
	after(async function () {
		await CoercionTest?.dropTable();
	});
	function assertIssues(expected) {
		return (error) => {
			assert.strictEqual(error.name, 'ValidationError');
			assert.deepStrictEqual(
				error.errors.map(({ path, code }) => ({ path, code })),
				expected
			);
			return true;
		};
	}
	it('applies a patch add operation with a number or string delta to a BigInt', async function () {
		await CoercionTest.put('add-1', { balance: 100n });
		await CoercionTest.patch('add-1', { balance: { __op__: 'add', value: 25 } });
		await CoercionTest.patch('add-1', { balance: { __op__: 'add', value: '10' } });
		await CoercionTest.patch('add-1', { balance: Object.freeze({ __op__: 'add', value: 0 }) });
		assert.strictEqual((await CoercionTest.get('add-1')).balance, 135n);
		let loggedPatch;
		for (const entry of CoercionTest.auditStore.getRange({ start: 1 })) {
			if (entry.recordId === 'add-1' && entry.type === 'patch') loggedPatch = entry.getValue(CoercionTest.primaryStore);
		}
		assert.deepStrictEqual({ ...loggedPatch.balance }, { __op__: 'add', value: 0n });

		await CoercionTest.put('add-2', {});
		await CoercionTest.patch('add-2', { balance: { __op__: 'add', value: 15 } });
		assert.strictEqual((await CoercionTest.get('add-2')).balance, 15n);
	});
	it('applies addTo and subtractFrom on a BigInt', async function () {
		await CoercionTest.put('add-3', { balance: 100n });
		await transaction(async (txn) => {
			const record = await CoercionTest.update('add-3', {}, txn);
			record.addTo('balance', 7);
		});
		await transaction(async (txn) => {
			const record = await CoercionTest.update('add-3', {}, txn);
			record.subtractFrom('balance', 2);
		});
		assert.strictEqual((await CoercionTest.get('add-3')).balance, 105n);
	});
	it('leaves a patch add operation on an Int as a number delta', async function () {
		await CoercionTest.put('add-4', { count: 10 });
		await CoercionTest.patch('add-4', { count: { __op__: 'add', value: 3 } });
		const record = await CoercionTest.get('add-4');
		assert.strictEqual(record.count, 13);
		await assert.rejects(
			async () => CoercionTest.patch('add-4', { count: { __op__: 'add', value: 'three' } }),
			assertIssues([{ path: 'count', code: 'type' }])
		);
	});
	it('rejects a patch operation with a null or non-numeric operand, or on a non-numeric property', async function () {
		await CoercionTest.put('add-5', { balance: 100n, when: new Date(0), sub: { fromStr: 1n } });
		await assert.rejects(
			async () => CoercionTest.patch('add-5', { balance: { __op__: 'add', value: null } }),
			assertIssues([{ path: 'balance', code: 'type' }])
		);
		await assert.rejects(
			async () => CoercionTest.patch('add-5', { balance: { __op__: 'add', value: { __op__: 'add', value: 1 } } }),
			assertIssues([{ path: 'balance', code: 'type' }])
		);
		await assert.rejects(
			async () => CoercionTest.patch('add-5', { when: { __op__: 'add', value: '2026-01-01' } }),
			assertIssues([{ path: 'when', code: 'type' }])
		);
		await assert.rejects(
			async () => CoercionTest.patch('add-5', { sub: { __op__: 'add', value: null } }),
			assertIssues([{ path: 'sub', code: 'type' }])
		);
		const record = await CoercionTest.get('add-5');
		assert.strictEqual(record.balance, 100n);
		assert.strictEqual(record.when.getTime(), 0);
		assert.strictEqual(record.sub.fromStr, 1n);
		await CoercionTest.patch('add-5', { balance: { __op__: 'add', value: 1 } });
		assert.strictEqual((await CoercionTest.get('add-5')).balance, 101n);
	});
	it('coerces zero to 0n in object sub-types and arrays', async function () {
		await CoercionTest.put('zero-1', { sub: { fromStr: '0', fromNum: 0 }, bigList: ['0', 0, '5'] });
		const record = await CoercionTest.get('zero-1');
		assert.strictEqual(record.sub.fromStr, 0n);
		assert.strictEqual(record.sub.fromNum, 0n);
		assert.deepStrictEqual(Array.from(record.bigList), [0n, 0n, 5n]);
	});
	it('checks computed properties of a sub-type on the sub-object', async function () {
		await assert.rejects(
			async () => CoercionTest.put('computed-1', { sub: { subComputed: 'injected' } }),
			assertIssues([{ path: 'sub.subComputed', code: 'computed' }])
		);
		await CoercionTest.put('computed-2', { sharedLabel: 'top-level', sub: { fromNum: 1 } });
		assert.strictEqual((await CoercionTest.get('computed-2')).sharedLabel, 'top-level');
		await CoercionTest.put('computed-3', Object.assign(Object.create(null), { sub: { fromNum: 2 } }));
		assert.strictEqual((await CoercionTest.get('computed-3')).sub.fromNum, 2n);
	});
	it('rejects an array or primitive for an object sub-type with one error', async function () {
		await assert.rejects(
			async () => CoercionTest.put('object-1', { sub: ['not', 'an', 'object'] }),
			assertIssues([{ path: 'sub', code: 'type' }])
		);
		await assert.rejects(
			async () => CoercionTest.put('object-2', { strictSub: 'hello' }),
			assertIssues([{ path: 'strictSub', code: 'type' }])
		);
	});
});
