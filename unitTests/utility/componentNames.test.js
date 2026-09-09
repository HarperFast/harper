'use strict';

// These names are derived independently by the CLI (`harper deploy setup=true`) and by the server's
// deploy path, so they live in one module and are locked down here. A change to any of them changes
// which hdb_secret row a sealed credential lands in, or which project it is granted to.
const assert = require('node:assert');
const path = require('node:path');
const {
	canonicalProjectName,
	deriveGitSecretName,
	deriveRegistrySecretName,
	directoryProjectName,
	normalizeGitHost,
	projectNameFromPackage,
	GIT_HOST_PATTERN,
	PROJECT_NAME_PATTERN,
} = require('#src/utility/componentNames');

describe('componentNames', () => {
	describe('normalizeGitHost', () => {
		it('reduces scheme, userinfo, path and case to a bare host', () => {
			for (const input of [
				'github.com',
				'GitHub.com',
				'github.com/',
				'https://github.com',
				'https://github.com/owner/repo',
				'git@github.com',
				'https://x-access-token@github.com/',
			]) {
				assert.strictEqual(normalizeGitHost(input), 'github.com', input);
			}
		});

		it('keeps a port', () => {
			assert.strictEqual(normalizeGitHost('git.example.com:8443'), 'git.example.com:8443');
		});
	});

	describe('secret names', () => {
		it('git → deploy.<component>.git.<host>', () => {
			assert.strictEqual(deriveGitSecretName('my-app', 'github.com'), 'deploy.my-app.git.github.com');
			assert.strictEqual(deriveGitSecretName('my-app', 'git@github.com'), 'deploy.my-app.git.github.com');
			assert.strictEqual(
				deriveGitSecretName('my-app', 'https://github.com/owner/repo'),
				'deploy.my-app.git.github.com'
			);
		});

		it('registry → deploy.<component>.<registry>', () => {
			assert.strictEqual(deriveRegistrySecretName('my-app', 'registry.npmjs.org'), 'deploy.my-app.registry.npmjs.org');
			assert.strictEqual(
				deriveRegistrySecretName('my-app', 'https://npm.pkg.github.com/'),
				'deploy.my-app.npm.pkg.github.com'
			);
		});

		it('keeps a git and a registry credential for the same host in separate rows', () => {
			assert.notStrictEqual(
				deriveGitSecretName('app', 'npm.pkg.github.com'),
				deriveRegistrySecretName('app', 'npm.pkg.github.com')
			);
		});

		it('sanitizes both halves to the set_secret name grammar', () => {
			assert.strictEqual(deriveGitSecretName('@scope/app', 'github.com'), 'deploy._scope_app.git.github.com');
			assert.strictEqual(
				deriveRegistrySecretName('app', 'registry.example.com:4873/path/'),
				'deploy.app.registry.example.com_4873_path'
			);
		});
	});

	describe('project names', () => {
		it('canonicalizes an explicit project the way deploy_component does', () => {
			assert.strictEqual(canonicalProjectName('web'), 'web');
			assert.strictEqual(canonicalProjectName('@scope/app'), 'app');
			assert.strictEqual(canonicalProjectName('app.tgz'), 'app');
		});

		it('derives a project from a package spec', () => {
			assert.strictEqual(projectNameFromPackage('github:owner/repo'), 'repo');
			assert.strictEqual(projectNameFromPackage('git+ssh://git@github.com/owner/repo.git#abc123'), 'repo');
			assert.strictEqual(projectNameFromPackage('https://github.com/owner/repo.git'), 'repo');
		});

		it('defaults a directory deploy to the directory name', () => {
			assert.strictEqual(directoryProjectName(path.join('/tmp', 'checkout')), 'checkout');
		});
	});

	describe('patterns', () => {
		it('PROJECT_NAME_PATTERN accepts what a project-scoped operation accepts', () => {
			for (const name of ['web', 'my-app', 'my_app', 'app2']) assert.ok(PROJECT_NAME_PATTERN.test(name), name);
			for (const name of ['', '@scope/app', 'my.app', 'my app']) assert.ok(!PROJECT_NAME_PATTERN.test(name), name);
		});

		it('GIT_HOST_PATTERN accepts a bare host, with or without a port', () => {
			for (const host of ['github.com', 'git.example.com:8443']) assert.ok(GIT_HOST_PATTERN.test(host), host);
			for (const host of ['', 'https://github.com', 'github.com/owner', 'git@github.com', 'git hub.com'])
				assert.ok(!GIT_HOST_PATTERN.test(host), host);
		});
	});
});
