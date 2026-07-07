const assert = require('node:assert');
const sinon = require('sinon');
const path = require('node:path');
const { tmpdir } = require('node:os');
const { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } = require('node:fs');

// Exercises the extension-package `node_modules` walk in loadComponent (the non-root
// `package:` resolution path). Regression coverage for the ROOTPATH-relative walk bug
// (#1507): an app run via RUN_HDB_APP from outside ROOTPATH must reach packages hoisted
// to a monorepo root even when that root's path is shorter than ROOTPATH, while
// components inside ROOTPATH must still stop at the ROOTPATH boundary.
//
// HARPER_SAFE_MODE is set so the walk runs and resolves componentPath, but the recursive
// loadComponent() of the resolved package is skipped — isolating the resolution logic
// from actually loading a (fake) package module.
describe('ComponentLoader node_modules walk (#1507)', function () {
	let componentLoader;
	let lifecycle;
	let sandbox;
	let baseDir;
	let originalBasePath;
	let originalSafeMode;
	const env = require('#src/utility/environment/environmentManager');

	// One extension config key; the walk looks for node_modules/<key>, so the directory
	// created under node_modules must match this name (key === package name, as in the
	// real `@harperfast/nextjs` symptom).
	const PKG = 'test-hoisted-ext';
	const CONFIG = `${PKG}:\n  package: ${PKG}\n`;

	function makeApp(appDir) {
		mkdirSync(appDir, { recursive: true });
		writeFileSync(path.join(appDir, 'harperdb-config.yaml'), CONFIG);
		return appDir;
	}

	function makeHoistedPackage(nodeModulesParent) {
		const pkgDir = path.join(nodeModulesParent, 'node_modules', PKG);
		mkdirSync(pkgDir, { recursive: true });
		return pkgDir;
	}

	async function load(appDir) {
		await componentLoader.loadComponent(appDir, { isWorker: true, set: sinon.stub() }, 'test-origin');
		return `${path.basename(appDir)}.${PKG}`;
	}

	function loadedFor(statusName) {
		return lifecycle.loaded.getCalls().filter((c) => c.args[0] === statusName);
	}
	function failedFor(statusName) {
		return lifecycle.failed.getCalls().filter((c) => c.args[0] === statusName);
	}

	before(function () {
		sandbox = sinon.createSandbox();
		const statusModule = require('#src/components/status/index');
		lifecycle = statusModule.lifecycle;
		sandbox.spy(lifecycle, 'loading');
		sandbox.spy(lifecycle, 'loaded');
		sandbox.spy(lifecycle, 'failed');

		componentLoader = require('#src/components/componentLoader');

		baseDir = mkdtempSync(path.join(tmpdir(), 'harper-walk-'));
		originalBasePath = env.getHdbBasePath();
		originalSafeMode = process.env.HARPER_SAFE_MODE;
		process.env.HARPER_SAFE_MODE = '1';
	});

	after(function () {
		sandbox.restore();
		env.setHdbBasePath(originalBasePath);
		if (originalSafeMode === undefined) delete process.env.HARPER_SAFE_MODE;
		else process.env.HARPER_SAFE_MODE = originalSafeMode;
		if (baseDir && existsSync(baseDir)) rmSync(baseDir, { recursive: true, force: true });
	});

	beforeEach(function () {
		lifecycle.loading.resetHistory();
		lifecycle.loaded.resetHistory();
		lifecycle.failed.resetHistory();
	});

	it('resolves a monorepo-root hoisted package when the app runs outside ROOTPATH (the bug)', async function () {
		// ROOTPATH is long; the monorepo checkout is short — the exact shape that tripped the
		// old `containerFolder.length < getHdbBasePath().length` heuristic.
		env.setHdbBasePath(path.join(baseDir, 'install', 'x'.repeat(80), 'hdb'));

		const repo = path.join(baseDir, 'monorepo');
		const appDir = makeApp(path.join(repo, 'apps', 'web'));
		makeHoistedPackage(repo); // repo/node_modules/test-hoisted-ext

		assert.ok(
			path.join(repo, 'apps').length < env.getHdbBasePath().length,
			'precondition: the walked-up parent is shorter than ROOTPATH (reproduces the old heuristic abort)'
		);

		const statusName = await load(appDir);

		assert.equal(failedFor(statusName).length, 0, 'package outside ROOTPATH should resolve, not fail');
		assert.equal(
			loadedFor(statusName).length,
			1,
			'component should be marked loaded after resolving the hoisted package'
		);
	});

	it('walks to the filesystem root and fails gracefully when an outside-ROOTPATH package is genuinely absent', async function () {
		env.setHdbBasePath(path.join(baseDir, 'install2', 'y'.repeat(80), 'hdb'));

		// App outside ROOTPATH, no hoisted package anywhere up the tree.
		const appDir = makeApp(path.join(baseDir, 'monorepo2', 'apps', 'web'));

		const statusName = await load(appDir);

		// The new dirname()-fixpoint guard must terminate the walk at the fs root (no infinite loop)
		// and report the missing package rather than hang.
		const failed = failedFor(statusName);
		assert.equal(failed.length, 1, 'missing package should mark the component failed');
		assert.match(String(failed[0].args[1]), /Unable to find package/);
	});

	it('resolves a package hoisted within ROOTPATH for a component inside ROOTPATH', async function () {
		const hdb = path.join(baseDir, 'hdb');
		env.setHdbBasePath(hdb);

		const appDir = makeApp(path.join(hdb, 'components', 'myapp'));
		makeHoistedPackage(hdb); // hdb/node_modules/test-hoisted-ext

		const statusName = await load(appDir);

		assert.equal(failedFor(statusName).length, 0, 'in-ROOTPATH package should resolve');
		assert.equal(loadedFor(statusName).length, 1);
	});

	it('does not walk above ROOTPATH for a component inside ROOTPATH (boundary preserved)', async function () {
		const hdb = path.join(baseDir, 'hdb3');
		env.setHdbBasePath(hdb);

		const appDir = makeApp(path.join(hdb, 'components', 'myapp'));
		// Package sits ABOVE ROOTPATH — the old intent was to never escape the install root.
		makeHoistedPackage(baseDir); // baseDir/node_modules/test-hoisted-ext (parent of ROOTPATH)

		const statusName = await load(appDir);

		const failed = failedFor(statusName);
		assert.equal(failed.length, 1, 'package above ROOTPATH must not be resolved by an in-ROOTPATH component');
		assert.match(String(failed[0].args[1]), /Unable to find package/);
	});
});
