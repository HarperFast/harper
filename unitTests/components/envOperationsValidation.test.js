'use strict';

const assert = require('node:assert');
const validator = require('#js/components/operationsValidation');

// validateBySchema returns undefined when valid and an Error when invalid.
const valid = (res) => res === undefined;

describe('env operation validators', () => {
	describe('setEnvValueValidator', () => {
		it('accepts a single key + value', () => {
			assert.ok(valid(validator.setEnvValueValidator({ project: 'app', key: 'API_KEY', value: 'x' })));
		});

		it('accepts an empty string value', () => {
			assert.ok(valid(validator.setEnvValueValidator({ project: 'app', key: 'API_KEY', value: '' })));
		});

		it('accepts a values map', () => {
			assert.ok(valid(validator.setEnvValueValidator({ project: 'app', values: { A: '1', B: '2' } })));
		});

		it('requires value when key is given', () => {
			assert.ok(!valid(validator.setEnvValueValidator({ project: 'app', key: 'A' })));
		});

		it('requires key when value is given', () => {
			assert.ok(!valid(validator.setEnvValueValidator({ project: 'app', value: 'x' })));
		});

		it('rejects both key and values together', () => {
			assert.ok(!valid(validator.setEnvValueValidator({ project: 'app', key: 'A', value: '1', values: { B: '2' } })));
		});

		it('rejects neither key nor values', () => {
			assert.ok(!valid(validator.setEnvValueValidator({ project: 'app' })));
		});

		it('rejects a key with characters outside the env key set', () => {
			assert.ok(!valid(validator.setEnvValueValidator({ project: 'app', key: 'A=B', value: 'x' })));
			assert.ok(!valid(validator.setEnvValueValidator({ project: 'app', key: 'A\nB=evil', value: 'x' })));
		});

		it('rejects a values map key with an invalid name (would otherwise inject)', () => {
			assert.ok(!valid(validator.setEnvValueValidator({ project: 'app', values: { 'A B': '1' } })));
			assert.ok(!valid(validator.setEnvValueValidator({ project: 'app', values: { 'A\nB=evil': '1' } })));
		});

		it('rejects a bad project name and path traversal in file', () => {
			assert.ok(!valid(validator.setEnvValueValidator({ project: '../etc', key: 'A', value: 'x' })));
			assert.ok(!valid(validator.setEnvValueValidator({ project: 'app', file: '../.env', key: 'A', value: 'x' })));
		});
	});

	describe('deleteEnvValueValidator', () => {
		it('accepts a single key', () => {
			assert.ok(valid(validator.deleteEnvValueValidator({ project: 'app', key: 'A' })));
		});

		it('accepts a keys array', () => {
			assert.ok(valid(validator.deleteEnvValueValidator({ project: 'app', keys: ['A', 'B'] })));
		});

		it('rejects both key and keys together', () => {
			assert.ok(!valid(validator.deleteEnvValueValidator({ project: 'app', key: 'A', keys: ['B'] })));
		});

		it('rejects neither key nor keys', () => {
			assert.ok(!valid(validator.deleteEnvValueValidator({ project: 'app' })));
		});

		it('rejects an empty keys array', () => {
			assert.ok(!valid(validator.deleteEnvValueValidator({ project: 'app', keys: [] })));
		});
	});

	describe('getEnvKeysValidator', () => {
		it('accepts project alone (file defaults later)', () => {
			assert.ok(valid(validator.getEnvKeysValidator({ project: 'app' })));
		});

		it('accepts an explicit env file', () => {
			assert.ok(valid(validator.getEnvKeysValidator({ project: 'app', file: '.env.local' })));
		});

		it('requires a project', () => {
			assert.ok(!valid(validator.getEnvKeysValidator({ file: '.env' })));
		});

		it('rejects path traversal in file', () => {
			assert.ok(!valid(validator.getEnvKeysValidator({ project: 'app', file: '../secrets' })));
		});

		it('rejects a project name with traversal or invalid characters', () => {
			assert.ok(!valid(validator.getEnvKeysValidator({ project: '../etc' })));
			assert.ok(!valid(validator.getEnvKeysValidator({ project: 'a/b' })));
		});
	});
});
