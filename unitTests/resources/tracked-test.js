require('../test_utils');
const assert = require('assert');
const {
	assignTrackedAccessors,
	updateAndFreeze,
	hasChanges,
	collapseData,
	GenericTrackedObject,
} = require('../../resources/tracked');
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
