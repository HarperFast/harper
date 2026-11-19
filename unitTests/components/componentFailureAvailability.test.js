'use strict';

// With status.drainOnLoadFailure on, the availability GTM routes on (get_status id=availability) must
// read Unavailable while any thread's loader has a component recorded as failed, and return to the
// operator's record once the component loads again. Off, the stored record is served as on main.

const assert = require('node:assert');
const path = require('node:path');
const { tmpdir } = require('node:os');
const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require('node:fs');
const testUtils = require('../testUtils.js');
testUtils.preTestPrep();

const { loadComponent, loadedPaths, TRUSTED_RESOURCE_PLUGINS } = require('#src/components/componentLoader');
const { resetResources } = require('#src/resources/Resources');
const { internal: statusInternal } = require('#src/components/status/index');
const env = require('#src/utility/environment/environmentManager');
const { CONFIG_PARAMS } = require('#src/utility/hdbTerms');
const status = require('#src/server/status/index');
const { waitFor } = require('../waitFor.js');

const { componentStatusRegistry, crossThreadCollector } = statusInternal;
const setDrain = (value) => env.setProperty(CONFIG_PARAMS.STATUS_DRAINONLOADFAILURE, value);
const availability = () => status.get({ id: 'availability' });

describe('availability with drainOnLoadFailure, through the real loader', () => {
	const PLUGIN_NAME = 'availabilityProbePlugin';
	const THROWING_APP = 'availability-throwing-app';
	const HANGING_APP = 'availability-hanging-app';
	let tempRoot;
	let resources;
	let releaseHang;
	let failLoads = true;

	before(() => {
		componentStatusRegistry.reset();
		setDrain(true);
		tempRoot = mkdtempSync(path.join(tmpdir(), 'harper-availability-drain-'));
		resources = resetResources();
		const hangReleased = new Promise((resolve) => (releaseHang = resolve));
		TRUSTED_RESOURCE_PLUGINS[PLUGIN_NAME] = {
			handleApplication(scope) {
				if (!failLoads) return;
				if (scope.appName === HANGING_APP) return hangReleased;
				throw new Error('synthetic component load failure');
			},
		};
	});

	afterEach(() => status.resetLoaderFailuresCache());

	after(async () => {
		releaseHang?.();
		delete TRUSTED_RESOURCE_PLUGINS[PLUGIN_NAME];
		componentStatusRegistry.reset();
		setDrain(undefined);
		status.resetLoaderFailuresCache();
		await status.clear({ id: 'availability' });
		if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
	});

	function makeApp(name, timeout) {
		const dir = path.join(tempRoot, name);
		mkdirSync(dir, { recursive: true });
		writeFileSync(path.join(dir, 'config.yaml'), `${PLUGIN_NAME}:\n  timeout: ${timeout}\n`);
		return dir;
	}

	const load = (appName, timeout) =>
		loadComponent(makeApp(appName, timeout), resources, 'test-origin', { isRoot: false, appName });

	async function assertDrained(appName, failurePattern) {
		const recorded = componentStatusRegistry.getStatus(`${appName}.${PLUGIN_NAME}`);
		assert.strictEqual(recorded?.status, 'error', `fixture guard: ${appName} must fail through the loader`);
		assert.strictEqual(recorded?.source, 'loader');
		assert.match(String(recorded?.error?.message ?? recorded?.message), failurePattern);
		status.resetLoaderFailuresCache();
		const result = await availability();
		assert.strictEqual(result?.status, 'Unavailable');
		assert.match(result.message, new RegExp(`${appName}\\.${PLUGIN_NAME}`));
	}

	it('a component load that throws takes the node out of Available', async () => {
		await status.set({ id: 'availability', status: 'Available' });
		await load(THROWING_APP, 30000);
		await assertDrained(THROWING_APP, /synthetic component load failure/);
	});

	it('a component load that hangs into its timeout takes the node out of Available', async () => {
		await load(HANGING_APP, 500);
		await assertDrained(HANGING_APP, /timed out/);
	});

	it('returns to the operator record once the failed components load successfully', async () => {
		failLoads = false;
		releaseHang();
		for (const key of loadedPaths.keys()) if (key.includes('harper-availability-drain-')) loadedPaths.delete(key);
		await load(THROWING_APP, 30000);
		await load(HANGING_APP, 30000);
		await waitFor(
			async () => {
				status.resetLoaderFailuresCache();
				return (await availability())?.status === 'Available';
			},
			{ timeout: 5000, message: 'a successful reload must lift the derived drain' }
		);
	});
});

describe('availability with drainOnLoadFailure, judged per thread', () => {
	let collections = 0;
	let threadStatuses = [];
	const entry = (status, source) => ({ status, source, lastChecked: new Date() });

	before(() => {
		componentStatusRegistry.reset();
		crossThreadCollector.collect = async () => {
			collections++;
			return new Map(threadStatuses);
		};
	});

	beforeEach(async () => {
		setDrain(true);
		collections = 0;
		threadStatuses = [];
		status.resetLoaderFailuresCache();
		await status.set({ id: 'availability', status: 'Available' });
	});

	afterEach(async () => {
		setDrain(undefined);
		status.resetLoaderFailuresCache();
		await status.clear({ id: 'availability' });
	});

	after(() => {
		delete crossThreadCollector.collect;
	});

	it('drains on a load failure only another thread recorded', async () => {
		threadStatuses = [
			['app.jsResource@main', entry('healthy', 'loader')],
			['app.jsResource@worker-1', entry('error', 'loader')],
		];
		const result = await availability();
		assert.strictEqual(result?.status, 'Unavailable');
		assert.strictEqual(result.message, 'Failed to load: app.jsResource');
	});

	for (const order of ['forward', 'reverse']) {
		it(`ignores a runtime error beside another thread's successful load (${order})`, async () => {
			threadStatuses = [
				['app.jsResource@worker-1', entry('error', 'explicit')],
				['app.jsResource@worker-2', entry('healthy', 'loader')],
			];
			if (order === 'reverse') threadStatuses.reverse();
			assert.strictEqual((await availability())?.status, 'Available');
		});

		it(`drains on a load failure beside another thread's runtime report (${order})`, async () => {
			threadStatuses = [
				['app.jsResource@worker-1', entry('error', 'loader')],
				['app.jsResource@worker-2', entry('healthy', 'explicit')],
			];
			if (order === 'reverse') threadStatuses.reverse();
			assert.strictEqual((await availability())?.status, 'Unavailable');
		});
	}

	it('ignores log problems, health checks and component-reported errors', async () => {
		threadStatuses = [
			['database.write-queue-overloaded@worker-1', entry('error', 'log')],
			['system.memory@main', entry('error', 'health-check')],
			['app.upstream@worker-1', entry('error', 'explicit')],
			['app.jsResource@worker-1', entry('loading', 'loader')],
		];
		assert.strictEqual((await availability())?.status, 'Available');
	});

	it('serves the stored record without collecting when the setting is off', async () => {
		setDrain(undefined);
		threadStatuses = [['app.jsResource@worker-1', entry('error', 'loader')]];
		assert.strictEqual((await availability())?.status, 'Available');
		assert.strictEqual(collections, 0);
	});

	it("keeps an operator's Unavailable without collecting", async () => {
		await status.set({ id: 'availability', status: 'Unavailable' });
		assert.strictEqual((await availability())?.status, 'Unavailable');
		assert.strictEqual(collections, 0);
	});

	it('derives Unavailable when no availability record is stored', async () => {
		await status.clear({ id: 'availability' });
		assert.strictEqual((await availability())?.status, undefined);
		status.resetLoaderFailuresCache();
		threadStatuses = [['app.jsResource@worker-1', entry('error', 'loader')]];
		assert.strictEqual((await availability())?.status, 'Unavailable');
	});

	it('shares one collection across concurrent and repeated reads within the TTL', async () => {
		threadStatuses = [['app.jsResource@worker-1', entry('error', 'loader')]];
		const reads = await Promise.all([availability(), availability(), availability()]);
		assert.deepStrictEqual(
			reads.map((record) => record?.status),
			['Unavailable', 'Unavailable', 'Unavailable']
		);
		threadStatuses = [];
		assert.strictEqual((await availability())?.status, 'Unavailable', 'served from the cache');
		assert.strictEqual(collections, 1);
	});

	it('the no-id response carries the same derived availability from one collection', async () => {
		await status.set({ id: 'primary', status: 'testing' });
		threadStatuses = [['app.jsResource@worker-1', entry('error', 'loader')]];
		const all = await status.get({});
		assert.strictEqual(collections, 1);
		assert.strictEqual(all.componentStatus.find((component) => component.name === 'app.jsResource')?.status, 'error');
		const serialized = JSON.parse(JSON.stringify(all.systemStatus));
		assert.ok(Array.isArray(serialized));
		assert.strictEqual(serialized.find((record) => record.id === 'availability')?.status, 'Unavailable');
		assert.strictEqual(serialized.find((record) => record.id === 'primary')?.status, 'testing');
		await status.clear({ id: 'primary' });
	});
});
