const {
	derivePatternRoot,
	derivePatternRoots,
	InvalidPatternRootError,
} = require('../../components/derivePatternRoots');
const assert = require('node:assert/strict');

describe('derivePatternRoot', () => {
	[
		// Static Patterns return themselves
		['index.html', 'index.html'],
		['web/index.html', 'web/index.html'],
		['web/static/index.html', 'web/static/index.html'],
		['.', '.'],
		['web', 'web'],
		['web/static', 'web/static'],
		// Dynamic Patterns
		['*', '.'],
		['**', '.'],
		['**/*', '.'],
		['web/*', 'web'],
		['web/**', 'web'],
		['web/**/*', 'web'],
		['web/static/*', 'web/static'],
		['web/static/**', 'web/static'],
		['web/static/**/*', 'web/static'],
		['web/index*.html', 'web'],
		['web/static/index*.html', 'web/static'],
		// Certain non-alphanumeric characters are okay
		['web123_foo.bar-fuzz/*', 'web123_foo.bar-fuzz'],
		// Valid entries with ambiguous characters later in the pattern
		['web/{a,b}', 'web'],
		['web/static/{a,b}/*', 'web/static'],
		// Ambiguous entries
		['web[ab]', '.'],
		['web(a|b)', '.'],
		['web{a,b}', '.'],
		['web@', '.'],
		['web!', '.'],
		['web*', '.'],
		['web?', '.'],
		['web+', '.'],
	].forEach(([pattern, expected]) => {
		it(`should derive '${expected}' from '${pattern}'`, () => {
			assert.deepEqual(derivePatternRoot(pattern), expected);
			assert.deepEqual(derivePatternRoot(`./${pattern}`), expected);
			assert.deepEqual(derivePatternRoot(`${pattern}/`), expected);
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
			['web', 'static'],
		],
		[
			['web/foo/*', 'web/bar/*'],
			['web/foo', 'web/bar'],
		],
		[['web/*', 'static-[123]/*'], ['web', '.']],
		[['web/index.html', 'web/style.css'], ['web/index.html', 'web/style.css']],
		// Multiple Patterns with a common root
		[['web/*.html', 'web/*.css'], ['web']],
	].forEach(([patterns, expected]) => {
		it(`should derive [${expected.map((e) => `'${e}'`).join(', ')}] from [${patterns.map((p) => `'${p}'`).join(', ')}]`, () => {
			assert.deepEqual(derivePatternRoots(patterns), expected);
		});
	});
});
