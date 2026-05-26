'use strict';

const assert = require('node:assert');

const testUtils = require('../testUtils.js');
testUtils.preTestPrep();

const { isSSHAuthFailure } = require('#src/components/Application');

describe('isSSHAuthFailure', () => {
	it('returns true for "Could not read from remote repository"', () => {
		const stderr = `
npm error code 128
npm error An unknown git error occurred
npm error command git --no-replace-objects ls-remote git@github.com:Org/repo.git
npm error fatal: Could not read from remote repository.
npm error Please make sure you have the correct access rights
npm error and the repository exists.
`;
		assert.strictEqual(isSSHAuthFailure(stderr), true);
	});

	it('returns true for "Permission denied (publickey)"', () => {
		const stderr = `
npm error code 128
npm error An unknown git error occurred
npm error git@github.com: Permission denied (publickey).
npm error fatal: Could not read from remote repository.
`;
		assert.strictEqual(isSSHAuthFailure(stderr), true);
	});

	it('returns true for "No user exists for uid"', () => {
		const stderr = `
npm error code 128
npm error An unknown git error occurred
npm error No user exists for uid 42932
npm error fatal: Could not read from remote repository.
npm error Please make sure you have the correct access rights
npm error and the repository exists.
`;
		assert.strictEqual(isSSHAuthFailure(stderr), true);
	});

	it('returns true for "Host key verification failed"', () => {
		const stderr = `
npm error code 128
npm error An unknown git error occurred
npm error Host key verification failed.
npm error fatal: Could not read from remote repository.
`;
		assert.strictEqual(isSSHAuthFailure(stderr), true);
	});

	it('returns false for unrelated npm errors', () => {
		const stderr = `
npm error code E404
npm error 404 Not Found - GET https://registry.npmjs.org/nonexistent-pkg
npm error 404 '@scope/nonexistent-pkg@latest' is not in this registry.
`;
		assert.strictEqual(isSSHAuthFailure(stderr), false);
	});

	it('returns false for empty stderr', () => {
		assert.strictEqual(isSSHAuthFailure(''), false);
	});
});
