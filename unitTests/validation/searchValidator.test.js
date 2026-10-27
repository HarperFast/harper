'use strict';

const testUtils = require('../testUtils.js');
testUtils.preTestPrep();

const assert = require('node:assert');
const searchValidator = require('#src/validation/searchValidator').default;
const { getDatabases } = require('#src/resources/databases');

/**
 *  Unit tests for validation/searchValidator.ts
 */
describe('Test searchValidator module', () => {
	before(() => {
		getDatabases().searchValidatorTest = {
			child: childTable,
			grandchild: grandchildTable,
			test: {
				attributes: [
					{ attribute: 'id', name: 'id' },
					{ attribute: 'name', name: 'name' },
					{ attribute: 'metadata', name: 'metadata', type: 'Any' },
					{
						attribute: 'child',
						name: 'child',
						relationship: { from: 'childId' },
						definition: { tableClass: childTable },
					},
					{
						attribute: 'children',
						name: 'children',
						relationship: { to: 'parentId' },
						elements: { type: 'Child', definition: { tableClass: childTable } },
					},
					{
						attribute: 'parent',
						name: 'parent',
						relationship: { from: 'parentId' },
						get definition() {
							return { tableClass: getDatabases().searchValidatorTest.test };
						},
					},
				],
			},
		};
	});

	const grandchildTable = class GrandchildTable {
		static attributes = [
			{ attribute: 'id', name: 'id' },
			{ attribute: 'code', name: 'code' },
		];
	};

	const childTable = class ChildTable {
		static attributes = [
			{ attribute: 'id', name: 'id' },
			{ attribute: 'label', name: 'label' },
			{
				attribute: 'grandchild',
				name: 'grandchild',
				relationship: { from: 'grandchildId' },
				definition: { tableClass: grandchildTable },
			},
		];
	};

	after(() => {
		delete getDatabases().searchValidatorTest;
	});

	it('names an unknown attribute once when search_by_value names it as both the search attribute and a get_attributes entry', () => {
		const result = searchValidator(
			{
				schema: 'searchValidatorTest',
				table: 'test',
				attribute: 'bogus',
				value: 'x',
				get_attributes: ['bogus'],
			},
			'value'
		);

		assert.ok(result instanceof Error);
		assert.strictEqual(result.message, "unknown attribute 'bogus'");
	});

	it('names an unknown attribute once when search_by_conditions names it as both a get_attributes entry and a condition', () => {
		const result = searchValidator(
			{
				schema: 'searchValidatorTest',
				table: 'test',
				operator: 'and',
				get_attributes: ['bogus'],
				conditions: [{ attribute: 'bogus', comparator: 'equals', value: 'x' }],
			},
			'conditions'
		);

		assert.ok(result instanceof Error);
		assert.strictEqual(result.message, "unknown attribute 'bogus'");
	});

	it('names an unknown attribute once when two conditions both name it', () => {
		const result = searchValidator(
			{
				schema: 'searchValidatorTest',
				table: 'test',
				operator: 'or',
				conditions: [
					{ attribute: 'bogus', comparator: 'equals', value: 'x' },
					{ attribute: 'bogus', comparator: 'equals', value: 'y' },
				],
			},
			'conditions'
		);

		assert.ok(result instanceof Error);
		assert.strictEqual(result.message, "unknown attribute 'bogus'");
	});

	it('dedupes two structurally-equal but distinct unknown object attribute specifiers', () => {
		const result = searchValidator(
			{
				schema: 'searchValidatorTest',
				table: 'test',
				attribute: 'id',
				value: 'x',
				get_attributes: [
					{ attribute: 'bogus', as: 'alias' },
					{ attribute: 'bogus', as: 'alias' },
				],
			},
			'value'
		);

		assert.ok(result instanceof Error);
		assert.match(result.message, /^unknown attribute '[^,]+'$/);
		assert.ok(!result.message.includes(' and '));
	});

	it('does not merge a string attribute name with an unrelated object specifier that stringifies to the same text', () => {
		const objectEntry = { attribute: 'bogus' };
		const result = searchValidator(
			{
				schema: 'searchValidatorTest',
				table: 'test',
				attribute: 'id',
				value: 'x',
				get_attributes: [JSON.stringify(objectEntry), objectEntry],
			},
			'value'
		);

		assert.ok(result instanceof Error);
		assert.ok(result.message.includes(' and '));
	});

	it('converts a BigInt-valued property instead of throwing (e.g. from a msgpack/cbor body)', () => {
		const result = searchValidator(
			{
				schema: 'searchValidatorTest',
				table: 'test',
				attribute: 'id',
				value: 'x',
				get_attributes: [{ attribute: 'bogus', n: 1n }],
			},
			'value'
		);

		assert.ok(result instanceof Error);
		assert.match(result.message, /^unknown attribute '/);
	});

	it('does not throw when an unknown object attribute specifier cannot be serialized at all (e.g. is circular)', () => {
		const circular = { attribute: 'bogus' };
		circular.self = circular;
		const result = searchValidator(
			{
				schema: 'searchValidatorTest',
				table: 'test',
				attribute: 'id',
				value: 'x',
				get_attributes: [circular],
			},
			'value'
		);

		assert.ok(result instanceof Error);
		assert.match(result.message, /^unknown attribute '/);
	});

	it('still lists multiple distinct unknown attributes', () => {
		const result = searchValidator(
			{
				schema: 'searchValidatorTest',
				table: 'test',
				attribute: 'bogus1',
				value: 'x',
				get_attributes: ['bogus2'],
			},
			'value'
		);

		assert.ok(result instanceof Error);
		assert.strictEqual(result.message, "unknown attribute 'bogus2 and bogus1'");
	});

	it('passes when all attributes are known', () => {
		const result = searchValidator(
			{
				schema: 'searchValidatorTest',
				table: 'test',
				attribute: 'id',
				value: 'x',
				get_attributes: ['name'],
			},
			'value'
		);

		assert.strictEqual(result, undefined);
	});

	it('allows valid { name, select } and { name } get_attributes entries in hashes, value, and conditions (#3136)', () => {
		const get_attributes = [
			'id',
			{ name: 'child', select: ['id', 'label', { name: 'grandchild', select: ['id', 'code'] }] },
			{ name: 'children', offset: 0, limit: 1, select: ['id', 'label'] },
			{ name: 'child' },
		];
		assert.strictEqual(
			searchValidator(
				{
					schema: 'searchValidatorTest',
					table: 'test',
					hash_values: ['1'],
					get_attributes,
				},
				'hashes'
			),
			null
		);
		assert.strictEqual(
			searchValidator(
				{
					schema: 'searchValidatorTest',
					table: 'test',
					attribute: 'id',
					value: '1',
					get_attributes,
				},
				'value'
			),
			undefined
		);
		assert.strictEqual(
			searchValidator(
				{
					schema: 'searchValidatorTest',
					table: 'test',
					conditions: [{ attribute: 'id', comparator: 'equals', value: '1' }],
					get_attributes,
				},
				'conditions'
			),
			undefined
		);
	});

	it('rejects unknown top-level { name, select } and { name } entries across hashes, value, and conditions', () => {
		for (const [type, base] of [
			['hashes', { schema: 'searchValidatorTest', table: 'test', hash_values: ['1'] }],
			['value', { schema: 'searchValidatorTest', table: 'test', attribute: 'id', value: '1' }],
			[
				'conditions',
				{
					schema: 'searchValidatorTest',
					table: 'test',
					conditions: [{ attribute: 'id', comparator: 'equals', value: '1' }],
				},
			],
		]) {
			const err1 = searchValidator({ ...base, get_attributes: ['id', { name: 'unknownRel', select: ['id'] }] }, type);
			assert.ok(err1 instanceof Error, `expected error for ${type}`);
			assert.strictEqual(err1.statusCode, 400);
			assert.strictEqual(err1.message, "unknown attribute 'unknownRel'");

			const err2 = searchValidator({ ...base, get_attributes: ['id', { name: 'unknownTopAttr' }] }, type);
			assert.ok(err2 instanceof Error, `expected error for ${type}`);
			assert.strictEqual(err2.statusCode, 400);
			assert.strictEqual(err2.message, "unknown attribute 'unknownTopAttr'");
		}
	});

	it('recursively rejects unknown nested attributes on both from: and to: relationships across hashes, value, and conditions', () => {
		for (const [type, base] of [
			['hashes', { schema: 'searchValidatorTest', table: 'test', hash_values: ['1'] }],
			['value', { schema: 'searchValidatorTest', table: 'test', attribute: 'id', value: '1' }],
			[
				'conditions',
				{
					schema: 'searchValidatorTest',
					table: 'test',
					conditions: [{ attribute: 'id', comparator: 'equals', value: '1' }],
				},
			],
		]) {
			const fromErr = searchValidator(
				{ ...base, get_attributes: ['id', { name: 'child', select: ['id', 'unknownChildAttr'] }] },
				type
			);
			assert.ok(fromErr instanceof Error, `expected from: error for ${type}`);
			assert.strictEqual(fromErr.statusCode, 400);
			assert.strictEqual(fromErr.message, "unknown attribute 'unknownChildAttr'");

			const toErr = searchValidator(
				{ ...base, get_attributes: ['id', { name: 'children', select: ['id', 'unknownChildAttr'] }] },
				type
			);
			assert.ok(toErr instanceof Error, `expected to: error for ${type}`);
			assert.strictEqual(toErr.statusCode, 400);
			assert.strictEqual(toErr.message, "unknown attribute 'unknownChildAttr'");

			const deepErr = searchValidator(
				{
					...base,
					get_attributes: [
						'id',
						{ name: 'child', select: [{ name: 'grandchild', select: ['id', 'unknownGrandchildAttr'] }] },
					],
				},
				type
			);
			assert.ok(deepErr instanceof Error, `expected deep error for ${type}`);
			assert.strictEqual(deepErr.statusCode, 400);
			assert.strictEqual(deepErr.message, "unknown attribute 'unknownGrandchildAttr'");
		}
	});

	it('handles self-referential relationships and non-relationship JSON attributes without false positives', () => {
		assert.strictEqual(
			searchValidator(
				{
					schema: 'searchValidatorTest',
					table: 'test',
					hash_values: ['1'],
					get_attributes: [
						'id',
						{ name: 'parent', select: ['id', { name: 'parent', select: ['id', 'name'] }] },
						{ name: 'metadata', select: ['nestedKey', { name: 'deep', select: ['leaf'] }] },
					],
				},
				'hashes'
			),
			null
		);

		const selfErr = searchValidator(
			{
				schema: 'searchValidatorTest',
				table: 'test',
				hash_values: ['1'],
				get_attributes: ['id', { name: 'parent', select: ['id', { name: 'parent', select: ['bogusSelfAttr'] }] }],
			},
			'hashes'
		);
		assert.ok(selfErr instanceof Error);
		assert.strictEqual(selfErr.statusCode, 400);
		assert.strictEqual(selfErr.message, "unknown attribute 'bogusSelfAttr'");
	});

	it('rejects conditions in object get_attributes, non-array select, reused invalid sub-selectors across schemas, and excessive select depth', () => {
		const condErr = searchValidator(
			{
				schema: 'searchValidatorTest',
				table: 'test',
				hash_values: ['1'],
				get_attributes: [
					'id',
					{
						name: 'children',
						conditions: [{ attribute: 'label', comparator: 'equals', value: 'x' }],
						select: ['id'],
					},
				],
			},
			'hashes'
		);
		assert.ok(condErr instanceof Error);
		assert.strictEqual(condErr.statusCode, 400);
		assert.strictEqual(condErr.message, "unknown attribute 'children (conditions are not allowed in get_attributes)'");

		const invalidSelectErr = searchValidator(
			{
				schema: 'searchValidatorTest',
				table: 'test',
				hash_values: ['1'],
				get_attributes: ['id', { name: 'child', select: 123 }],
			},
			'hashes'
		);
		assert.ok(invalidSelectErr instanceof Error);
		assert.strictEqual(invalidSelectErr.statusCode, 400);
		assert.strictEqual(invalidSelectErr.message, "unknown attribute 'child (invalid select)'");

		const invalidOffsetErr = searchValidator(
			{
				schema: 'searchValidatorTest',
				table: 'test',
				hash_values: ['1'],
				get_attributes: ['id', { name: 'children', offset: '1', limit: 1, select: ['id'] }],
			},
			'hashes'
		);
		assert.ok(invalidOffsetErr instanceof Error);
		assert.strictEqual(invalidOffsetErr.statusCode, 400);
		assert.strictEqual(invalidOffsetErr.message, "unknown attribute 'children (invalid offset)'");

		const invalidLimitErr = searchValidator(
			{
				schema: 'searchValidatorTest',
				table: 'test',
				hash_values: ['1'],
				get_attributes: ['id', { name: 'children', limit: -1, select: ['id'] }],
			},
			'hashes'
		);
		assert.ok(invalidLimitErr instanceof Error);
		assert.strictEqual(invalidLimitErr.statusCode, 400);
		assert.strictEqual(invalidLimitErr.message, "unknown attribute 'children (invalid limit)'");

		const sharedLeafSelector = { name: 'label' };
		const reusedSelectorErr = searchValidator(
			{
				schema: 'searchValidatorTest',
				table: 'test',
				hash_values: ['1'],
				get_attributes: [
					'id',
					{
						name: 'child',
						select: [sharedLeafSelector, { name: 'grandchild', select: [sharedLeafSelector] }],
					},
				],
			},
			'hashes'
		);
		assert.ok(reusedSelectorErr instanceof Error);
		assert.strictEqual(reusedSelectorErr.statusCode, 400);
		assert.strictEqual(reusedSelectorErr.message, "unknown attribute 'label'");

		let deepSelect = ['id'];
		for (let i = 0; i < 70; i++) {
			deepSelect = [{ name: 'parent', select: deepSelect }];
		}
		const depthErr = searchValidator(
			{
				schema: 'searchValidatorTest',
				table: 'test',
				hash_values: ['1'],
				get_attributes: deepSelect,
			},
			'hashes'
		);
		assert.ok(depthErr instanceof Error);
		assert.strictEqual(depthErr.statusCode, 400);
		assert.strictEqual(depthErr.message, "unknown attribute 'parent (select depth exceeded)'");
	});

	it('rejects malformed object selectors without throwing TypeError or bypassing catalog checks', () => {
		for (const badObject of [
			{ attribute: '*' },
			{ name: 'unknownRel', attribute: '*', select: ['id'] },
			{ attribute: 'child', limit: -1 },
			{ startsWith: 'x' },
			{ toString: 'x' },
			{},
		]) {
			const err = searchValidator(
				{
					schema: 'searchValidatorTest',
					table: 'test',
					hash_values: ['1'],
					get_attributes: ['id', badObject],
				},
				'hashes'
			);
			assert.ok(err instanceof Error, `expected error for ${JSON.stringify(badObject)}`);
			assert.strictEqual(err.statusCode, 400);
			assert.match(err.message, /^unknown attribute '/);
		}
	});

	it('allows null value in search_by_value and rejects array value such as ["*"]', () => {
		assert.strictEqual(
			searchValidator(
				{
					schema: 'searchValidatorTest',
					table: 'test',
					attribute: 'name',
					value: null,
					get_attributes: ['id', 'name'],
				},
				'value'
			),
			undefined
		);

		const err = searchValidator(
			{
				schema: 'searchValidatorTest',
				table: 'test',
				attribute: 'name',
				value: ['*'],
				get_attributes: ['id', 'name'],
			},
			'value'
		);
		assert.ok(err instanceof Error);
		assert.strictEqual(err.message, "'value' must be one of [string, number, boolean, null]");
	});
});
