/* eslint-disable sonarjs/no-nested-template-literals */
const {
	derivePatternRoot,
	derivePatternRoots,
	InvalidPatternRootError,
} = require('../../components/derivePatternRoots');
const assert = require('node:assert/strict');

describe('derivePatternRoot', () => {
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
		it(`should derive ${expected ? `'${expected}'` : 'null'} from '${pattern}'`, () => {
			assert.deepEqual(derivePatternRoot(pattern), expected);
		});
	});

	it('should throw an error for invalid patterns', () => {
		['/', '/web', '..', 'web/static/../../..'].forEach((pattern) => {
			assert.throws(() => derivePatternRoot(pattern), new InvalidPatternRootError(pattern));
		});
	});
});

describe('derivePatternRoots', () => {
	[
		// Multiple Patterns
		[
			['web/*', 'static/*'],
			['web/', 'static/'],
		],
		[['web/*', 'static-[123]/*'], ['web/']],
		// Multiple Patterns with a common root
		[['web/index.html', 'web/style.css'], ['/']],
		[
			['web/foo/*', 'web/bar/*'],
			['web/foo/', 'web/bar/'],
		],
		[['web/*.html', 'web/*.css'], ['web/']],
	].forEach(([patterns, expected]) => {
		it(`should derive [${expected.map((e) => `'${e}'`).join(', ')}] from [${patterns.map((p) => `'${p}'`).join(', ')}]`, () => {
			assert.deepEqual(derivePatternRoots(patterns), expected);
		});
	});
});
