const assert = require('node:assert/strict');
const sinon = require('sinon');
const path = require('node:path');
const { isMainThread } = require('node:worker_threads');
const { tmpdir } = require('node:os');
const { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } = require('node:fs');

// #460: `startOnMainThread` must run at most once per component for the life of the process.
// A deploy_component reload re-enters loadComponent for already-loaded components; before the fix
// the main-thread init was re-invoked every pass, accumulating watchers/routes and re-running
// destructive one-time scans (the replicator's hdb_nodes subscription scan). These tests assert
// the once-only contract holds across a reload while a brand-new component still initializes.
describe('startOnMainThread once-per-component (#460)', function () {
	// somt only runs on the main thread; if mocha ever runs this in a worker the assertions below
	// would be meaningless, so guard explicitly.
	before(function () {
		if (!isMainThread) this.skip();
	});

	let tempDir;
	let componentLoader;
	let sandbox;

	before(function () {
		sandbox = sinon.createSandbox();
		tempDir = mkdtempSync(path.join(tmpdir(), 'harper-somt-once-'));

		const env = require('#src/utility/environment/environmentManager');
		sandbox.stub(env, 'get').callsFake((key) => {
			if (key === 'COMPONENTSROOT') return tempDir;
			if (key === 'CLUSTERING_ENABLED') return false;
			if (key === 'MAX_HEADER_SIZE') return 8192;
			if (key === 'HTTP_PORT') return 9925;
			if (key === 'CUSTOM_FUNCTIONS') return false;
			return '';
		});

		const configUtils = require('#js/config/configUtils');
		sandbox.stub(configUtils, 'getConfigObj').returns({});

		componentLoader = require('#src/components/componentLoader');
	});

	after(function () {
		sandbox.restore();
		if (tempDir && existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
	});

	// Create a component directory whose harper-config.yaml declares a single trusted plugin we
	// register on the fly, returning its name + dir for cleanup and assertions.
	function makeComponent(dirName, pluginName) {
		const componentDir = path.join(tempDir, dirName);
		mkdirSync(componentDir, { recursive: true });
		writeFileSync(path.join(componentDir, 'harperdb-config.yaml'), `${pluginName}: {}`);
		return componentDir;
	}

	it('runs startOnMainThread once across a reload of an existing component, and once for a newly-added component', async function () {
		const pluginA = 'somtOncePluginA';
		const pluginB = 'somtOncePluginB';
		const dirA = makeComponent('somt-once-a', pluginA);
		const dirB = makeComponent('somt-once-b', pluginB);

		let somtA = 0;
		let somtB = 0;
		const exportedResource = { marker: 'A-init' };

		componentLoader.TRUSTED_RESOURCE_PLUGINS[pluginA] = {
			startOnMainThread() {
				somtA++;
				// Return a replacement module to verify the skip reuses the post-somt result.
				return { ...exportedResource, somtRunCount: somtA };
			},
		};
		componentLoader.TRUSTED_RESOURCE_PLUGINS[pluginB] = {
			startOnMainThread() {
				somtB++;
			},
		};

		const resources = { isWorker: false, set: sinon.stub() };

		try {
			// First boot: only component A exists yet.
			await componentLoader.loadComponent(dirA, resources, 'origin');
			assert.equal(somtA, 1, 'A.startOnMainThread should run on first load');

			// Simulate the reload re-entry: the production reload path re-invokes loadComponent for
			// already-loaded components. loadedPaths is cleared on that path (and on worker
			// re-import), so clearing it here reproduces the field condition that previously caused
			// startOnMainThread to re-run.
			componentLoader.loadedPaths.clear();

			// Reload of A (already initialized) AND first load of newly-added B in the same pass.
			await componentLoader.loadComponent(dirA, resources, 'origin');
			await componentLoader.loadComponent(dirB, resources, 'origin');

			assert.equal(somtA, 1, 'A.startOnMainThread must NOT re-run on reload (once-only contract)');
			assert.equal(somtB, 1, 'B.startOnMainThread must still run for a newly-added component');

			// One more reload to confirm the gate holds across repeated reloads.
			componentLoader.loadedPaths.clear();
			await componentLoader.loadComponent(dirA, resources, 'origin');
			await componentLoader.loadComponent(dirB, resources, 'origin');
			assert.equal(somtA, 1, 'A.startOnMainThread stays at one across repeated reloads');
			assert.equal(somtB, 1, 'B.startOnMainThread stays at one across repeated reloads');

			// The skip must reuse the post-somt module (the value returned by the first somt call),
			// so downstream wiring is preserved rather than reverting to the pre-init plugin object.
			const keyA = `${path.basename(dirA)}/${pluginA}@${require('node:fs').realpathSync(dirA)}`;
			const storedA = componentLoader.mainThreadInitialized.get(keyA);
			assert.equal(storedA.marker, 'A-init', 'stored module is the post-somt result');
			assert.equal(storedA.somtRunCount, 1, 'stored module reflects the single somt run');
		} finally {
			delete componentLoader.TRUSTED_RESOURCE_PLUGINS[pluginA];
			delete componentLoader.TRUSTED_RESOURCE_PLUGINS[pluginB];
		}
	});

	it('does not gate (cache) components that have no startOnMainThread, so they keep their fresh module on reload', async function () {
		// A component whose plugin exports a setup handler but no startOnMainThread has no one-time
		// main-thread hook. It must not be entered into the gate, so a reload keeps using the
		// freshly loaded module rather than a stale cached one (Codex P2).
		const pluginC = 'somtlessPluginC';
		const dirC = makeComponent('somtless-c', pluginC);

		componentLoader.TRUSTED_RESOURCE_PLUGINS[pluginC] = {
			// no startOnMainThread; a setup-only handler must not be entered into the gate
			setupDirectory() {},
		};

		const resources = { isWorker: false, set: sinon.stub() };
		try {
			await componentLoader.loadComponent(dirC, resources, 'origin');
			componentLoader.loadedPaths.clear();
			await componentLoader.loadComponent(dirC, resources, 'origin');

			const keyC = `${path.basename(dirC)}/${pluginC}@${require('node:fs').realpathSync(dirC)}`;
			assert.equal(
				componentLoader.mainThreadInitialized.has(keyC),
				false,
				'a component without startOnMainThread must not be entered into the once-only gate'
			);
		} finally {
			delete componentLoader.TRUSTED_RESOURCE_PLUGINS[pluginC];
		}
	});
});
