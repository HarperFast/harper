require('../test_utils');
const assert = require('assert');
const { RECORD_PROPERTY } = require('../../resources/Resource');
const { assignTrackedAccessors, deepFreeze, hasChanges, collapseData } = require('../../resources/tracked');
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
		{ name: 'str' },
		{ name: 'num' },
		{ name: 'bool' },
		{ name: 'arrayOfStrings' },
		{ name: 'subObject', properties: [{ name: 'name' }] },
		{ name: 'arrayOfObjects' },
	];
	class ResourceClass {}
	assignTrackedAccessors(ResourceClass, { attributes });
	before(function () {});
	it('Can read from RecordObject', async function () {
		let instance = new ResourceClass();
		instance[RECORD_PROPERTY] = source;
		assert.equal(instance.str, 'string');
		assert.equal(instance.num, 42);
		assert.equal(instance.bool, false);
		assert.equal(instance.arrayOfStrings[0], 'str1');
		assert.equal(collapseData(instance).str, 'string');
		assert.equal(collapseData(instance).num, 42);
		assert.equal(deepFreeze(instance).str, 'string');
	});
	it('Can update RecordObject', async function () {
		let instance = new ResourceClass();
		instance[RECORD_PROPERTY] = source;
		assert.equal(hasChanges(instance), false);
		instance.str = 'new string';
		instance.num = 32;
		instance.set('newProperty', 'new value');
		instance.transitiveProperty = 'here for now';
		assert.equal(hasChanges(instance), true);
		assert.equal(instance.str, 'new string');
		assert.equal(instance.num, 32);
		assert.equal(instance.get('newProperty'), 'new value');
		assert.equal(collapseData(instance).str, 'new string');
		assert.equal(collapseData(instance).num, 32);
		assert.equal(collapseData(instance).newProperty, 'new value');
		assert.equal(collapseData(instance).transitiveProperty, 'here for now');
		assert.equal(deepFreeze(instance).str, 'new string');
		assert.equal(deepFreeze(instance).num, 32);
		assert.equal(deepFreeze(instance).newProperty, 'new value');
		assert.equal(deepFreeze(instance).transitiveProperty, undefined);
	});
	it('Can update detect sub object change', async function () {
		let instance = new ResourceClass();
		instance[RECORD_PROPERTY] = source;
		assert.equal(hasChanges(instance), false);
		instance.subObject.name = 'changed sub';
		assert.equal(hasChanges(instance), true);
		assert.equal(collapseData(instance).subObject.name, 'changed sub');
		assert.equal(collapseData(instance).str, 'string');
	});
	it('Can update detect array push', async function () {
		let instance = new ResourceClass();
		instance[RECORD_PROPERTY] = source;
		assert.equal(hasChanges(instance), false);
		instance.arrayOfStrings.push('another string');
		assert.equal(hasChanges(instance), true);
		assert.equal(collapseData(instance).arrayOfStrings[0], 'str1');
		assert.equal(collapseData(instance).arrayOfStrings[2], 'another string');
	});
});
