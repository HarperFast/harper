/**
 * Attribute checking in the operations-API search validator. The object/nested `get_attributes`
 * form used to skip the check entirely, so an attribute the serving thread could not resolve
 * passed validation and came back as a null indistinguishable from an absent value (#2296).
 */
require('../testUtils');
const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const searchValidator = require('#src/validation/searchValidator').default;

describe('search validator attribute checking', () => {
	const DB = 'searchValidatorAttributes';
	const TABLE = 'ValidatedRecord';

	before(() => {
		setupTestDBPath();
		table({
			table: TABLE,
			database: DB,
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'name', indexed: true }, { name: 'details' }],
		});
	});

	function validateConditions(getAttributes) {
		return searchValidator(
			{
				schema: DB,
				table: TABLE,
				get_attributes: getAttributes,
				conditions: [{ attribute: 'name', comparator: 'equals', value: 'a' }],
			},
			'conditions'
		);
	}

	it('accepts known attributes in both the bare and object forms', () => {
		assert.ok(!validateConditions(['id', 'name']));
		assert.ok(!validateConditions(['id', { name: 'details', select: ['city'] }]));
		assert.ok(!validateConditions(['*']));
	});

	it('rejects an unknown attribute in the object form, as it does in the bare form', () => {
		assert.strictEqual(validateConditions(['id', 'missing']).message, "unknown attribute 'missing'");
		assert.strictEqual(
			validateConditions(['id', { name: 'missing', select: ['city'] }]).message,
			"unknown attribute 'missing'"
		);
		assert.strictEqual(
			validateConditions([{ name: 'missing', select: ['city'] }, 'alsoMissing']).message,
			"unknown attribute 'missing and alsoMissing'"
		);
	});

	it('accepts meta attributes in the object form', () => {
		assert.ok(!validateConditions([{ name: '$updatedtime', select: [] }]));
	});
});
