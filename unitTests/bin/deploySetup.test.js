'use strict';

// `deriveSecretName` must mirror the server's `deriveGitSecretName` / `deriveRegistrySecretName`
// (components/secretOperations.ts) exactly, or a `harper deploy setup=true` seal and a literal-token
// deploy would store the credential under different hdb_secret names. These cases lock that in so a
// future drift on either side fails here instead of silently.
const assert = require('node:assert');
const { deriveSecretName } = require('#src/bin/deploySetup');

describe('deploySetup deriveSecretName', () => {
	it('github → deploy.<component>.git.<host> (matches server deriveGitSecretName)', () => {
		assert.strictEqual(deriveSecretName('my-app', 'github.com', 'github'), 'deploy.my-app.git.github.com');
	});

	it('normalizes a git host: strips scheme, user, and path', () => {
		assert.strictEqual(deriveSecretName('my-app', 'git@github.com', 'github'), 'deploy.my-app.git.github.com');
		assert.strictEqual(
			deriveSecretName('my-app', 'https://github.com/owner/repo', 'github'),
			'deploy.my-app.git.github.com'
		);
	});

	it('npm → deploy.<component>.<registry> (matches server deriveRegistrySecretName)', () => {
		assert.strictEqual(deriveSecretName('my-app', 'registry.npmjs.org', 'npm'), 'deploy.my-app.registry.npmjs.org');
		assert.strictEqual(
			deriveSecretName('my-app', 'https://npm.pkg.github.com', 'npm'),
			'deploy.my-app.npm.pkg.github.com'
		);
	});

	it('sanitizes the component name to the set_secret grammar', () => {
		assert.strictEqual(deriveSecretName('@scope/app', 'github.com', 'github'), 'deploy._scope_app.git.github.com');
	});
});
