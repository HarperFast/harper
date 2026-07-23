'use strict';

const assert = require('node:assert');

const testUtils = require('../testUtils.js');
testUtils.preTestPrep();

const { isSSHAuthFailure, assertApplicationConfig, parseGitReference } = require('#src/components/Application');

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

describe('parseGitReference', () => {
	it('parses an explicit git+https:// identifier', () => {
		assert.deepStrictEqual(parseGitReference('git+https://example.com/owner/repo.git'), {
			cloneUrl: 'https://example.com/owner/repo.git',
			committish: undefined,
		});
	});

	it('parses a git:// identifier with a committish', () => {
		assert.deepStrictEqual(parseGitReference('git://example.com/owner/repo.git#v1.2.3'), {
			cloneUrl: 'git://example.com/owner/repo.git',
			committish: 'v1.2.3',
		});
	});

	it("resolves the github: shorthand this repo's own derivePackageIdentifier defaults to", () => {
		assert.deepStrictEqual(parseGitReference('github:my-org/my-app'), {
			cloneUrl: 'https://github.com/my-org/my-app.git',
			committish: undefined,
		});
	});

	it("resolves github: shorthand with a committish, matching the PR's own worked example", () => {
		assert.deepStrictEqual(parseGitReference('github:my-org/my-app#semver:v1.2.3'), {
			cloneUrl: 'https://github.com/my-org/my-app.git',
			committish: 'semver:v1.2.3',
		});
	});

	it('resolves the gitlab: shorthand', () => {
		assert.deepStrictEqual(parseGitReference('gitlab:my-org/my-app'), {
			cloneUrl: 'https://gitlab.com/my-org/my-app.git',
			committish: undefined,
		});
	});

	it('resolves the bitbucket: shorthand', () => {
		assert.deepStrictEqual(parseGitReference('bitbucket:my-org/my-app'), {
			cloneUrl: 'https://bitbucket.org/my-org/my-app.git',
			committish: undefined,
		});
	});

	it('resolves the gist: shorthand by id', () => {
		assert.deepStrictEqual(parseGitReference('gist:af99f4b3ec6df5c56b03'), {
			cloneUrl: 'https://gist.github.com/af99f4b3ec6df5c56b03.git',
			committish: undefined,
		});
	});

	it('resolves the gist: shorthand with an owner prefix, dropping the owner segment', () => {
		assert.deepStrictEqual(parseGitReference('gist:my-org/af99f4b3ec6df5c56b03'), {
			cloneUrl: 'https://gist.github.com/af99f4b3ec6df5c56b03.git',
			committish: undefined,
		});
	});

	it('returns null for an npm registry identifier', () => {
		assert.strictEqual(parseGitReference('npm:some-package'), null);
	});

	it('returns null for a file identifier', () => {
		assert.strictEqual(parseGitReference('file:../local-app'), null);
	});

	it('returns null for a #path: committish (npm git-url subdirectory extension, unimplemented)', () => {
		assert.strictEqual(parseGitReference('github:my-org/my-app#path:packages/foo'), null);
	});

	it('returns null for a malformed hosted shorthand (not a plain owner/repo)', () => {
		assert.strictEqual(parseGitReference('github:not-owner-slash-repo'), null);
	});

	it('parses a bare https:// URL to a known git host', () => {
		assert.deepStrictEqual(parseGitReference('https://github.com/my-org/my-app'), {
			cloneUrl: 'https://github.com/my-org/my-app',
			committish: undefined,
		});
	});

	// hosted-git-info (which npm's own resolution for `owner:repo` shorthand and bare host URLs is
	// built on) URL-decodes the whole committish while parsing these two forms specifically.
	it('decodes a percent-encoded committish for the github: shorthand, matching hosted-git-info', () => {
		assert.deepStrictEqual(parseGitReference('github:my-org/my-app#feature%2Ffoo'), {
			cloneUrl: 'https://github.com/my-org/my-app.git',
			committish: 'feature/foo',
		});
	});

	it('decodes a percent-encoded committish for a bare host URL, matching hosted-git-info', () => {
		assert.deepStrictEqual(parseGitReference('https://github.com/my-org/my-app#feature%2Ffoo'), {
			cloneUrl: 'https://github.com/my-org/my-app',
			committish: 'feature/foo',
		});
	});

	// An explicit git+ URL form goes through npm-package-arg's own URL.hash extraction instead of
	// hosted-git-info, which does NOT decode the committish — so this deliberately does not either,
	// matching real npm rather than "fixing" what would be a divergence from it.
	it('does NOT decode a percent-encoded committish for an explicit git+https:// URL, matching npm-package-arg', () => {
		assert.deepStrictEqual(parseGitReference('git+https://example.com/owner/repo.git#feature%2Ffoo'), {
			cloneUrl: 'https://example.com/owner/repo.git',
			committish: 'feature%2Ffoo',
		});
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
