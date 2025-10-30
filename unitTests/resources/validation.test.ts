import { describe, it, before, after } from 'mocha';
import assert from 'assert';
import { cleanupTestSandbox, createTestSandbox } from '../testUtils';
import { table } from '@/resources/databases';
import { setMainIsWorker } from '@/server/threads/manageThreads';

describe('Types Validation', () => {
	let ValidationTest;

	before(() => {
		createTestSandbox();
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

	after(cleanupTestSandbox);

	it('Accepts correct types', async () => {
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
		let result = ValidationTest.get(42);
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

	it('Rejects without primary key', () => {
		assert.throws(() =>
			ValidationTest.put({
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

	it('Rejects incorrect types', () => {
		assert.throws(() =>
			ValidationTest.put(42, {
				str: 444,
			})
		);
		assert.throws(() =>
			ValidationTest.put(42, {
				num: 'wrong type',
			})
		);
		assert.throws(() =>
			ValidationTest.put(42, {
				bool: 'wrong type',
			})
		);
		assert.throws(() =>
			ValidationTest.put(42, {
				bytes: { name: 'wrong type' },
			})
		);
		assert.throws(() =>
			ValidationTest.put(42, {
				int: 2147483658,
			})
		);
		assert.throws(() =>
			ValidationTest.put(42, {
				long: 9007199254740999,
			})
		);
		assert.throws(() =>
			ValidationTest.put(42, {
				subObject: 'wrong type',
			})
		);
		assert.throws(() =>
			ValidationTest.put(42, {
				subObject: { name: 32 },
			})
		);
		assert.throws(() =>
			ValidationTest.put(42, {
				subObject: { name: null },
			})
		);
		assert.throws(() =>
			ValidationTest.put(42, {
				subObject: {},
			})
		);
		assert.throws(() =>
			ValidationTest.put(42, {
				arrayOfStrings: [32],
			})
		);
		assert.throws(() =>
			ValidationTest.put(42, {
				undeclaredProperty: 33, // not allowed because it is sealed
			})
		);
		assert.throws(() =>
			ValidationTest.put(42, {
				subObject: {
					name: 'valid',
					undeclaredSubProperty: 33, // not allowed because it is sealed
				},
			})
		);
	});
});
