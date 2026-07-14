'use strict';

// Covers the transient private-registry credentials used by deploy_component: buildNpmrcContent
// normalizes each entry into npm's `.npmrc` auth-key form, and an Application materializes that
// content into a per-deploy 0600 `.npmrc` (npmUserconfigPath) that is removed on cleanup. The
// token must never persist beyond the deploy; these tests pin both the format and the lifecycle.

const assert = require('node:assert');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const testUtils = require('../testUtils.js');
testUtils.preTestPrep();

const { buildNpmrcContent, Application } = require('#src/components/Application');

describe('buildNpmrcContent', () => {
	it('emits an auth-token line plus a default registry line for a scope-less entry', () => {
		const out = buildNpmrcContent([{ registry: 'https://npm.pkg.github.com', token: 'tok123' }]);
		assert.strictEqual(out, '//npm.pkg.github.com/:_authToken=tok123\nregistry=https://npm.pkg.github.com/\n');
	});

	it('accepts a bare host and a //-prefixed key, both normalized to //host/', () => {
		assert.strictEqual(
			buildNpmrcContent([{ registry: 'npm.pkg.github.com', token: 't' }]),
			'//npm.pkg.github.com/:_authToken=t\nregistry=https://npm.pkg.github.com/\n'
		);
		assert.strictEqual(
			buildNpmrcContent([{ registry: '//npm.pkg.github.com/', token: 't' }]),
			'//npm.pkg.github.com/:_authToken=t\nregistry=https://npm.pkg.github.com/\n'
		);
	});

	it('routes only the scope (no default registry) when a scope is given', () => {
		const out = buildNpmrcContent([{ registry: 'https://npm.pkg.github.com', token: 'tok', scope: '@myorg' }]);
		assert.strictEqual(out, '//npm.pkg.github.com/:_authToken=tok\n@myorg:registry=https://npm.pkg.github.com/\n');
	});

	it('supports multiple registries in one file (scoped routes scope, scope-less sets default)', () => {
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
				'registry=https://registry.example.com/path/',
				'',
			].join('\n')
		);
	});

	it('rejects a token containing a newline (would inject arbitrary .npmrc lines)', () => {
		// The ops validator guards literal tokens, but a token resolved from an hdb_secret row
		// bypasses that; the write-boundary guard must catch a CR/LF from either source.
		for (const bad of ['tok\nregistry=https://evil', 'tok\rfoo=bar']) {
			assert.throws(
				() => buildNpmrcContent([{ registry: 'https://npm.pkg.github.com', token: bad }]),
				/illegal newline/
			);
		}
	});
});

describe('Application transient .npmrc lifecycle', () => {
	it('writes a 0600 .npmrc and exposes its path, then removes it on cleanup', async () => {
		const app = new Application({
			name: 'registry-credentials-test',
			packageIdentifier: 'npm:@myorg/app',
			registryCredentials: [{ registry: 'https://npm.pkg.github.com', token: 'secret', scope: '@myorg' }],
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

	it('writeTransientNpmrc is a no-op without registry credentials', async () => {
		const app = new Application({ name: 'no-auth-test', packageIdentifier: 'npm:@myorg/app' });
		await app.writeTransientNpmrc();
		assert.strictEqual(app.npmUserconfigPath, undefined);
		// cleanup is safe to call even when nothing was written
		await app.cleanupTransientNpmrc();
	});

	it('prepends an inherited npm userconfig (e.g. fabric-injected) ahead of the transient auth', async () => {
		const inheritedDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harper-inherited-npmrc-'));
		const inheritedPath = path.join(inheritedDir, '.npmrc');
		await fs.writeFile(inheritedPath, 'proxy=http://corp-proxy:8080\n@other:registry=https://other.example.com/\n');
		// Capture both case variants npm honors so the test is deterministic regardless of host env.
		const prevUpper = process.env.NPM_CONFIG_USERCONFIG;
		const prevLower = process.env.npm_config_userconfig;
		delete process.env.npm_config_userconfig;
		process.env.NPM_CONFIG_USERCONFIG = inheritedPath;
		try {
			const app = new Application({
				name: 'merge-test',
				packageIdentifier: 'npm:@myorg/app',
				registryCredentials: [{ registry: 'https://npm.pkg.github.com', token: 'secret', scope: '@myorg' }],
			});
			await app.writeTransientNpmrc();
			const contents = await fs.readFile(app.npmUserconfigPath, 'utf8');
			assert.ok(contents.includes('proxy=http://corp-proxy:8080'), 'inherited proxy preserved');
			assert.ok(contents.includes('@other:registry=https://other.example.com/'), 'inherited registry preserved');
			assert.ok(contents.includes('//npm.pkg.github.com/:_authToken=secret'), 'transient token present');
			// Transient auth must come after inherited content so it wins on a conflicting key.
			assert.ok(
				contents.indexOf('_authToken=secret') > contents.indexOf('proxy=http://corp-proxy:8080'),
				'transient auth appended after inherited content'
			);
			await app.cleanupTransientNpmrc();
		} finally {
			if (prevUpper === undefined) delete process.env.NPM_CONFIG_USERCONFIG;
			else process.env.NPM_CONFIG_USERCONFIG = prevUpper;
			if (prevLower !== undefined) process.env.npm_config_userconfig = prevLower;
			await fs.rm(inheritedDir, { recursive: true, force: true });
		}
	});
});
