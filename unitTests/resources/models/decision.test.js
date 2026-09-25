'use strict';

const assert = require('node:assert');
require('#src/resources/databases');
const {
	validateDecisionSchema,
	allowedValues,
	stateToText,
	normalizeDecision,
	toResponseSchema,
	parseDecisionSample,
	DecisionSchemaError,
	DecisionInputError,
	DecisionContractError,
	MAX_OBJECT_FIELDS,
	MAX_SCHEMA_VALUES,
} = require('#src/resources/models/decision');

const QUEUE = { enum: ['billing', 'refund', 'bug', 'other'] };
const dist = (pairs) => pairs.map(([value, probability]) => ({ value, probability }));

describe('validateDecisionSchema', () => {
	const rejects = (schema, fragment) => {
		assert.throws(
			() => validateDecisionSchema(schema),
			(err) => err instanceof DecisionSchemaError && err.statusCode === 400 && err.message.includes(fragment),
			`expected rejection mentioning "${fragment}" for ${JSON.stringify(schema)}`
		);
	};

	it('accepts an enum leaf, a boolean leaf, a bounded integer leaf, and a one-level object', () => {
		for (const schema of [
			QUEUE,
			{ type: 'boolean' },
			{ type: 'integer', minimum: 1, maximum: 5 },
			{ type: 'object', properties: { queue: QUEUE, urgent: { type: 'boolean' } } },
			{ enum: [1, 'a', true], description: 'mixed' },
		]) {
			assert.doesNotThrow(() => validateDecisionSchema(schema));
		}
	});

	it('rejects non-object schemas', () => {
		rejects(null, 'must be an object');
		rejects('enum', 'must be an object');
		rejects([], 'must be an object');
	});

	it('rejects an enum with fewer than 2 or more than 255 values', () => {
		rejects({ enum: ['one'] }, '2..255');
		rejects({ enum: Array.from({ length: 256 }, (_, i) => i) }, '2..255');
	});

	it('rejects duplicate, non-primitive and non-finite enum values', () => {
		rejects({ enum: ['a', 'a'] }, 'distinct');
		rejects({ enum: ['a', {}] }, 'strings, finite numbers or booleans');
		rejects({ enum: [1, NaN] }, 'strings, finite numbers or booleans');
	});

	it('rejects an integer range with non-integer bounds or a span outside 2..255', () => {
		rejects({ type: 'integer', minimum: 0.5, maximum: 3 }, 'must be integers');
		rejects({ type: 'integer', minimum: 3, maximum: 3 }, '2..255');
		rejects({ type: 'integer', minimum: 0, maximum: 255 }, '2..255');
	});

	it('rejects a leaf with no recognizable shape and a non-string description', () => {
		rejects({ type: 'string' }, 'enum, a boolean, or a bounded integer');
		rejects({ type: 'boolean', description: 3 }, 'description');
	});

	it('rejects object schemas with no properties, unsafe names, nested objects, or too many fields or values', () => {
		rejects({ type: 'object' }, 'properties map');
		rejects({ type: 'object', properties: {} }, 'at least one property');
		rejects({ type: 'object', properties: { ['__proto__']: QUEUE } }, "'__proto__' is not allowed");
		rejects({ type: 'object', properties: { constructor: QUEUE } }, "'constructor' is not allowed");
		rejects(
			{ type: 'object', properties: { inner: { type: 'object', properties: { q: QUEUE } } } },
			"property 'inner' must be an enum"
		);
		const many = Object.fromEntries(
			Array.from({ length: MAX_OBJECT_FIELDS + 1 }, (_, i) => [`f${i}`, { type: 'boolean' }])
		);
		rejects({ type: 'object', properties: many }, `at most ${MAX_OBJECT_FIELDS} properties`);
		const wide = Object.fromEntries(
			Array.from({ length: 3 }, (_, i) => [`f${i}`, { type: 'integer', minimum: 1, maximum: 200 }])
		);
		rejects({ type: 'object', properties: wide }, `at most ${MAX_SCHEMA_VALUES} values`);
	});
});

describe('allowedValues', () => {
	it('returns enum values in declared order, booleans as [false, true], and the integer range', () => {
		assert.deepStrictEqual(allowedValues(QUEUE), ['billing', 'refund', 'bug', 'other']);
		assert.deepStrictEqual(allowedValues({ type: 'boolean' }), [false, true]);
		assert.deepStrictEqual(allowedValues({ type: 'integer', minimum: 2, maximum: 4 }), [2, 3, 4]);
	});
});

describe('stateToText', () => {
	it('passes strings through and serializes objects', () => {
		assert.strictEqual(stateToText('hi'), 'hi');
		assert.strictEqual(stateToText({ a: 1 }), '{"a":1}');
	});

	it('rejects null, primitives and cyclic objects with a 400', () => {
		const cyclic = {};
		cyclic.self = cyclic;
		for (const bad of [null, 3, undefined, cyclic]) {
			assert.throws(
				() => stateToText(bad),
				(err) => err instanceof DecisionInputError && err.statusCode === 400
			);
		}
	});
});

describe('normalizeDecision', () => {
	it('sorts a leaf distribution descending, keeping schema order on ties, and derives value + probability', () => {
		const output = {
			distribution: dist([
				['billing', 0.2],
				['refund', 0.4],
				['bug', 0.4],
				['other', 0],
			]),
		};
		const d = normalizeDecision(QUEUE, output, 'b', false);
		assert.strictEqual(d.value, 'refund');
		assert.strictEqual(d.probability, 0.4);
		assert.deepStrictEqual(
			d.distribution.map((e) => e.value),
			['refund', 'bug', 'billing', 'other']
		);
		assert.strictEqual(d.calibrated, false);
	});

	it('honors a backend-supplied value when it is a most-probable outcome, and rejects one that is not', () => {
		const distribution = dist([
			['billing', 0.5],
			['refund', 0.5],
			['bug', 0],
			['other', 0],
		]);
		assert.strictEqual(normalizeDecision(QUEUE, { distribution, value: 'refund' }, 'b', false).value, 'refund');
		assert.throws(() => normalizeDecision(QUEUE, { distribution, value: 'bug' }, 'b', false), DecisionContractError);
	});

	it('takes calibrated from the output, else from the backend capability', () => {
		const distribution = dist([
			['billing', 1],
			['refund', 0],
			['bug', 0],
			['other', 0],
		]);
		assert.strictEqual(normalizeDecision(QUEUE, { distribution }, 'b', true).calibrated, true);
		assert.strictEqual(normalizeDecision(QUEUE, { distribution, calibrated: false }, 'b', true).calibrated, false);
	});

	it('rejects a missing, incomplete, duplicated, out-of-set, out-of-range or non-normalized distribution', () => {
		const cases = [
			[{ value: 'billing' }, 'distribution is required'],
			[{ distribution: 'nope' }, 'distribution is required'],
			[{ distribution: dist([['billing', 1]]) }, 'one entry per allowed value'],
			[
				{
					distribution: dist([
						['billing', 0.5],
						['billing', 0.5],
						['bug', 0],
						['other', 0],
					]),
				},
				'duplicate',
			],
			[
				{
					distribution: dist([
						['billing', 1],
						['refund', 0],
						['bug', 0],
						['nope', 0],
					]),
				},
				'not an allowed value',
			],
			[
				{
					distribution: dist([
						['billing', 1.5],
						['refund', -0.5],
						['bug', 0],
						['other', 0],
					]),
				},
				'[0, 1]',
			],
			[
				{
					distribution: dist([
						['billing', 0.9],
						['refund', 0.9],
						['bug', 0],
						['other', 0],
					]),
				},
				'sum to',
			],
			[null, 'must be an object'],
		];
		for (const [output, fragment] of cases) {
			assert.throws(
				() => normalizeDecision(QUEUE, output, 'b', false),
				(err) => err instanceof DecisionContractError && err.message.includes(fragment),
				fragment
			);
		}
	});

	it('assembles object values from per-field marginals and rejects missing or unexpected fields', () => {
		const schema = { type: 'object', properties: { queue: QUEUE, urgent: { type: 'boolean' } } };
		const fields = {
			queue: {
				distribution: dist([
					['billing', 0.1],
					['refund', 0.7],
					['bug', 0.2],
					['other', 0],
				]),
			},
			urgent: {
				distribution: dist([
					[false, 0.3],
					[true, 0.7],
				]),
			},
		};
		const d = normalizeDecision(schema, { fields }, 'b', false);
		assert.deepStrictEqual(d.value, { queue: 'refund', urgent: true });
		assert.strictEqual(d.probability, undefined);
		assert.strictEqual(d.distribution, undefined);
		assert.strictEqual(d.fields.urgent.probability, 0.7);
		assert.deepStrictEqual(d.fields.queue.distribution[0], { value: 'refund', probability: 0.7 });
		assert.throws(
			() => normalizeDecision(schema, { fields: { queue: fields.queue } }, 'b', false),
			/missing field 'urgent'/
		);
		assert.throws(
			() => normalizeDecision(schema, { fields: { ...fields, extra: fields.urgent } }, 'b', false),
			/unexpected field 'extra'/
		);
		assert.throws(() => normalizeDecision(schema, { distribution: [] }, 'b', false), /fields map/);
	});
});

describe('toResponseSchema', () => {
	it('wraps a leaf as a strict object with `value`, typed enums, and integer ranges as enums', () => {
		assert.deepStrictEqual(toResponseSchema(QUEUE), {
			type: 'object',
			properties: { value: { type: 'string', enum: ['billing', 'refund', 'bug', 'other'] } },
			required: ['value'],
			additionalProperties: false,
		});
		assert.deepStrictEqual(toResponseSchema({ type: 'boolean', description: 'urgent?' }), {
			type: 'object',
			properties: { value: { type: 'boolean', description: 'urgent?' } },
			required: ['value'],
			additionalProperties: false,
		});
		assert.deepStrictEqual(toResponseSchema({ type: 'integer', minimum: 1, maximum: 3 }).properties.value, {
			type: 'integer',
			enum: [1, 2, 3],
		});
		assert.deepStrictEqual(toResponseSchema({ enum: [1, 'a'] }).properties.value, { enum: [1, 'a'] });
	});

	it('emits every object property as required with no additional properties', () => {
		const out = toResponseSchema({
			type: 'object',
			description: 'route',
			properties: { queue: QUEUE, urgent: { type: 'boolean' } },
		});
		assert.deepStrictEqual(out.required, ['queue', 'urgent']);
		assert.strictEqual(out.additionalProperties, false);
		assert.strictEqual(out.description, 'route');
		assert.deepStrictEqual(out.properties.urgent, { type: 'boolean' });
	});
});

describe('parseDecisionSample', () => {
	it('returns the leaf value or the per-field map for in-schema samples', () => {
		assert.strictEqual(parseDecisionSample(QUEUE, '{"value":"bug"}'), 'bug');
		assert.strictEqual(parseDecisionSample({ type: 'integer', minimum: 1, maximum: 3 }, '{"value":2}'), 2);
		assert.deepStrictEqual(
			parseDecisionSample(
				{ type: 'object', properties: { queue: QUEUE, urgent: { type: 'boolean' } } },
				'{"queue":"refund","urgent":false,"extra":1}'
			),
			{ queue: 'refund', urgent: false }
		);
	});

	it('rejects non-JSON, non-object, missing, out-of-set and mistyped samples', () => {
		assert.throws(() => parseDecisionSample(QUEUE, 'bug'), /not valid JSON/);
		assert.throws(() => parseDecisionSample(QUEUE, '["bug"]'), /not a JSON object/);
		assert.throws(() => parseDecisionSample(QUEUE, '{}'), /'value' is undefined/);
		assert.throws(() => parseDecisionSample(QUEUE, '{"value":"spam"}'), /not an allowed value/);
		assert.throws(
			() => parseDecisionSample({ type: 'integer', minimum: 1, maximum: 3 }, '{"value":"2"}'),
			/not an allowed value/
		);
		assert.throws(
			() => parseDecisionSample({ type: 'object', properties: { queue: QUEUE } }, '{"other":1}'),
			/has no 'queue'/
		);
	});
});
