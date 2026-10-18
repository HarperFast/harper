const assert = require('node:assert');
const {
	DEFAULT_FULL_TEXT_SEARCH_LIMITS,
	resolveFullTextSearchLimits,
} = require('#src/resources/indexes/fullTextSearchLimits');

describe('full-text search resource limits', () => {
	it('resolves missing settings without changing the defaults', () => {
		assert.deepStrictEqual(resolveFullTextSearchLimits(undefined), DEFAULT_FULL_TEXT_SEARCH_LIMITS);
		assert(Object.isFrozen(DEFAULT_FULL_TEXT_SEARCH_LIMITS.runtime));
	});

	it('accepts integer strings and independently merges the native process budget', () => {
		const limits = resolveFullTextSearchLimits({ maxCursors: '7', runtime: { maxResidentIndexes: '256' } });
		assert.strictEqual(limits.maxCursors, 7);
		assert.strictEqual(limits.cursorTtlMilliseconds, DEFAULT_FULL_TEXT_SEARCH_LIMITS.cursorTtlMilliseconds);
		assert.strictEqual(limits.runtime.maxResidentIndexes, 256);
		assert.strictEqual(limits.runtime.maxSearchThreads, DEFAULT_FULL_TEXT_SEARCH_LIMITS.runtime.maxSearchThreads);
	});

	it('rejects invalid full-text settings through the actual root configuration validator', () => {
		const { configValidator } = require('#src/validation/configValidator');
		const errors = (fullText) =>
			(
				configValidator(
					{ rootPath: require('node:path').resolve(__dirname, '../..'), storage: { writeAsync: false, fullText } },
					true
				).error?.details ?? []
			).filter(({ path }) => path[0] === 'storage' && path[1] === 'fullText');
		assert.deepStrictEqual(errors({ maxCursors: 7, runtime: { maxResidentIndexes: 256 } }), []);
		for (const value of [
			{ maxCursors: 0 },
			{ maxCursor: 4 },
			{ runtime: { maxSearchThreads: null } },
			{ cursorTtlMilliseconds: 0x80000000 },
		])
			assert(errors(value).length > 0, JSON.stringify(value));
	});

	it('keeps the shipped YAML defaults and schema defaults consistent with the resolver', () => {
		const { readFileSync } = require('node:fs');
		const { resolve } = require('node:path');
		const { parse } = require('yaml');
		const root = resolve(__dirname, '../..');
		const yaml = parse(readFileSync(resolve(root, 'static/defaultConfig.yaml'), 'utf8'));
		assert.deepStrictEqual(yaml.storage.fullText, DEFAULT_FULL_TEXT_SEARCH_LIMITS);
		const schema = JSON.parse(readFileSync(resolve(root, 'config-root.schema.json'), 'utf8'));
		const policy = schema.properties.storage.properties.fullText;
		assert.strictEqual(policy.additionalProperties, false);
		assert.strictEqual(policy.properties.runtime.additionalProperties, false);
		for (const [name, value] of Object.entries(DEFAULT_FULL_TEXT_SEARCH_LIMITS)) {
			if (name === 'runtime') {
				for (const [key, limit] of Object.entries(value))
					assert.strictEqual(policy.properties.runtime.properties[key].default, limit);
			} else assert.strictEqual(policy.properties[name].default, value);
		}
	});

	it('rejects missing-shape, unknown and unbounded policy values', () => {
		for (const value of [null, [], true, 'settings', new Date(), Object.create({ maxCursors: 7 })])
			assert.throws(() => resolveFullTextSearchLimits(value));
		for (const value of [null, 0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '', '1.5', '1e3', true]) {
			assert.throws(() => resolveFullTextSearchLimits({ maxCursors: value }), /positive safe integer/);
			assert.throws(() => resolveFullTextSearchLimits({ maxRawHitsPerRequest: value }), /positive safe integer/);
			assert.throws(
				() => resolveFullTextSearchLimits({ runtime: { maxSearchThreads: value } }),
				/positive safe integer/
			);
		}
		assert.throws(() => resolveFullTextSearchLimits({ maxCursor: 4 }), /Unknown/);
		assert.throws(() => resolveFullTextSearchLimits({ runtime: { threads: 4 } }), /Unknown/);
		assert.throws(() => resolveFullTextSearchLimits({ constructor: 4 }), /Unknown/);
		assert.throws(() => resolveFullTextSearchLimits({ maxCursors: 0x100000000 }), /u32/);
		assert.throws(() => resolveFullTextSearchLimits({ cursorTtlMilliseconds: 0x80000000 }), /timer range/);
	});
});
