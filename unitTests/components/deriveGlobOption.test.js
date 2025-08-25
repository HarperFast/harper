const assert = require('node:assert/strict');
const { deriveGlobOptions } = require('../../components/deriveGlobOptions');

// components/deriveGlobOptions.test.ts

describe('deriveGlobOptions', () => {
	it('should handle files as a string', () => {
		const files = 'src/**/*.ts';
		const actual = deriveGlobOptions(files);
		assert.deepEqual(actual, {
			source: ['src/**/*.ts'],
			onlyFiles: false,
			onlyDirectories: false,
			ignore: [],
		});
	});

	it('should handle files as an array of strings', () => {
		const files = ['src/**/*.ts', 'test/**/*.ts'];
		const actual = deriveGlobOptions(files);
		assert.deepEqual(actual, {
			source: ['src/**/*.ts', 'test/**/*.ts'],
			onlyFiles: false,
			onlyDirectories: false,
			ignore: [],
		});
	});

	it('should handle files as an object with source and ignore', () => {
		const files = {
			source: 'src/**/*.ts',
			ignore: 'node_modules/**',
		};
		const actual = deriveGlobOptions(files);
		assert.deepEqual(actual, {
			source: ['src/**/*.ts'],
			onlyFiles: false,
			onlyDirectories: false,
			ignore: ['node_modules/**'],
		});
	});

	it('should handle files as an object with only set to "files"', () => {
		const files = {
			source: 'src/**/*.ts',
			only: 'files',
		};
		const actual = deriveGlobOptions(files);
		assert.deepEqual(actual, {
			source: ['src/**/*.ts'],
			onlyFiles: true,
			onlyDirectories: false,
			ignore: [],
		});
	});

	it('should handle files as an object with only set to "directories"', () => {
		const files = {
			source: 'src/**',
			only: 'directories',
		};
		const actual = deriveGlobOptions(files);
		assert.deepEqual(actual, {
			source: ['src/**'],
			onlyFiles: false,
			onlyDirectories: true,
			ignore: [],
		});
	});

	it('should handle files as an object with no ignore or only properties', () => {
		const files = {
			source: ['src/**/*.ts', 'test/**/*.ts'],
		};
		const actual = deriveGlobOptions(files);
		assert.deepEqual(actual, {
			source: ['src/**/*.ts', 'test/**/*.ts'],
			onlyFiles: false,
			onlyDirectories: false,
			ignore: [],
		});
	});
});
