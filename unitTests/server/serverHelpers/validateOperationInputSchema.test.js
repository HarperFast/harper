const assert = require('node:assert');
const { normalizeOperationInputSchema } = require('#src/server/serverHelpers/validateOperationInputSchema');

describe('operation input schema reference validation', function () {
	it('rejects unresolved local references before publishing metadata', function () {
		const result = normalizeOperationInputSchema({
			type: 'object',
			properties: { value: { $ref: '#/definitions/Missing' } },
		});
		assert.ok(result.error, 'an unresolved reference must not be advertised');
		assert.equal(result.schema, undefined);
	});

	it('rejects external references without fetching them', function () {
		const result = normalizeOperationInputSchema({
			type: 'object',
			properties: { value: { $ref: 'https://example.invalid/operation-schema' } },
		});
		assert.ok(result.error, 'clients must not need an unavailable external schema');
		assert.equal(result.schema, undefined);
	});

	it('does not resolve references against another operation registration', function () {
		assert.equal(
			normalizeOperationInputSchema({
				$id: 'https://example.invalid/other-operation',
				type: 'object',
			}).error,
			undefined
		);
		const result = normalizeOperationInputSchema({
			type: 'object',
			properties: { value: { $ref: 'https://example.invalid/other-operation' } },
		});
		assert.ok(result.error);
		assert.equal(result.schema, undefined);
	});

	it('accepts self-contained references for supported dialects', function () {
		for (const $schema of [
			'http://json-schema.org/draft-06/schema#',
			'http://json-schema.org/draft-07/schema#',
			'https://json-schema.org/draft/2019-09/schema',
			'https://json-schema.org/draft/2020-12/schema',
		]) {
			const inputSchema = {
				$schema,
				$id: 'https://example.invalid/reusable-operation-id',
				type: 'object',
				definitions: { Value: { type: 'string' } },
				properties: { value: { $ref: '#/definitions/Value' } },
			};
			assert.equal(normalizeOperationInputSchema(inputSchema).error, undefined);
			assert.equal(normalizeOperationInputSchema(inputSchema).error, undefined, 're-registration is isolated');
		}
	});
});
