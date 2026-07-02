'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sinon = require('sinon');

const env = require('#src/utility/environment/environmentManager');
const configUtils = require('#src/config/configUtils');
const logger = require('#src/utility/logging/harper_logger');
const { CONFIG_PARAMS } = require('#src/utility/hdbTerms');
const { resolvePreloadModules } = require('#src/server/threads/resolvePreload');

describe('resolvePreloadModules', () => {
	let tmpDir;
	let componentsRoot;
	let preloadValue;

	// Lay down a components root with one component that bundles a fake APM package,
	// mirroring how an installed component vendors an instrumentation dependency.
	before(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'preload-test-'));
		componentsRoot = path.join(tmpDir, 'components');
		const pkgDir = path.join(componentsRoot, 'apm-component', 'node_modules', 'fake-apm');
		fs.mkdirSync(pkgDir, { recursive: true });
		fs.writeFileSync(path.join(pkgDir, 'index.js'), 'module.exports = {};\n');
		fs.writeFileSync(path.join(pkgDir, 'init.js'), 'module.exports = {};\n');
	});

	after(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	beforeEach(() => {
		preloadValue = undefined;
		sinon.stub(env, 'get').callsFake((param) => (param === CONFIG_PARAMS.THREADS_PRELOAD ? preloadValue : undefined));
		sinon
			.stub(configUtils, 'getConfigPath')
			.callsFake((param) => (param === CONFIG_PARAMS.COMPONENTSROOT ? componentsRoot : undefined));
	});

	afterEach(() => sinon.restore());

	it('returns an empty array when unconfigured', () => {
		preloadValue = null;
		assert.deepEqual(resolvePreloadModules(), []);
	});

	it('resolves a bare package specifier from an installed component', () => {
		preloadValue = 'fake-apm';
		const resolved = resolvePreloadModules();
		assert.deepEqual(resolved, [path.join(componentsRoot, 'apm-component', 'node_modules', 'fake-apm', 'index.js')]);
	});

	it('resolves a package subpath specifier (e.g. dd-trace/init)', () => {
		preloadValue = 'fake-apm/init';
		const resolved = resolvePreloadModules();
		assert.deepEqual(resolved, [path.join(componentsRoot, 'apm-component', 'node_modules', 'fake-apm', 'init.js')]);
	});

	it('accepts an array of specifiers, preserving order', () => {
		preloadValue = ['fake-apm', 'fake-apm/init'];
		const resolved = resolvePreloadModules();
		assert.deepEqual(resolved, [
			path.join(componentsRoot, 'apm-component', 'node_modules', 'fake-apm', 'index.js'),
			path.join(componentsRoot, 'apm-component', 'node_modules', 'fake-apm', 'init.js'),
		]);
	});

	it('resolves an existing absolute path directly', () => {
		const absPath = path.join(componentsRoot, 'apm-component', 'node_modules', 'fake-apm', 'index.js');
		preloadValue = absPath;
		assert.deepEqual(resolvePreloadModules(), [absPath]);
	});

	it('warns and skips an unresolvable specifier without throwing', () => {
		const warn = sinon.stub(logger, 'warn');
		preloadValue = ['does-not-exist', 'fake-apm'];
		const resolved = resolvePreloadModules();
		assert.deepEqual(resolved, [path.join(componentsRoot, 'apm-component', 'node_modules', 'fake-apm', 'index.js')]);
		assert.equal(warn.callCount, 1);
		assert.match(warn.firstCall.args[0], /does-not-exist/);
	});

	it('ignores non-string entries in an array', () => {
		preloadValue = ['fake-apm', 42, null, ''];
		const resolved = resolvePreloadModules();
		assert.deepEqual(resolved, [path.join(componentsRoot, 'apm-component', 'node_modules', 'fake-apm', 'index.js')]);
	});

	it('rejects relative-path specifiers (non-deterministic resolution)', () => {
		const warn = sinon.stub(logger, 'warn');
		preloadValue = './fake-apm/index.js';
		assert.deepEqual(resolvePreloadModules(), []);
		assert.equal(warn.callCount, 1);
	});

	it('does not throw when the components root is missing or unreadable', () => {
		configUtils.getConfigPath.restore();
		sinon
			.stub(configUtils, 'getConfigPath')
			.callsFake((param) => (param === CONFIG_PARAMS.COMPONENTSROOT ? path.join(tmpDir, 'no-such-dir') : undefined));
		// An absolute path still resolves via its own branch; the point is the readdir doesn't throw.
		const absPath = path.join(componentsRoot, 'apm-component', 'node_modules', 'fake-apm', 'index.js');
		preloadValue = absPath;
		assert.deepEqual(resolvePreloadModules(), [absPath]);
	});
});
