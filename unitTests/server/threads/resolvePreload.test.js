'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { resolvePreloadModules } = require('#src/server/threads/resolvePreload');

describe('resolvePreloadModules', () => {
	let tmpDir;
	let componentsRoot;
	let pkgIndex;
	let pkgInit;

	// Lay down a components root with one component that bundles a fake APM package,
	// mirroring how an installed component vendors an instrumentation dependency.
	before(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'preload-test-'));
		componentsRoot = path.join(tmpDir, 'components');
		const pkgDir = path.join(componentsRoot, 'apm-component', 'node_modules', 'fake-apm');
		fs.mkdirSync(pkgDir, { recursive: true });
		pkgIndex = path.join(pkgDir, 'index.js');
		pkgInit = path.join(pkgDir, 'init.js');
		fs.writeFileSync(pkgIndex, 'module.exports = {};\n');
		fs.writeFileSync(pkgInit, 'module.exports = {};\n');
	});

	after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

	it('returns an empty array when unconfigured', () => {
		assert.deepEqual(resolvePreloadModules(null, componentsRoot), []);
	});

	it('resolves a bare package specifier from an installed component', () => {
		assert.deepEqual(resolvePreloadModules('fake-apm', componentsRoot), [pkgIndex]);
	});

	it('resolves a package subpath specifier (e.g. dd-trace/init)', () => {
		assert.deepEqual(resolvePreloadModules('fake-apm/init', componentsRoot), [pkgInit]);
	});

	it('accepts an array of specifiers, preserving order', () => {
		assert.deepEqual(resolvePreloadModules(['fake-apm', 'fake-apm/init'], componentsRoot), [pkgIndex, pkgInit]);
	});

	it('resolves an absolute path, applying extension resolution', () => {
		const extensionless = pkgIndex.replace(/\.js$/, '');
		assert.deepEqual(resolvePreloadModules(extensionless, componentsRoot), [pkgIndex]);
	});

	it('skips an unresolvable specifier without throwing', () => {
		assert.deepEqual(resolvePreloadModules(['does-not-exist', 'fake-apm'], componentsRoot), [pkgIndex]);
	});

	it('ignores non-string entries in an array', () => {
		assert.deepEqual(resolvePreloadModules(['fake-apm', 42, null, ''], componentsRoot), [pkgIndex]);
	});

	it('rejects relative-path specifiers (non-deterministic resolution)', () => {
		assert.deepEqual(resolvePreloadModules('./fake-apm/index.js', componentsRoot), []);
	});

	it('does not throw when the components root is missing or unreadable', () => {
		assert.deepEqual(resolvePreloadModules(pkgIndex, path.join(tmpDir, 'no-such-dir')), [pkgIndex]);
	});
});
