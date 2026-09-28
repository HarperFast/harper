'use strict';

// Regression test for the status-honesty half of #3184: GTM routes on the public status
// endpoint, which serves the availability status (set_status id=availability), and a node
// whose component failed to load keeps serving errors over that component's URL space. The
// invariant: the availability the GTM path consults must stop reporting Available while a
// component is failed, and recover once it is healthy again. Asserted through server/status
// get, the function the get_status operation dispatches to (the /status HTTP route lives in
// the external status-check component). The probe plugin is registered the way
// componentLoader.test.js registers its plugins.

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
// Long enough that the throwing app never brushes its timeout, short enough that the hanging
// app's load settles quickly through withDeployAwareTimeout's rejection.
const THROWING_APP_TIMEOUT_MS = 30000;
const HANGING_APP_TIMEOUT_MS = 500;

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
		// Settle the hanging handleApplication so nothing is left parked behind teardown; guarded
		// so a failure inside before() surfaces itself instead of a TypeError from here.
		releaseHang?.();
		delete TRUSTED_RESOURCE_PLUGINS[PLUGIN_NAME];
		statusInternal.componentStatusRegistry.reset();
		await status.clear({ id: 'availability' });
		if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
	});

	function makeApp(name, timeoutMs) {
		const dir = path.join(tempRoot, name);
		mkdirSync(dir, { recursive: true });
		writeFileSync(path.join(dir, 'config.yaml'), `${PLUGIN_NAME}:\n  timeout: ${timeoutMs}\n`);
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
		// Polled rather than read once so the assertion also tolerates an asynchronous mechanism.
		await waitFor(async () => (await status.get({ id: 'availability' }))?.status === 'Unavailable', {
			timeout: 5000,
			message: `a node with a failed ${appName} load must not stay Available on the status GTM routes on`,
		});
	}

	it('a component load that throws takes the node out of Available', async () => {
		await seedInRotation();
		const appDir = makeApp(THROWING_APP, THROWING_APP_TIMEOUT_MS);
		// loadComponent contains per-component failures instead of rejecting; the verdict lives in
		// the status stores, not in this promise.
		await loadComponent(appDir, resources, 'test-origin', { isRoot: false, appName: THROWING_APP });
		await assertOutOfRotation(THROWING_APP, /synthetic component load failure/);
	});

	it('a component load that hangs into its timeout takes the node out of Available', async () => {
		await seedInRotation();
		const appDir = makeApp(HANGING_APP, HANGING_APP_TIMEOUT_MS);
		await loadComponent(appDir, resources, 'test-origin', { isRoot: false, appName: HANGING_APP });
		await assertOutOfRotation(HANGING_APP, /timed out/);
	});

	it('a node whose components are healthy again returns to the operator record', async () => {
		assert.strictEqual(
			(await status.get({ id: 'availability' }))?.status,
			'Unavailable',
			'fixture guard: the failures above must still hold the node out of rotation'
		);
		statusForComponent(`${THROWING_APP}.${PLUGIN_NAME}`).healthy('recovered');
		statusForComponent(`${HANGING_APP}.${PLUGIN_NAME}`).healthy('recovered');
		const recovered = await status.get({ id: 'availability' });
		assert.strictEqual(
			recovered?.status,
			'Available',
			'with no failed components the operator record is served as written'
		);
	});
});

// get_status runs on the operations thread, which loads components with isWorker=false and so
// never runs (or fails) handleApplication; the failure that matters happens on the HTTP workers.
// So the derivation must read the all-threads aggregate, not this thread's registry. These cases
// stub the cross-thread aggregate directly, proving a failure this thread never recorded still
// drains the node. A derivation that read only the local registry would pass every case above but
// fail here.
describe('availability derivation reads the all-threads component aggregate', () => {
	let aggregateStub;

	const setAggregate = (entries) => aggregateStub.resolves(new Map(entries));

	before(() => {
		statusInternal.componentStatusRegistry.reset();
		aggregateStub = sinon.stub(ComponentStatusRegistry, 'getAggregatedFromAllThreads');
	});

	after(async () => {
		aggregateStub.restore();
		await status.clear({ id: 'availability' });
	});

	it('drains when another thread reports a component error this thread never saw', async () => {
		await status.set({ id: 'availability', status: 'Available' });
		// Present only in the aggregate (a worker's registry), absent from this thread's registry.
		setAggregate([
			['app.jsResource', { componentName: 'app.jsResource', status: 'error', lastChecked: { workers: {} } }],
		]);
		const result = await status.get({ id: 'availability' });
		assert.strictEqual(result?.status, 'Unavailable', 'a worker-only component error must drain the node');
		assert.match(String(result?.message ?? ''), /app\.jsResource/, 'the message should name the failed component');
	});

	it('stays Available when every thread reports the component healthy', async () => {
		await status.set({ id: 'availability', status: 'Available' });
		setAggregate([
			['app.jsResource', { componentName: 'app.jsResource', status: 'healthy', lastChecked: { workers: {} } }],
		]);
		assert.strictEqual((await status.get({ id: 'availability' }))?.status, 'Available');
	});

	it('keeps an operator drain even when every component is healthy', async () => {
		await status.set({ id: 'availability', status: 'Unavailable' });
		setAggregate([
			['app.jsResource', { componentName: 'app.jsResource', status: 'healthy', lastChecked: { workers: {} } }],
		]);
		const result = await status.get({ id: 'availability' });
		assert.strictEqual(result?.status, 'Unavailable', 'an operator set_status Unavailable must win');
	});
});
