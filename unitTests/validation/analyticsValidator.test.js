'use strict';

const assert = require('node:assert/strict');
const { validateGetAnalytics } = require('#src/validation/analyticsValidator');

describe('validateGetAnalytics', function () {
	// ── Happy paths ──────────────────────────────────────────────────────────

	it('should accept a minimal valid request (metric only)', function () {
		assert.strictEqual(validateGetAnalytics({ metric: 'cpu-usage' }), undefined);
	});

	it('should accept a fully-specified valid request', function () {
		assert.strictEqual(
			validateGetAnalytics({
				operation: 'get_analytics',
				metric: 'cpu-usage',
				start_time: 1779834663816,
				end_time: 1779834763816,
				get_attributes: ['value', 'node'],
				coalesce_time: true,
				conditions: [{ attribute: 'path', comparator: 'equals', value: '/api/test' }],
			}),
			undefined
		);
	});

	it('should allow extra fields (operation, hdb_user, etc.) via allowUnknown', function () {
		assert.strictEqual(
			validateGetAnalytics({ operation: 'get_analytics', metric: 'cpu-usage', hdb_user: { username: 'admin' } }),
			undefined
		);
	});

	it('should accept legacy condition field names (search_attribute / search_type / search_value)', function () {
		assert.strictEqual(
			validateGetAnalytics({
				metric: 'cpu-usage',
				conditions: [{ search_attribute: 'path', search_type: 'equals', search_value: '/api/test' }],
			}),
			undefined
		);
	});

	it('should accept a group condition with nested conditions array', function () {
		assert.strictEqual(
			validateGetAnalytics({
				metric: 'cpu-usage',
				conditions: [
					{
						operator: 'or',
						conditions: [
							{ attribute: 'method', comparator: 'equals', value: 'GET' },
							{ attribute: 'method', comparator: 'equals', value: 'POST' },
						],
					},
				],
			}),
			undefined
		);
	});

	// ── metric field ─────────────────────────────────────────────────────────

	it('should reject a request with no metric', function () {
		const error = validateGetAnalytics({ operation: 'get_analytics' });
		assert.ok(error instanceof Error);
		assert.ok(error.message.includes('metric'), `expected "metric" in: ${error.message}`);
	});

	it('should reject a non-string metric', function () {
		const error = validateGetAnalytics({ metric: 42 });
		assert.ok(error instanceof Error);
		assert.ok(error.message.includes('metric'), `expected "metric" in: ${error.message}`);
	});

	// ── start_time / end_time ────────────────────────────────────────────────

	it('should reject start_time as a numeric string', function () {
		const error = validateGetAnalytics({ metric: 'cpu-usage', start_time: '1779834663816' });
		assert.ok(error instanceof Error);
		assert.ok(error.message.includes('start_time'), `expected "start_time" in: ${error.message}`);
	});

	it('should reject end_time as a non-numeric string', function () {
		const error = validateGetAnalytics({ metric: 'cpu-usage', end_time: 'tomorrow' });
		assert.ok(error instanceof Error);
		assert.ok(error.message.includes('end_time'), `expected "end_time" in: ${error.message}`);
	});

	it('should accept start_time and end_time as numbers', function () {
		assert.strictEqual(
			validateGetAnalytics({ metric: 'cpu-usage', start_time: 1779834663816, end_time: 1779834763816 }),
			undefined
		);
	});

	it('should reject a zero start_time', function () {
		const error = validateGetAnalytics({ metric: 'cpu-usage', start_time: 0 });
		assert.ok(error instanceof Error);
		assert.ok(error.message.includes('start_time'), `expected "start_time" in: ${error.message}`);
	});

	it('should reject a negative end_time', function () {
		const error = validateGetAnalytics({ metric: 'cpu-usage', end_time: -1 });
		assert.ok(error instanceof Error);
		assert.ok(error.message.includes('end_time'), `expected "end_time" in: ${error.message}`);
	});

	// ── get_attributes ───────────────────────────────────────────────────────

	it('should reject get_attributes as a plain string instead of an array', function () {
		const error = validateGetAnalytics({ metric: 'cpu-usage', get_attributes: 'value' });
		assert.ok(error instanceof Error);
		assert.ok(error.message.includes('get_attributes'), `expected "get_attributes" in: ${error.message}`);
	});

	it('should accept get_attributes as an array of strings', function () {
		assert.strictEqual(
			validateGetAnalytics({ metric: 'cpu-usage', get_attributes: ['value', 'node', 'count'] }),
			undefined
		);
	});

	// ── coalesce_time ────────────────────────────────────────────────────────

	it('should reject coalesce_time as the string "true"', function () {
		const error = validateGetAnalytics({ metric: 'cpu-usage', coalesce_time: 'true' });
		assert.ok(error instanceof Error);
		assert.ok(error.message.includes('coalesce_time'), `expected "coalesce_time" in: ${error.message}`);
	});

	it('should reject coalesce_time as the number 1', function () {
		const error = validateGetAnalytics({ metric: 'cpu-usage', coalesce_time: 1 });
		assert.ok(error instanceof Error);
		assert.ok(error.message.includes('coalesce_time'), `expected "coalesce_time" in: ${error.message}`);
	});

	it('should accept coalesce_time as false', function () {
		assert.strictEqual(validateGetAnalytics({ metric: 'cpu-usage', coalesce_time: false }), undefined);
	});

	// ── conditions ───────────────────────────────────────────────────────────

	it('should reject conditions as a plain object instead of an array', function () {
		const error = validateGetAnalytics({
			metric: 'cpu-usage',
			conditions: { attribute: 'path', comparator: 'equals', value: '/api' },
		});
		assert.ok(error instanceof Error);
		assert.ok(error.message.includes('conditions'), `expected "conditions" in: ${error.message}`);
	});

	it('should accept an empty conditions array', function () {
		assert.strictEqual(validateGetAnalytics({ metric: 'cpu-usage', conditions: [] }), undefined);
	});

	it('should reject a condition with an invalid comparator', function () {
		const error = validateGetAnalytics({
			metric: 'cpu-usage',
			conditions: [{ attribute: 'path', comparator: 'not_a_real_op', value: '/api' }],
		});
		assert.ok(error instanceof Error);
		// Joi.alternatives() surfaces a top-level "doesn't match any type" error rather than
		// the sub-schema field error, so we assert on the array path rather than the field name.
		assert.ok(error.message.includes('conditions'), `expected "conditions" in: ${error.message}`);
	});

	it('should reject a direct condition with no attribute, comparator, or value', function () {
		const error = validateGetAnalytics({ metric: 'cpu-usage', conditions: [{}] });
		assert.ok(error instanceof Error);
	});

	it('should reject a condition with attribute but no comparator or value', function () {
		const error = validateGetAnalytics({ metric: 'cpu-usage', conditions: [{ attribute: 'path' }] });
		assert.ok(error instanceof Error);
	});
});
