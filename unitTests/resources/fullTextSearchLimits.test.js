const assert = require('node:assert');
const { resolve } = require('node:path');
const {
	resolveFullTextSearchLimits,
	DEFAULT_FULL_TEXT_SEARCH_LIMITS,
} = require('#src/resources/indexes/fullTextSearchLimits');

describe('full-text request work limits', () => {
	it('uses the documented default and accepts positive integer overrides', () => {
		assert.deepStrictEqual(resolveFullTextSearchLimits(undefined), DEFAULT_FULL_TEXT_SEARCH_LIMITS);
		assert.deepStrictEqual(resolveFullTextSearchLimits({ maxRawHitsPerRequest: '200000' }), {
			maxRawHitsPerRequest: 200000,
		});
	});
	it('rejects invalid shapes, misspelled keys and unbounded budgets', () => {
		for (const value of [null, [], true, 'settings', new Date(), Object.create({ maxRawHitsPerRequest: 2 })])
			assert.throws(() => resolveFullTextSearchLimits(value));
		for (const value of [null, 0, -1, 1.5, Infinity, NaN, '', '1.5', '1e3', true, Number.MAX_SAFE_INTEGER + 1])
			assert.throws(() => resolveFullTextSearchLimits({ maxRawHitsPerRequest: value }), /positive safe integer/);
		assert.throws(() => resolveFullTextSearchLimits({ maxRawHitPerRequest: 2 }), /Unknown/);
		assert.throws(() => resolveFullTextSearchLimits({ constructor: 2 }), /Unknown/);
	});
	it('validates through Harper root config and agrees with shipped YAML and schema defaults', () => {
		const { configValidator } = require('#src/validation/configValidator');
		const errors = (fullText) =>
			(
				configValidator({ rootPath: resolve(__dirname, '../..'), storage: { writeAsync: false, fullText } }, true).error
					?.details ?? []
			).filter(({ path }) => path[0] === 'storage' && path[1] === 'fullText');
		assert.deepStrictEqual(errors({ maxRawHitsPerRequest: 200000 }), []);
		assert(errors({ maxRawHitsPerRequest: 0 }).length > 0);
		const { readFileSync } = require('node:fs');
		const { parse } = require('yaml');
		assert.deepStrictEqual(
			parse(readFileSync(resolve(__dirname, '../../static/defaultConfig.yaml'), 'utf8')).storage.fullText,
			DEFAULT_FULL_TEXT_SEARCH_LIMITS
		);
		const schema = JSON.parse(readFileSync(resolve(__dirname, '../../config-root.schema.json'), 'utf8'));
		assert.strictEqual(
			schema.properties.storage.properties.fullText.properties.maxRawHitsPerRequest.default,
			DEFAULT_FULL_TEXT_SEARCH_LIMITS.maxRawHitsPerRequest
		);
	});
});
