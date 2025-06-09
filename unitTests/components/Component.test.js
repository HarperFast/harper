/* eslint-disable sonarjs/no-nested-functions */
const { Component, ComponentInvalidPatternError } = require('../../components/Component');
const assert = require('node:assert/strict');

describe('Component', () => {
	const name = 'test-component';
	const directory = 'component';
	const singlePattern = '*';
	const multiplePatterns = ['foo/*', 'bar/*'];
	const urlPath = 'fizz';

	// Helper function to create and assert Component instance
	function testComponent(config, expected) {
		const actual = new Component(name, directory, config);

		assert.equal(actual.name, name);
		assert.equal(actual.directory, directory);
		assert.deepEqual(actual.config, config);
		assert.equal(actual.baseURLPath, expected.baseURLPath);
		assert.deepEqual(actual.globOptions, expected.globOptions);
		assert.deepEqual(actual.patternBases, expected.patternBases);
		assert.equal(actual.commonPatternBase, expected.commonPatternBase);
	}

	// Helper function to generate expected globOptions
	function getExpectedGlobOptions(source, onlyFiles = false, onlyDirectories = false, ignore = []) {
		return { source, onlyFiles, onlyDirectories, ignore };
	}

	it('should handle exact file pattern', () => {
		testComponent({
			files: 'dir/file',
		}, {
			baseURLPath: '/',
			globOptions: getExpectedGlobOptions(['dir/file']),
			patternBases: ['dir/file'],
			commonPatternBase: 'dir/file',
		});

		testComponent({
			files: './dir/file',
		}, {
			baseURLPath: '/',
			globOptions: getExpectedGlobOptions(['./dir/file']),
			patternBases: ['./dir/file'],
			commonPatternBase: './dir/file',
		});
	});

	describe('with singular pattern', () => {
		const patternBases = [''];
		const commonPatternBase = '';

		describe('with files as a string', () => {
			it('should instantiate without any other options', () => {
				const config = { files: singlePattern };
				testComponent(config, {
					baseURLPath: '/',
					globOptions: getExpectedGlobOptions([singlePattern]),
					patternBases,
					commonPatternBase,
				});
			});

			it('should instantiate with urlPath option', () => {
				const config = { files: singlePattern, urlPath };
				testComponent(config, {
					baseURLPath: '/fizz/',
					globOptions: getExpectedGlobOptions([singlePattern]),
					patternBases,
					commonPatternBase,
				});
			});

			it('should throw an error if the pattern contains ".."', () => {
				const invalidPattern = '..';
				const config = { files: invalidPattern };
				assert.throws(() => {
					testComponent(config, {
						baseURLPath: '/',
						globOptions: getExpectedGlobOptions([invalidPattern]),
						patternBases,
						commonPatternBase,
					});
				}, new ComponentInvalidPatternError(invalidPattern));
			});
			it('should throw an error if the pattern starts with "/"', () => {
				const invalidPattern = '/*';
				const config = { files: invalidPattern };
				assert.throws(() => {
					testComponent(config, {
						baseURLPath: '/',
						globOptions: getExpectedGlobOptions([invalidPattern]),
						patternBases,
						commonPatternBase,
					});
				}, new ComponentInvalidPatternError(invalidPattern));
			});
		});

		describe('with files as an object', () => {
			it('should instantiate without any other options', () => {
				const config = { files: { source: singlePattern } };
				testComponent(config, {
					baseURLPath: '/',
					globOptions: getExpectedGlobOptions([singlePattern]),
					patternBases,
					commonPatternBase,
				});
			});

			it('should instantiate with urlPath option', () => {
				const config = { files: { source: singlePattern }, urlPath };
				testComponent(config, {
					baseURLPath: '/fizz/',
					globOptions: getExpectedGlobOptions([singlePattern]),
					patternBases,
					commonPatternBase,
				});
			});

			it('should instantiate with files.only option set to files', () => {
				const config = { files: { source: singlePattern, only: 'files' }, urlPath };
				testComponent(config, {
					baseURLPath: '/fizz/',
					globOptions: getExpectedGlobOptions([singlePattern], true),
					patternBases,
					commonPatternBase,
				});
			});

			it('should instantiate with files.only option set to directories', () => {
				const config = { files: { source: singlePattern, only: 'directories' }, urlPath };
				testComponent(config, {
					baseURLPath: '/fizz/',
					globOptions: getExpectedGlobOptions([singlePattern], false, true),
					patternBases,
					commonPatternBase,
				});
			});

			it('should instantiate with files.ignore option set to a string', () => {
				const config = { files: { source: singlePattern, ignore: 'buzz' }, urlPath };
				testComponent(config, {
					baseURLPath: '/fizz/',
					globOptions: getExpectedGlobOptions([singlePattern], false, false, ['buzz']),
					patternBases,
					commonPatternBase,
				});
			});

			it('should throw an error if the pattern contains ".."', () => {
				const invalidPattern = '..';
				const config = { files: { source: invalidPattern } };
				assert.throws(() => {
					testComponent(config, {
						baseURLPath: '/',
						globOptions: getExpectedGlobOptions([invalidPattern]),
						patternBases,
						commonPatternBase,
					});
				}, new ComponentInvalidPatternError(invalidPattern));
			});
			it('should throw an error if the pattern starts with "/"', () => {
				const invalidPattern = '/*';
				const config = { files: { source: invalidPattern } };
				assert.throws(() => {
					testComponent(config, {
						baseURLPath: '/',
						globOptions: getExpectedGlobOptions([invalidPattern]),
						patternBases,
						commonPatternBase,
					});
				}, new ComponentInvalidPatternError(invalidPattern));
			});
		});
	});

	describe('with multiple patterns', () => {
		const patternBases = ['foo', 'bar'];
		const commonPatternBase = '.';

		describe('with files as a string', () => {
			it('should instantiate without any other options', () => {
				const config = { files: multiplePatterns };
				testComponent(config, {
					baseURLPath: '/',
					globOptions: getExpectedGlobOptions(multiplePatterns),
					patternBases,
					commonPatternBase,
				});
			});

			it('should instantiate with urlPath option', () => {
				const config = { files: multiplePatterns, urlPath };
				testComponent(config, {
					baseURLPath: '/fizz/',
					globOptions: getExpectedGlobOptions(multiplePatterns),
					patternBases,
					commonPatternBase,
				});
			});

			it('should throw an error if any pattern contains ".."', () => {
				const invalidPattern = '..';
				const config = { files: ['foo/', invalidPattern] };
				assert.throws(() => {
					testComponent(config, {
						baseURLPath: '/',
						globOptions: getExpectedGlobOptions([invalidPattern]),
						patternBases,
						commonPatternBase,
					});
				}, new ComponentInvalidPatternError(invalidPattern));
			});
			it('should throw an error if any pattern starts with "/"', () => {
				const invalidPattern = '/*';
				const config = { files: ['foo/', invalidPattern] };
				assert.throws(() => {
					testComponent(config, {
						baseURLPath: '/',
						globOptions: getExpectedGlobOptions([invalidPattern]),
						patternBases,
						commonPatternBase,
					});
				}, new ComponentInvalidPatternError(invalidPattern));
			});
		});

		describe('with files as an object', () => {
			it('should instantiate without any other options', () => {
				const config = { files: { source: multiplePatterns } };
				testComponent(config, {
					baseURLPath: '/',
					globOptions: getExpectedGlobOptions(multiplePatterns),
					patternBases,
					commonPatternBase,
				});
			});

			it('should instantiate with urlPath option', () => {
				const config = { files: { source: multiplePatterns }, urlPath };
				testComponent(config, {
					baseURLPath: '/fizz/',
					globOptions: getExpectedGlobOptions(multiplePatterns),
					patternBases,
					commonPatternBase,
				});
			});

			it('should instantiate with files.only option set to files', () => {
				const config = { files: { source: multiplePatterns, only: 'files' }, urlPath };
				testComponent(config, {
					baseURLPath: '/fizz/',
					globOptions: getExpectedGlobOptions(multiplePatterns, true),
					patternBases,
					commonPatternBase,
				});
			});

			it('should instantiate with files.only option set to directories', () => {
				const config = { files: { source: multiplePatterns, only: 'directories' }, urlPath };
				testComponent(config, {
					baseURLPath: '/fizz/',
					globOptions: getExpectedGlobOptions(multiplePatterns, false, true),
					patternBases,
					commonPatternBase,
				});
			});

			it('should instantiate with files.ignore option set to a string', () => {
				const config = { files: { source: multiplePatterns, ignore: 'buzz' }, urlPath };
				testComponent(config, {
					baseURLPath: '/fizz/',
					globOptions: getExpectedGlobOptions(multiplePatterns, false, false, ['buzz']),
					patternBases,
					commonPatternBase,
				});
			});

			it('should throw an error if any pattern contains ".."', () => {
				const invalidPattern = '..';
				const config = { files: { source: ['foo/', invalidPattern] } };
				assert.throws(() => {
					testComponent(config, {
						baseURLPath: '/',
						globOptions: getExpectedGlobOptions([invalidPattern]),
						patternBases,
						commonPatternBase,
					});
				}, new ComponentInvalidPatternError(invalidPattern));
			});
			it('should throw an error if any pattern starts with "/"', () => {
				const invalidPattern = '/*';
				const config = { files: { source: ['foo/', invalidPattern] } };
				assert.throws(() => {
					testComponent(config, {
						baseURLPath: '/',
						globOptions: getExpectedGlobOptions([invalidPattern]),
						patternBases,
						commonPatternBase,
					});
				}, new ComponentInvalidPatternError(invalidPattern));
			});
		});
	});
});
