const { deriveCommonPatternBase } = require('../../components/deriveCommonPatternBase');
const assert = require('node:assert/strict');

describe('deriveCommonPatternBase', () => {
	[
		[['web/index.html', 'web/style.css'], 'web'],
		[['web', 'static'], '.'],
		[['web/static/foo', 'web/static/bar'], 'web/static'],
		[['a/b/c/d', 'a/b/c/e', 'a/b/f'], 'a/b'],
		[['web'], 'web'],
		[['web/index.html'], 'web/index.html'],
		[['index.html', 'style.css'], '.'],
	].forEach(([patterns, expectedBase]) => {
		it(`should derive common pattern base from ${JSON.stringify(patterns)}`, () => {
			const result = deriveCommonPatternBase(patterns);
			assert.equal(result, expectedBase);
		});
	});
});
