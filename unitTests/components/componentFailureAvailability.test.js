'use strict';

const assert = require('node:assert');
const path = require('node:path');
const { tmpdir } = require('node:os');
const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require('node:fs');
const testUtils = require('../testUtils.js');
testUtils.preTestPrep();

const { loadComponent, loadedPaths, TRUSTED_RESOURCE_PLUGINS } = require('#src/components/componentLoader');
const { resetResources } = require('#src/resources/Resources');
const configUtils = require('#src/config/configUtils');
const { internal: statusInternal, statusForComponent } = require('#src/components/status/index');
const env = require('#src/utility/environment/environmentManager');
const { CONFIG_PARAMS } = require('#src/utility/hdbTerms');
const status = require('#src/server/status/index');
const { waitFor } = require('../waitFor.js');

const { componentStatusRegistry } = statusInternal;
const PLUGIN_NAME = 'availabilityProbePlugin';
const THROWING_APP = 'availability-throwing-app';
const HANGING_APP = 'availability-hanging-app';

const availability = () => {
	status.resetLoadFailuresCache();
	return status.get({ id: 'availability' });
};

describe('availability with drainOnLoadFailure, through the real loader', () => {
	const behaviors = new Map();
	let tempRoot;
	let resources;
	let releaseHang;

	before(async () => {
		componentStatusRegistry.reset();
		env.setProperty(CONFIG_PARAMS.STATUS_DRAINONLOADFAILURE, true);
		tempRoot = mkdtempSync(path.join(tmpdir(), 'harper-availability-drain-'));
		resources = resetResources();
		behaviors.set(THROWING_APP, 'throw');
		behaviors.set(HANGING_APP, new Promise((resolve) => (releaseHang = resolve)));
		TRUSTED_RESOURCE_PLUGINS[PLUGIN_NAME] = {
			handleApplication(scope) {
				const behavior = behaviors.get(scope.appName);
				if (behavior === 'throw') throw new Error('synthetic component load failure');
				return behavior;
			},
		};
		await status.set({ id: 'availability', status: 'Available' });
	});

	after(async () => {
		releaseHang?.();
		delete TRUSTED_RESOURCE_PLUGINS[PLUGIN_NAME];
		componentStatusRegistry.reset();
		env.setProperty(CONFIG_PARAMS.STATUS_DRAINONLOADFAILURE, undefined);
		status.resetLoadFailuresCache();
		await status.clear({ id: 'availability' });
		if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
	});

	function load(appName, timeout) {
		const dir = path.join(tempRoot, appName);
		mkdirSync(dir, { recursive: true });
		writeFileSync(path.join(dir, 'config.yaml'), `${PLUGIN_NAME}:\n  timeout: ${timeout}\n`);
		for (const key of loadedPaths.keys()) if (key.endsWith(appName)) loadedPaths.delete(key);
		return loadComponent(dir, resources, 'test-origin', { isRoot: false, appName });
	}

	async function assertDrainedBy(appName, failurePattern) {
		const recorded = componentStatusRegistry.getStatus(`${appName}.${PLUGIN_NAME}`);
		assert.strictEqual(recorded?.loadFailed, true, `fixture guard: ${appName} must fail through the loader`);
		assert.match(String(recorded.error?.message ?? recorded.message), failurePattern);
		const result = await availability();
		assert.strictEqual(result?.status, 'Unavailable');
		assert.match(result.message, new RegExp(`${appName}\\.${PLUGIN_NAME}`));
	}

	it('a component load that throws takes the node out of Available', async () => {
		await load(THROWING_APP, 30000);
		await assertDrainedBy(THROWING_APP, /synthetic component load failure/);
	});

	it('a component load that hangs into its timeout takes the node out of Available', async () => {
		await load(HANGING_APP, 500);
		await assertDrainedBy(HANGING_APP, /timed out/);
	});

	it('stays out after a timed-out component reports itself healthy', async () => {
		statusForComponent(`${HANGING_APP}.${PLUGIN_NAME}`).healthy('background start finished');
		const result = await availability();
		assert.strictEqual(result?.status, 'Unavailable');
		assert.match(result.message, new RegExp(`${HANGING_APP}\\.${PLUGIN_NAME}`));
	});

	it('stays out while a retry is still loading, and returns once every component loads', async () => {
		let releaseRetry;
		behaviors.set(THROWING_APP, new Promise((resolve) => (releaseRetry = resolve)));
		const retry = load(THROWING_APP, 30000);
		await waitFor(() => componentStatusRegistry.getStatus(`${THROWING_APP}.${PLUGIN_NAME}`)?.status === 'loading', {
			timeout: 5000,
			message: 'the retry must reach its loading state',
		});
		assert.strictEqual((await availability())?.status, 'Unavailable');

		releaseRetry();
		await retry;
		releaseHang();
		behaviors.delete(HANGING_APP);
		await load(HANGING_APP, 30000);
		assert.strictEqual((await availability())?.status, 'Available');
	});

	it('stays out when a root-config package application fails as a whole', async () => {
		const root = path.join(tempRoot, 'root');
		const packageDir = path.join(root, 'components', 'broken-package-app');
		mkdirSync(path.join(packageDir, 'config.yaml'), { recursive: true });
		writeFileSync(path.join(root, 'harper-config.yaml'), '');
		// Swapped in place: the native lane loads configUtils as an ES module, whose exports cannot be reassigned.
		const rootConfig = configUtils.getConfigObj();
		const savedRootConfig = { ...rootConfig };
		const replaceRootConfig = (entries) => {
			for (const key of Object.keys(rootConfig)) delete rootConfig[key];
			Object.assign(rootConfig, entries);
		};
		replaceRootConfig({ 'broken-package-app': { package: 'broken-package-app' } });
		try {
			await loadComponent(root, resources, 'test-origin', { isRoot: true });
		} finally {
			replaceRootConfig(savedRootConfig);
		}
		assert.strictEqual(componentStatusRegistry.getStatus('broken-package-app')?.loadFailed, true);
		const result = await availability();
		assert.strictEqual(result?.status, 'Unavailable');
		assert.match(result.message, /broken-package-app/);
	});
});
