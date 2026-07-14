'use strict';

const assert = require('node:assert');

const testUtils = require('../testUtils.js');
testUtils.preTestPrep();

const { isSSHAuthFailure, assertApplicationConfig } = require('#src/components/Application');

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

describe('assertApplicationConfig credentials', () => {
	it('accepts a config with no credentials', () => {
		assert.doesNotThrow(() => assertApplicationConfig('app', { package: 'npm:@org/app@1.0.0' }));
	});

	it('accepts credential reference entries', () => {
		assert.doesNotThrow(() =>
			assertApplicationConfig('app', {
				package: 'npm:@org/app@1.0.0',
				credentials: [{ registry: 'https://npm.pkg.github.com', secret: 'deploy.app.gh', scope: '@org' }],
			})
		);
	});

	it('rejects credentials that is not an array', () => {
		assert.throws(
			() => assertApplicationConfig('app', { package: 'p', credentials: { registry: 'r', secret: 's' } }),
			/expected array/
		);
	});

	it('accepts a git-host reference entry (#1792)', () => {
		assert.doesNotThrow(() =>
			assertApplicationConfig('app', {
				package: 'github:myorg/private-app',
				credentials: [{ host: 'github.com', secret: 'deploy.app.github.com' }],
			})
		);
	});

	it('rejects a credential entry carrying a literal token (references only on disk)', () => {
		for (const entry of [
			{ registry: 'r', token: 'tok' },
			{ host: 'github.com', token: 'tok' },
		]) {
			assert.throws(
				() => assertApplicationConfig('app', { package: 'p', credentials: [entry] }),
				/reference$/m,
				JSON.stringify(entry)
			);
		}
	});

	it('rejects a credential entry with no recognized identity (neither registry nor host)', () => {
		assert.throws(() => assertApplicationConfig('app', { package: 'p', credentials: [{ secret: 's' }] }), /reference/);
	});
});
