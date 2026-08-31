const assert = require('assert');
const {
	assignTrackedAccessors,
	updateAndFreeze,
	hasChanges,
	collapseData,
	GenericTrackedObject,
} = require('#src/resources/tracked');
const harperLogger = require('#src/utility/logging/harper_logger');
describe('Tracked Object', () => {
	let source = {
		str: 'string',
		num: 42,
		bool: false,
		arrayOfStrings: ['str1', 'str2'],
		subObject: {
			name: 'sub',
		},
		arrayOfObjects: [{ name: 'objectInArray' }],
	};
	let attributes = [
		{ name: 'str', type: 'String' },
		{ name: 'num', type: 'Float' },
		{ name: 'bool', type: 'Boolean' },
		{ name: 'bytes', type: 'Bytes' },
		{ name: 'arrayOfStrings', type: 'array', elements: { type: 'String ' } },
		{ name: 'subObject', properties: [{ name: 'name' }] },
		{ name: 'arrayOfObjects' },
	];
	class ResourceClass extends GenericTrackedObject {}
	assignTrackedAccessors(ResourceClass, { attributes });
	before(function () {});
	it('Can read from RecordObject', async function () {
		let instance = new ResourceClass(source);
		assert.equal(instance.str, 'string');
		assert.equal(instance.num, 42);
		assert.equal(instance.bool, false);
		assert.equal(instance.arrayOfStrings[0], 'str1');
		assert.equal(collapseData(instance).str, 'string');
		assert.equal(collapseData(instance).num, 42);
		assert.equal(updateAndFreeze(instance).str, 'string');
	});
	it('Can update RecordObject', async function () {
		let instance = new ResourceClass(source);
		assert.equal(hasChanges(instance), false);
		instance.str = 'new string';
		instance.num = 32;
		instance.set('newProperty', 'new value');
		let bytes = (instance.bytes = Buffer.from([1, 2, 3]));
		instance.directNewProperty = 'here now';
		assert.equal(hasChanges(instance), true);
		assert.equal(instance.str, 'new string');
		assert.equal(instance.num, 32);
		assert.equal(instance.get('newProperty'), 'new value');
		assert.equal(instance.bytes, bytes);
		assert.equal(collapseData(instance).str, 'new string');
		assert.equal(collapseData(instance).num, 32);
		assert.equal(collapseData(instance).newProperty, 'new value');
		assert.equal(collapseData(instance).directNewProperty, 'here now');
		assert.equal(updateAndFreeze(instance).str, 'new string');
		assert.equal(updateAndFreeze(instance).num, 32);
		assert.equal(updateAndFreeze(instance).newProperty, 'new value');
		assert.equal(updateAndFreeze(instance).directNewProperty, 'here now');
	});

	it('Can reject invalid types', async function () {
		let instance = new ResourceClass(source);
		assert.equal(hasChanges(instance), false);
		assert.throws(() => (instance.str = 4));
		assert.throws(() => (instance.num = 'wrong type'));
		assert.throws(() => (instance.bool = 'wrong type'));
		assert.throws(() => (instance.bytes = 'wrong type'));
		assert.throws(() => (instance.arrayOfStrings = 'wrong type'));
	});

	it('Can update detect sub object change', async function () {
		let instance = new ResourceClass(source);
		assert.equal(hasChanges(instance), false);
		instance.subObject.name = 'changed sub';
		assert.equal(hasChanges(instance), true);
		assert.equal(collapseData(instance).subObject.name, 'changed sub');
		assert.equal(collapseData(instance).str, 'string');
	});
	it('Can update detect array push', async function () {
		let instance = new ResourceClass(source);
		assert.equal(hasChanges(instance), false);
		instance.arrayOfStrings.push('another string');
		assert.equal(hasChanges(instance), true);
		assert.equal(collapseData(instance).arrayOfStrings[0], 'str1');
		assert.equal(collapseData(instance).arrayOfStrings[2], 'another string');
	});
});

describe('updateAndFreeze CRDT operations', () => {
	it('applies a recognized add operation', () => {
		const result = updateAndFreeze({ count: 5 }, { count: { __op__: 'add', value: 3 } });
		assert.strictEqual(result.count, 8);
	});

	it('skips an unrecognized operation instead of throwing (apply path must not wedge)', () => {
		// On the write/replication apply path a throw would abort the commit and can wedge a
		// subscription, so an op this version can't apply is warned + skipped; the field keeps its
		// base value and a full-copy re-converges the record.
		const original = harperLogger.warn;
		let warned = '';
		harperLogger.warn = (message) => {
			warned = message;
		};
		try {
			let result;
			assert.doesNotThrow(() => {
				result = updateAndFreeze({ count: 5 }, { count: { __op__: 'multiply', value: 3 } });
			});
			assert.strictEqual(result.count, 5); // unchanged base value
			assert.match(warned, /unrecognized CRDT operation "multiply"/);
		} finally {
			harperLogger.warn = original;
		}
	});

	it('does not invoke a non-operation crdt export named by a crafted __op__', () => {
		// Ops resolve against the explicit registry, not the crdt.ts export namespace. Before that,
		// `__op__: 'getRecordAtTime'` resolved to the exported function and was invoked with the
		// wrong arguments — throwing and wedging the apply path. It must now warn + skip like any
		// other unrecognized op.
		const original = harperLogger.warn;
		let warned = '';
		harperLogger.warn = (message) => {
			warned = message;
		};
		try {
			let result;
			assert.doesNotThrow(() => {
				result = updateAndFreeze({ count: 5 }, { count: { __op__: 'getRecordAtTime', value: 3 } });
			});
			assert.strictEqual(result.count, 5);
			assert.match(warned, /unrecognized CRDT operation "getRecordAtTime"/);
		} finally {
			harperLogger.warn = original;
		}
	});
});
