'use strict';

// Regression test for the status-honesty half of #3184: GTM routes on the public status endpoint,
// which serves the availability status (set_status id=availability), and a node whose component
// failed to load keeps serving errors over that component's URL space. The invariant: the
// availability the GTM path consults must stop reporting Available while a component is failed, and
// recover once it is healthy again. Asserted through server/status get, the function the get_status
// operation dispatches to (the /status HTTP route lives in the external status-check component).
//
// Component health comes from the all-threads aggregate (get_status runs on the operations thread,
// which never runs handleApplication, so a worker's load failure is only visible across threads),
// cached so it is not a cross-thread round trip on every poll. Tests reset that cache to read a fresh
// aggregate. The probe plugin is registered the way componentLoader.test.js registers its plugins.

const assert = require('node:assert');
const path = require('node:path');
const { tmpdir } = require('node:os');
const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require('node:fs');
const sinon = require('sinon');
const testUtils = require('../testUtils.js');
testUtils.preTestPrep();

const { loadComponent, TRUSTED_RESOURCE_PLUGINS } = require('#src/components/componentLoader');
const { resetResources } = require('#src/resources/Resources');
const { internal: statusInternal, statusForComponent } = require('#src/components/status/index');
const { ComponentStatusRegistry } = statusInternal;
const status = require('#src/server/status/index');
const { waitFor } = require('../waitFor.js');

const PLUGIN_NAME = 'availabilityProbePlugin';
const THROWING_APP = 'availability-throwing-app';
const HANGING_APP = 'availability-hanging-app';
const PACKAGE_APP = 'availability-package-app';
// Long enough that the throwing app never brushes its timeout, short enough that the hanging app's
// load settles quickly through withDeployAwareTimeout's rejection.
const THROWING_APP_TIMEOUT_MS = 30000;
const HANGING_APP_TIMEOUT_MS = 500;

// The availability read caches the aggregate; reset it so each read re-aggregates the current state.
const availability = async () => {
	status.resetComponentHealthCache();
	return status.get({ id: 'availability' });
};

describe('availability status after component load failure', () => {
	let tempRoot;
	let resources;
	let releaseHang;

	before(() => {
		// Earlier suites in a combined run may leave component errors behind; this suite owns the
		// registry while it runs so the recovery assertions are deterministic.
		statusInternal.componentStatusRegistry.reset();
		tempRoot = mkdtempSync(path.join(tmpdir(), 'harper-availability-honesty-'));
		resources = resetResources();
		const hangReleased = new Promise((resolve) => (releaseHang = resolve));
		TRUSTED_RESOURCE_PLUGINS[PLUGIN_NAME] = {
			handleApplication(scope) {
				if (scope.appName === HANGING_APP) return hangReleased;
				throw new Error('synthetic component load failure');
			},
		};
	});

	after(async () => {
		// Settle the hanging handleApplication so nothing is left parked behind teardown; guarded so a
		// failure inside before() surfaces itself instead of a TypeError from here.
		releaseHang?.();
		delete TRUSTED_RESOURCE_PLUGINS[PLUGIN_NAME];
		statusInternal.componentStatusRegistry.reset();
		await status.clear({ id: 'availability' });
		if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
	});

	function makeApp(name, contents) {
		const dir = path.join(tempRoot, name);
		mkdirSync(dir, { recursive: true });
		writeFileSync(path.join(dir, 'config.yaml'), contents);
		return dir;
	}

	// The node starts in rotation, exactly as the rejoin tooling leaves it.
	const seedInRotation = () => status.set({ id: 'availability', status: 'Available' });

	async function assertOutOfRotation(appName, failurePattern) {
		const componentStatus = statusInternal.componentStatusRegistry.getStatus(`${appName}.${PLUGIN_NAME}`);
		assert.strictEqual(
			componentStatus?.status,
			'error',
			`fixture guard: the ${appName} load must fail through the real loader path, got '${componentStatus?.status}'`
		);
		const failureText = String(componentStatus?.error?.message ?? componentStatus?.message ?? '');
		assert.match(failureText, failurePattern, `fixture guard: the ${appName} load must fail the intended way`);
		await waitFor(async () => (await availability())?.status === 'Unavailable', {
			timeout: 5000,
			message: `a node with a failed ${appName} load must not stay Available on the status GTM routes on`,
		});
	}

	it('a component load that throws takes the node out of Available', async () => {
		await seedInRotation();
		const appDir = makeApp(THROWING_APP, `${PLUGIN_NAME}:\n  timeout: ${THROWING_APP_TIMEOUT_MS}\n`);
		// loadComponent contains per-component failures instead of rejecting; the verdict lives in the
		// status stores, not in this promise.
		await loadComponent(appDir, resources, 'test-origin', { isRoot: false, appName: THROWING_APP });
		await assertOutOfRotation(THROWING_APP, /synthetic component load failure/);
	});

	it('a component load that hangs into its timeout takes the node out of Available', async () => {
		await seedInRotation();
		const appDir = makeApp(HANGING_APP, `${PLUGIN_NAME}:\n  timeout: ${HANGING_APP_TIMEOUT_MS}\n`);
		await loadComponent(appDir, resources, 'test-origin', { isRoot: false, appName: HANGING_APP });
		await assertOutOfRotation(HANGING_APP, /timed out/);
	});

	it('a node whose components are healthy again returns to the operator record', async () => {
		assert.strictEqual(
			(await availability())?.status,
			'Unavailable',
			'fixture guard: the failures above must still hold the node out of rotation'
		);
		statusForComponent(`${THROWING_APP}.${PLUGIN_NAME}`).healthy('recovered');
		statusForComponent(`${HANGING_APP}.${PLUGIN_NAME}`).healthy('recovered');
		assert.strictEqual(
			(await availability())?.status,
			'Available',
			'with no failed components the operator record is served as written'
		);
	});

	it('a whole-application load failure (recorded under its directory) drains and heals', async () => {
		await seedInRotation();
		// branchedDatabases in a non-root component's own config is a whole-application load failure
		// (thrown before the plugin loop), exercising loadComponent's outer catch. It is keyed by the
		// application's own directory, distinct from any nested load, so nothing clobbers it.
		const appDir = makeApp(PACKAGE_APP, 'branchedDatabases:\n  - data\n');
		await loadComponent(appDir, resources, 'test-origin', { isRoot: false, appName: PACKAGE_APP });
		assert.strictEqual(
			statusInternal.componentStatusRegistry.getStatus(PACKAGE_APP)?.status,
			'error',
			'a whole-application failure must be recorded under the application directory'
		);
		await waitFor(async () => (await availability())?.status === 'Unavailable', {
			timeout: 5000,
			message: 'a whole-application failure must drain the node',
		});
		statusForComponent(PACKAGE_APP).healthy('recovered');
		assert.strictEqual((await availability())?.status, 'Available', 'clearing the application error heals the node');
	});
});

// get_status runs on the operations thread, which never runs handleApplication, so a worker's load
// failure never touches this thread's registry; the availability read must consult the all-threads
// aggregate. These cases stub the aggregate (as status.test.js stubs this same method) to stand in
// for a worker's error, proving a failure this thread never recorded still drains the node. A read of
// only this thread's local registry would pass every case above but fail here.
describe('availability derivation reads the all-threads aggregate', () => {
	let aggregateStub;
	const setAggregate = (entries) => aggregateStub.resolves(new Map(entries));

	before(() => {
		statusInternal.componentStatusRegistry.reset();
		aggregateStub = sinon.stub(ComponentStatusRegistry, 'getAggregatedFromAllThreads');
	});

	afterEach(async () => {
		await status.clear({ id: 'availability' });
	});

	after(() => {
		aggregateStub.restore();
	});

	it('drains when another thread reports a component error this thread never saw', async () => {
		await status.set({ id: 'availability', status: 'Available' });
		setAggregate([
			['app.jsResource', { componentName: 'app.jsResource', status: 'error', lastChecked: { workers: {} } }],
		]);
		const result = await availability();
		assert.strictEqual(result?.status, 'Unavailable', 'a worker-only component error must drain the node');
		assert.match(String(result?.message ?? ''), /app\.jsResource/, 'the message should name the failed component');
	});

	it('keeps an operator drain even when every component is healthy', async () => {
		await status.set({ id: 'availability', status: 'Unavailable' });
		setAggregate([
			['app.jsResource', { componentName: 'app.jsResource', status: 'healthy', lastChecked: { workers: {} } }],
		]);
		assert.strictEqual((await availability())?.status, 'Unavailable', 'an operator set_status Unavailable must win');
	});

	it('the no-id get_status response resolves availability the same way as the single-id read', async () => {
		await status.set({ id: 'availability', status: 'Available' });
		setAggregate([
			['app.jsResource', { componentName: 'app.jsResource', status: 'error', lastChecked: { workers: {} } }],
		]);
		status.resetComponentHealthCache();
		const all = await status.get({});
		const records = [];
		for await (const record of all.systemStatus) records.push(record);
		const availabilityRecord = records.find((record) => record.id === 'availability');
		assert.strictEqual(
			availabilityRecord?.status,
			'Unavailable',
			'systemStatus must reflect the derived availability, not the raw stored record'
		);
	});
});

// A removed application's stale error must stop draining the node: it is no longer serving, and an
// operator set_status Available cannot override a component error. loadComponentDirectories retires
// the status of directory applications that disappear between load cycles; this exercises that
// retirement's effect on the availability read directly through the registry.
describe('a removed application stops draining the node', () => {
	before(() => statusInternal.componentStatusRegistry.reset());

	after(async () => {
		statusInternal.componentStatusRegistry.reset();
		await status.clear({ id: 'availability' });
	});

	it('retiring a failed application clears its drain', async () => {
		await status.set({ id: 'availability', status: 'Available' });
		statusInternal.componentStatusRegistry.markFailed('removed-app', new Error('bad config'), 'failed to load');
		assert.strictEqual((await availability())?.status, 'Unavailable', 'a failed application drains the node');
		statusInternal.componentStatusRegistry.retire('removed-app');
		assert.strictEqual(
			(await availability())?.status,
			'Available',
			'once the removed application is retired, the node rejoins rotation'
		);
	});
});
