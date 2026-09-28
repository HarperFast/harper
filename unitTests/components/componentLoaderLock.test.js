'use strict';

// Regression test for #3184.
//
// sequentiallyHandleApplication (components/componentLoader.ts) used to serialize
// handleApplication with Status.primaryStore.tryLock keyed by scope.pluginName alone. pluginName
// is the plugin type (jsResource, graphqlSchema, ...), shared by every application that declares
// that plugin, so one application hanging inside its handleApplication held the lock for all of
// them and their loads failed with "Timeout waiting for lock on <plugin>" despite being
// independent. The invariant pinned here: the lock is scoped per (application, plugin), so a
// slow or hung load in one application never blocks or fails another application's load of the
// same plugin.
//
// The plugin itself is synthetic, registered in TRUSTED_RESOURCE_PLUGINS the same way
// componentLoader.test.js registers scopeEnsureTablePlugin, so the hang is deterministic. The
// path under test is the real one: loadComponent -> Scope -> sequentiallyHandleApplication with
// the real Status.primaryStore lock and real config-driven timeouts.

const assert = require('node:assert');
const path = require('node:path');
const { tmpdir } = require('node:os');
const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require('node:fs');
const testUtils = require('../testUtils.js');
testUtils.preTestPrep();

const { loadComponent, TRUSTED_RESOURCE_PLUGINS } = require('#src/components/componentLoader');
const { resetResources } = require('#src/resources/Resources');
const { internal: statusInternal } = require('#src/components/status/index');
const { waitFor } = require('../waitFor.js');

const PLUGIN_NAME = 'lockIsolationProbe';
const HOG_APP = 'lock-hog-app';
const BYSTANDER_APP = 'lock-bystander-app';
// The hog's handleApplication hangs until released, holding the plugin lock for its whole 30s
// timeout window. The bystander's budget is its own 500ms timeout plus the loader's fixed 5s
// lock-acquisition grace, so on a shared lock it times out long before the hog lets go, while
// on a per-application lock it never waits at all.
const HOG_TIMEOUT_MS = 30000;
const BYSTANDER_TIMEOUT_MS = 500;

describe('componentLoader per-application plugin lock isolation', () => {
	let tempRoot;
	let resources;
	let releaseHog;
	let hogRunning = false;
	let hogLoad;
	let hogLoadSettled = false;
	const completedApps = [];
	// Collected so cleanup can close each scope's OptionsWatcher before removing tempRoot:
	// on Windows, deleting a still-watched directory surfaces chokidar's uncaught
	// "EPERM: operation not permitted, watch" and fails the after hook.
	const collectedScopes = new Set();

	before(() => {
		tempRoot = mkdtempSync(path.join(tmpdir(), 'harper-component-lock-isolation-'));
		resources = resetResources();
		const hogReleased = new Promise((resolve) => (releaseHog = resolve));
		TRUSTED_RESOURCE_PLUGINS[PLUGIN_NAME] = {
			handleApplication(scope) {
				if (scope.appName === HOG_APP) {
					hogRunning = true;
					return hogReleased;
				}
				completedApps.push(scope.appName);
			},
		};
	});

	after(async () => {
		// Let the hog finish so its load settles cleanly before teardown; on the red path this also
		// releases the bystander's parked lock waiter.
		if (typeof releaseHog === 'function') releaseHog();
		if (hogLoad) await hogLoad.catch(() => {});
		for (const scope of collectedScopes) await scope.close().catch(() => {});
		delete TRUSTED_RESOURCE_PLUGINS[PLUGIN_NAME];
		statusInternal.componentStatusRegistry.reset();
		if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
	});

	function makeApp(name, timeoutMs) {
		const dir = path.join(tempRoot, name);
		mkdirSync(dir, { recursive: true });
		writeFileSync(path.join(dir, 'config.yaml'), `${PLUGIN_NAME}:\n  timeout: ${timeoutMs}\n`);
		return dir;
	}

	it("one application's slow plugin load does not block another application's load of the same plugin", async () => {
		const hogDir = makeApp(HOG_APP, HOG_TIMEOUT_MS);
		const bystanderDir = makeApp(BYSTANDER_APP, BYSTANDER_TIMEOUT_MS);

		hogLoad = loadComponent(hogDir, resources, 'test-origin', {
			isRoot: false,
			appName: HOG_APP,
			collectScopes: collectedScopes,
		});
		hogLoad.then(
			() => (hogLoadSettled = true),
			() => (hogLoadSettled = true)
		);
		await waitFor(() => hogRunning || hogLoadSettled, {
			timeout: 10000,
			message: "the hog's handleApplication never started",
		});
		assert.strictEqual(hogLoadSettled, false, 'fixture guard: the hog load must be parked inside handleApplication');

		const startedAt = Date.now();
		await loadComponent(bystanderDir, resources, 'test-origin', {
			isRoot: false,
			appName: BYSTANDER_APP,
			collectScopes: collectedScopes,
		});
		const elapsedMs = Date.now() - startedAt;

		// loadComponent contains per-component failures instead of rejecting, so the verdict lives in
		// the component status registry and in whether the plugin actually ran for the bystander.
		const status = statusInternal.componentStatusRegistry.getStatus(`${BYSTANDER_APP}.${PLUGIN_NAME}`);
		const failureText = String(status?.error?.message ?? status?.message ?? '');
		assert.ok(
			!failureText.includes('Timeout waiting for lock'),
			`the bystander's load waited on the hog application's plugin lock: ${failureText}`
		);
		assert.strictEqual(
			status?.status,
			'healthy',
			`the bystander's plugin should load while the hog hangs, got '${status?.status}': ${failureText}`
		);
		assert.deepStrictEqual(
			completedApps,
			[BYSTANDER_APP],
			"the bystander's handleApplication should run to completion"
		);
		assert.strictEqual(
			hogLoadSettled,
			false,
			'fixture guard: the hog must still be holding its lock when the bystander finishes'
		);
		assert.ok(elapsedMs < 5000, `the bystander should load within its own timeout budget, took ${elapsedMs}ms`);
	});
});
