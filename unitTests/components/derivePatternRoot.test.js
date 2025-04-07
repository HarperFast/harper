const { derivePatternRoot, derivePatternRoots } = require('../../components/componentLoader');
const assert = require('node:assert/strict');

describe('componentLoader derivePatternRoot', () => {
	[
		// Simple, valid patterns
		['*', '/'],
		['**', '/'],
		['**/*', '/'],
		['web/*', 'web/'],
		['web/**', 'web/'],
		['web/**/*', 'web/'],
		['web/index.html', '/'],
		['web', '/'],
		['web/static', '/'],
		// Handles relative `./` paths
		['./*', '/'],
		['./**', '/'],
		['./**/*', '/'],
		['./web/*', './web/'],
		['./web/index.html', '/'],
		['./web', '/'],
		// Certain non-alphanumeric characters are okay
		['web123_foo.bar-fuzz/*', 'web123_foo.bar-fuzz/'],
		['web/static/*', 'web/static/'],
		// Valid entries with ambiguous characters later in the pattern
		['base/{web,static}/*', 'base/'],
		['a/b/{web,static}/*', 'a/b/'],
		// Ambiguous entries
		['web[ab]/*', null],
		['web(a|b)/*', null],
		['web{a,b}/*', null],
		['web@/*', null],
		['web!/*', null],
		['web*/*', null],
		['web?/*', null],
		['web+/*', null],
	].forEach(([pattern, expected]) => {
		it(`should derive ${expected ?? 'null'} from ${pattern}`, () => {
			assert.deepEqual(derivePatternRoot(pattern), expected);
		});
	});

	it('should throw an error for invalid patterns', () => {
		assert.throws(() => derivePatternRoot('/'), { message: `Pattern must not start with '/'. Received: '/'` });
		assert.throws(() => derivePatternRoot('/web'), { message: `Pattern must not start with '/'. Received: '/web'` });
		assert.throws(() => derivePatternRoot('..'), { message: `Pattern must not contain '..'. Received: '..'` });
		assert.throws(() => derivePatternRoot('web/static/../../..'), {
			message: `Pattern must not contain '..'. Received: 'web/static/../../..'`,
		});
	});
});

describe('componentLoader derivePatternRoots', () => {
	[
		// Multiple Patterns
		[
			['web/*', 'static/*'],
			['web/', 'static/'],
		],
		[
			['web/*', 'static-[123]/*'],
			['web/', null],
		],
		// Multiple Patterns with a common root
		[['web/index.html', 'web/style.css'], ['/']],
		[
			['web/foo/*', 'web/bar/*'],
			['web/foo/', 'web/bar/'],
		],
		[['web/*.html', 'web/*.css'], ['web/']],
	].forEach(([patterns, expected]) => {
		it(`should derive ${expected.map((e) => e ?? 'null')} from ${patterns}`, () => {
			assert.deepEqual(derivePatternRoots(patterns), expected);
		});
	});
});
