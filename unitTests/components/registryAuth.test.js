'use strict';

// Covers the transient private-registry auth used by deploy_component: buildNpmrcContent
// normalizes each entry into npm's `.npmrc` auth-key form, and an Application materializes that
// content into a per-deploy 0600 `.npmrc` (npmUserconfigPath) that is removed on cleanup. The
// token must never persist beyond the deploy; these tests pin both the format and the lifecycle.

const assert = require('node:assert');
const fs = require('node:fs/promises');
const path = require('node:path');

const testUtils = require('../testUtils.js');
testUtils.preTestPrep();

const { buildNpmrcContent, Application } = require('#src/components/Application');

describe('buildNpmrcContent', () => {
	it('normalizes an https registry into an auth-token line keyed by //host/', () => {
		const out = buildNpmrcContent([{ registry: 'https://npm.pkg.github.com', token: 'tok123' }]);
		assert.strictEqual(out, '//npm.pkg.github.com/:_authToken=tok123\n');
	});

	it('accepts a bare host and a //-prefixed key, both normalized to //host/', () => {
		assert.strictEqual(
			buildNpmrcContent([{ registry: 'npm.pkg.github.com', token: 't' }]),
			'//npm.pkg.github.com/:_authToken=t\n'
		);
		assert.strictEqual(
			buildNpmrcContent([{ registry: '//npm.pkg.github.com/', token: 't' }]),
			'//npm.pkg.github.com/:_authToken=t\n'
		);
	});

	it('emits a scope:registry line pointing at the full URL when a scope is given', () => {
		const out = buildNpmrcContent([{ registry: 'https://npm.pkg.github.com', token: 'tok', scope: '@myorg' }]);
		assert.strictEqual(out, '//npm.pkg.github.com/:_authToken=tok\n@myorg:registry=https://npm.pkg.github.com/\n');
	});

	it('supports multiple registries in one file', () => {
		const out = buildNpmrcContent([
			{ registry: 'https://npm.pkg.github.com', token: 'gh', scope: '@org' },
			{ registry: 'registry.example.com/path', token: 'ex' },
		]);
		assert.strictEqual(
			out,
			[
				'//npm.pkg.github.com/:_authToken=gh',
				'@org:registry=https://npm.pkg.github.com/',
				'//registry.example.com/path/:_authToken=ex',
				'',
			].join('\n')
		);
	});
});

describe('Application transient .npmrc lifecycle', () => {
	it('writes a 0600 .npmrc and exposes its path, then removes it on cleanup', async () => {
		const app = new Application({
			name: 'registry-auth-test',
			packageIdentifier: 'npm:@myorg/app',
			registryAuth: [{ registry: 'https://npm.pkg.github.com', token: 'secret', scope: '@myorg' }],
		});

		assert.strictEqual(app.npmUserconfigPath, undefined, 'no path before write');

		await app.writeTransientNpmrc();
		const npmrcPath = app.npmUserconfigPath;
		assert.ok(npmrcPath && npmrcPath.endsWith('.npmrc'), 'path set after write');

		const contents = await fs.readFile(npmrcPath, 'utf8');
		assert.ok(contents.includes('//npm.pkg.github.com/:_authToken=secret'), 'token line present');
		assert.ok(contents.includes('@myorg:registry=https://npm.pkg.github.com/'), 'scope line present');

		const fileMode = (await fs.stat(npmrcPath)).mode & 0o777;
		assert.strictEqual(fileMode, 0o600, 'file is owner read/write only');
		// The temp dir is created 0700 so the token is unreadable by other users even before chmod.
		const dirMode = (await fs.stat(path.dirname(npmrcPath))).mode & 0o777;
		assert.strictEqual(dirMode, 0o700, 'temp dir is owner-only');

		await app.cleanupTransientNpmrc();
		assert.strictEqual(app.npmUserconfigPath, undefined, 'path cleared after cleanup');
		await assert.rejects(fs.stat(npmrcPath), /ENOENT/, 'file removed after cleanup');
	});

	it('writeTransientNpmrc is a no-op without registryAuth', async () => {
		const app = new Application({ name: 'no-auth-test', packageIdentifier: 'npm:@myorg/app' });
		await app.writeTransientNpmrc();
		assert.strictEqual(app.npmUserconfigPath, undefined);
		// cleanup is safe to call even when nothing was written
		await app.cleanupTransientNpmrc();
	});
});
