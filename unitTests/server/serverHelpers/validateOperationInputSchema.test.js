const assert = require('node:assert');
const { normalizeOperationInputSchema } = require('#src/server/serverHelpers/validateOperationInputSchema');

describe('operation input schema reference validation', function () {
	it('rejects unresolved local references before publishing metadata', function () {
		const result = normalizeOperationInputSchema({
			type: 'object',
			properties: { value: { $ref: '#/definitions/Missing' } },
		});
		assert.match(result.error, /can't resolve reference/);
		assert.equal(result.schema, undefined);
	});

	it('rejects external references without fetching them', function () {
		const result = normalizeOperationInputSchema({
			type: 'object',
			properties: { value: { $ref: 'https://example.invalid/operation-schema' } },
		});
		assert.match(result.error, /can't resolve reference/);
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

	it('isolates nested schema IDs across registrations and reloads', function () {
		const nestedId = 'https://example.invalid/nested-value';
		for (const type of ['string', 'number']) {
			assert.equal(
				normalizeOperationInputSchema({
					type: 'object',
					definitions: { Value: { $id: nestedId, type } },
					properties: { value: { $ref: nestedId } },
				}).error,
				undefined
			);
			const result = normalizeOperationInputSchema({
				type: 'object',
				properties: { value: { $ref: nestedId } },
			});
			assert.match(result.error, /can't resolve reference/);
		}
	});

	it('loads Ajv from a source ESM entry without require and without format warnings', function () {
		const { spawnSync } = require('node:child_process');
		const { resolve } = require('node:path');
		const { pathToFileURL } = require('node:url');
		const source = pathToFileURL(
			resolve(__dirname, '../../../server/serverHelpers/validateOperationInputSchema.ts')
		).href;
		const result = spawnSync(
			process.execPath,
			[
				'--input-type=module',
				'--eval',
				`
			import assert from 'node:assert';
			import { normalizeOperationInputSchema } from ${JSON.stringify(source)};
			assert.equal(typeof require, 'undefined');
			assert.equal(normalizeOperationInputSchema({
				type: 'object', properties: { value: { type: 'string', format: 'date-time' } },
			}).error, undefined);
		`,
			],
			{ encoding: 'utf8', timeout: 30_000 }
		);
		assert.equal(result.status, 0, result.stderr);
		assert.doesNotMatch(result.stderr, /unknown format/);
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
