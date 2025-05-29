/* eslint-disable sonarjs/no-nested-functions */
const { ComponentV2, ComponentV2InvalidPatternError } = require('../../components/ComponentV2');
const assert = require('node:assert/strict');

describe('ComponentV2', () => {
	const name = 'test-component';
	const directory = 'component';
	const singlePattern = '*';
	const multiplePatterns = ['foo/*', 'bar/*'];
	const urlPath = 'fizz';

	// Helper function to create and assert ComponentV2 instance
	function testComponentV2(config, expected) {
		const actual = new ComponentV2(name, directory, config);

		assert.equal(actual.name, name);
		assert.equal(actual.directory, directory);
		assert.deepEqual(actual.config, config);
		assert.equal(actual.baseURLPath, expected.baseURLPath);
		assert.deepEqual(actual.globOptions, expected.globOptions);
		assert.deepEqual(actual.patternRoots, expected.patternRoots);
	}

	// Helper function to generate expected globOptions
	function getExpectedGlobOptions(source, onlyFiles = false, onlyDirectories = false, ignore = []) {
		return { source, onlyFiles, onlyDirectories, ignore };
	}

	describe('with singular pattern', () => {
		const patternRoots = ['.'];

		describe('with files as a string', () => {
			it('should instantiate without any other options', () => {
				const config = { files: singlePattern };
				testComponentV2(config, {
					baseURLPath: '/',
					globOptions: getExpectedGlobOptions([singlePattern]),
					patternRoots,
				});
			});

			it('should instantiate with urlPath option', () => {
				const config = { files: singlePattern, urlPath };
				testComponentV2(config, {
					baseURLPath: '/fizz/',
					globOptions: getExpectedGlobOptions([singlePattern]),
					patternRoots,
				});
			});

			it('should throw an error if the pattern contains ".."', () => {
				const invalidPattern = '..';
				const config = { files: invalidPattern };
				assert.throws(() => {
					testComponentV2(config, {
						baseURLPath: '/',
						globOptions: getExpectedGlobOptions([invalidPattern]),
						patternRoots,
					});
				}, new ComponentV2InvalidPatternError(invalidPattern));
			});
			it('should throw an error if the pattern starts with "/"', () => {
				const invalidPattern = '/*';
				const config = { files: invalidPattern };
				assert.throws(() => {
					testComponentV2(config, {
						baseURLPath: '/',
						globOptions: getExpectedGlobOptions([invalidPattern]),
						patternRoots,
					});
				}, new ComponentV2InvalidPatternError(invalidPattern));
			});
		});

		describe('with files as an object', () => {
			it('should instantiate without any other options', () => {
				const config = { files: { source: singlePattern } };
				testComponentV2(config, {
					baseURLPath: '/',
					globOptions: getExpectedGlobOptions([singlePattern]),
					patternRoots,
				});
			});

			it('should instantiate with urlPath option', () => {
				const config = { files: { source: singlePattern }, urlPath };
				testComponentV2(config, {
					baseURLPath: '/fizz/',
					globOptions: getExpectedGlobOptions([singlePattern]),
					patternRoots,
				});
			});

			it('should instantiate with files.only option set to files', () => {
				const config = { files: { source: singlePattern, only: 'files' }, urlPath };
				testComponentV2(config, {
					baseURLPath: '/fizz/',
					globOptions: getExpectedGlobOptions([singlePattern], true),
					patternRoots,
				});
			});

			it('should instantiate with files.only option set to directories', () => {
				const config = { files: { source: singlePattern, only: 'directories' }, urlPath };
				testComponentV2(config, {
					baseURLPath: '/fizz/',
					globOptions: getExpectedGlobOptions([singlePattern], false, true),
					patternRoots,
				});
			});

			it('should instantiate with files.ignore option set to a string', () => {
				const config = { files: { source: singlePattern, ignore: 'buzz' }, urlPath };
				testComponentV2(config, {
					baseURLPath: '/fizz/',
					globOptions: getExpectedGlobOptions([singlePattern], false, false, ['buzz']),
					patternRoots,
				});
			});

			it('should throw an error if the pattern contains ".."', () => {
				const invalidPattern = '..';
				const config = { files: { source: invalidPattern } };
				assert.throws(() => {
					testComponentV2(config, {
						baseURLPath: '/',
						globOptions: getExpectedGlobOptions([invalidPattern]),
						patternRoots,
					});
				}, new ComponentV2InvalidPatternError(invalidPattern));
			});
			it('should throw an error if the pattern starts with "/"', () => {
				const invalidPattern = '/*';
				const config = { files: { source: invalidPattern } };
				assert.throws(() => {
					testComponentV2(config, {
						baseURLPath: '/',
						globOptions: getExpectedGlobOptions([invalidPattern]),
						patternRoots,
					});
				}, new ComponentV2InvalidPatternError(invalidPattern));
			});
		});
	});

	describe('with multiple patterns', () => {
		const patternRoots = ['foo', 'bar'];

		describe('with files as a string', () => {
			it('should instantiate without any other options', () => {
				const config = { files: multiplePatterns };
				testComponentV2(config, {
					baseURLPath: '/',
					globOptions: getExpectedGlobOptions(multiplePatterns),
					patternRoots,
				});
			});

			it('should instantiate with urlPath option', () => {
				const config = { files: multiplePatterns, urlPath };
				testComponentV2(config, {
					baseURLPath: '/fizz/',
					globOptions: getExpectedGlobOptions(multiplePatterns),
					patternRoots,
				});
			});

			it('should throw an error if any pattern contains ".."', () => {
				const invalidPattern = '..';
				const config = { files: ['foo/', invalidPattern] };
				assert.throws(() => {
					testComponentV2(config, {
						baseURLPath: '/',
						globOptions: getExpectedGlobOptions([invalidPattern]),
						patternRoots,
					});
				}, new ComponentV2InvalidPatternError(invalidPattern));
			});
			it('should throw an error if any pattern starts with "/"', () => {
				const invalidPattern = '/*';
				const config = { files: ['foo/', invalidPattern] };
				assert.throws(() => {
					testComponentV2(config, {
						baseURLPath: '/',
						globOptions: getExpectedGlobOptions([invalidPattern]),
						patternRoots,
					});
				}, new ComponentV2InvalidPatternError(invalidPattern));
			});
		});

		describe('with files as an object', () => {
			it('should instantiate without any other options', () => {
				const config = { files: { source: multiplePatterns } };
				testComponentV2(config, {
					baseURLPath: '/',
					globOptions: getExpectedGlobOptions(multiplePatterns),
					patternRoots,
				});
			});

			it('should instantiate with urlPath option', () => {
				const config = { files: { source: multiplePatterns }, urlPath };
				testComponentV2(config, {
					baseURLPath: '/fizz/',
					globOptions: getExpectedGlobOptions(multiplePatterns),
					patternRoots,
				});
			});

			it('should instantiate with files.only option set to files', () => {
				const config = { files: { source: multiplePatterns, only: 'files' }, urlPath };
				testComponentV2(config, {
					baseURLPath: '/fizz/',
					globOptions: getExpectedGlobOptions(multiplePatterns, true),
					patternRoots,
				});
			});

			it('should instantiate with files.only option set to directories', () => {
				const config = { files: { source: multiplePatterns, only: 'directories' }, urlPath };
				testComponentV2(config, {
					baseURLPath: '/fizz/',
					globOptions: getExpectedGlobOptions(multiplePatterns, false, true),
					patternRoots,
				});
			});

			it('should instantiate with files.ignore option set to a string', () => {
				const config = { files: { source: multiplePatterns, ignore: 'buzz' }, urlPath };
				testComponentV2(config, {
					baseURLPath: '/fizz/',
					globOptions: getExpectedGlobOptions(multiplePatterns, false, false, ['buzz']),
					patternRoots,
				});
			});

			it('should throw an error if any pattern contains ".."', () => {
				const invalidPattern = '..';
				const config = { files: { source: ['foo/', invalidPattern] } };
				assert.throws(() => {
					testComponentV2(config, {
						baseURLPath: '/',
						globOptions: getExpectedGlobOptions([invalidPattern]),
						patternRoots,
					});
				}, new ComponentV2InvalidPatternError(invalidPattern));
			});
			it('should throw an error if any pattern starts with "/"', () => {
				const invalidPattern = '/*';
				const config = { files: { source: ['foo/', invalidPattern] } };
				assert.throws(() => {
					testComponentV2(config, {
						baseURLPath: '/',
						globOptions: getExpectedGlobOptions([invalidPattern]),
						patternRoots,
					});
				}, new ComponentV2InvalidPatternError(invalidPattern));
			});
		});
	});
});
