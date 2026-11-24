'use strict';

// The main thread reruns the directory scan on every reload cycle without restarting, so its `loadedPaths` cache
// survives between scans the way it does here.

const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs/promises');
const os = require('node:os');

const testUtils = require('../testUtils.js');
testUtils.preTestPrep();

const { internal: statusInternal, statusForComponent, STATUS } = require('#src/components/status/index');
const configUtils = require('#src/config/configUtils');
const { CONFIG_PARAMS } = require('#src/utility/hdbTerms');
const { ComponentPreparationLockTimeoutError } = require('#js/components/componentPreparationLock');
const { waitFor } = require('../waitFor.js');

const LOADER = require.resolve('#src/components/componentLoader');

describe('application status across directory scans', function () {
	this.timeout(20000);
	const registry = statusInternal.componentStatusRegistry;
	let componentLoader;
	let componentsRoot;
	let sharedLoader;
	let starts;
	const created = [];
	const plugins = [];

	// a suite before this one may have moved the components root
	before(async () => {
		componentsRoot = configUtils.getConfigPath(CONFIG_PARAMS.COMPONENTSROOT);
		await fs.mkdir(componentsRoot, { recursive: true });
		sharedLoader = require.cache[LOADER];
		delete require.cache[LOADER];
		componentLoader = require('#src/components/componentLoader');
	});

	after(() => {
		if (sharedLoader) require.cache[LOADER] = sharedLoader;
		else delete require.cache[LOADER];
	});

	function plugin(name, implementation) {
		componentLoader.TRUSTED_RESOURCE_PLUGINS[name] = implementation;
		plugins.push(name);
	}

	async function application(name, configYaml) {
		const dir = path.join(componentsRoot, name);
		await fs.mkdir(dir, { recursive: true });
		await fs.writeFile(path.join(dir, 'config.yaml'), configYaml);
		created.push(dir);
		return dir;
	}

	async function nestedPackage(parentDir, name, configYaml) {
		const dir = path.join(parentDir, 'node_modules', name);
		await fs.mkdir(dir, { recursive: true });
		await fs.writeFile(path.join(dir, 'config.yaml'), configYaml);
		return dir;
	}

	function scan(interruptedActivationFailures) {
		return componentLoader.loadComponentDirectories(
			new Map(),
			{ isWorker: true, set() {} },
			new WeakMap(),
			interruptedActivationFailures
		);
	}

	async function outsideDirectory(configYaml) {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'harper-status-pkg-'));
		await fs.writeFile(path.join(dir, 'config.yaml'), configYaml);
		created.push(dir);
		return dir;
	}

	const statusOf = (key) => registry.getStatus(key)?.status;

	beforeEach(() => {
		starts = 0;
		plugin('statusLoadsProbe', { start: () => starts++ });
		plugin('statusThrowsProbe', {
			start() {
				throw new Error('threw at load');
			},
		});
	});

	afterEach(async () => {
		for (const name of plugins.splice(0)) delete componentLoader.TRUSTED_RESOURCE_PLUGINS[name];
		for (const dir of created.splice(0)) await fs.rm(dir, { recursive: true, force: true });
		await scan();
		componentLoader.loadedPaths.clear();
		componentLoader.trackBootOutcomes([]);
		registry.reset();
	});

	it('reports a loaded application under its own name', async () => {
		await application('status-healthy-probe', 'statusLoadsProbe: {}\n');

		await scan();

		assert.equal(statusOf('status-healthy-probe'), STATUS.HEALTHY);
		assert.equal(statusOf('status-healthy-probe.statusLoadsProbe'), STATUS.HEALTHY);
	});

	it('heals a failed application on the next scan once its config is fixed', async () => {
		const dir = await application('status-heal-probe', 'branchedDatabases: [data]\n');
		await scan();
		assert.equal(statusOf('status-heal-probe'), STATUS.ERROR, 'precondition: the failure is recorded');

		await fs.writeFile(path.join(dir, 'config.yaml'), 'statusLoadsProbe: {}\n');
		await scan();

		assert.equal(statusOf('status-heal-probe'), STATUS.HEALTHY);
		assert.equal(statusOf('status-heal-probe.statusLoadsProbe'), STATUS.HEALTHY);
	});

	it('retires a failed component the fixed config no longer declares', async () => {
		const dir = await application('status-shrink-probe', 'statusThrowsProbe: {}\n');
		await scan();
		assert.equal(statusOf('status-shrink-probe.statusThrowsProbe'), STATUS.ERROR, 'precondition');

		await fs.writeFile(path.join(dir, 'config.yaml'), 'statusLoadsProbe: {}\n');
		await scan();

		assert.equal(registry.getStatus('status-shrink-probe.statusThrowsProbe'), undefined);
		assert.equal(statusOf('status-shrink-probe.statusLoadsProbe'), STATUS.HEALTHY);
	});

	it('keeps a healthy application cached, and the health it reports itself, across scans', async () => {
		await application('status-runtime-probe', 'statusLoadsProbe: {}\n');
		await scan();
		statusForComponent('status-runtime-probe.live').error('dependency down');

		await scan();

		assert.equal(starts, 1, 'a reported runtime error does not send the application through another load');
		assert.equal(statusOf('status-runtime-probe.live'), STATUS.ERROR);
		assert.equal(statusOf('status-runtime-probe'), STATUS.HEALTHY);
	});

	it('heals a cached application once an invalid placement config is corrected', async () => {
		await application('status-place-probe', 'statusLoadsProbe: {}\n');
		const realGetConfigObj = configUtils.getConfigObj;
		try {
			await scan();
			configUtils.getConfigObj = () => ({ 'status-place-probe': { isolated: 'banana' } });
			await scan();
			assert.equal(statusOf('status-place-probe'), STATUS.ERROR, 'precondition: the refusal is recorded');
		} finally {
			configUtils.getConfigObj = realGetConfigObj;
		}

		await scan();

		assert.equal(statusOf('status-place-probe'), STATUS.HEALTHY);
	});

	it('records a nested package failure under the scoped key, not as processed', async () => {
		const dir = await application('status-host-probe', 'badpkg:\n  package: badpkg\n');
		await nestedPackage(dir, 'badpkg', 'branchedDatabases: [data]\n');

		await scan();

		assert.equal(statusOf('status-host-probe.badpkg'), STATUS.ERROR);
		assert.equal(registry.getStatus('badpkg'), undefined, 'no entry under the bare package name');
	});

	it('scopes a doubly nested failure under the whole package path', async () => {
		const dir = await application('status-deep-probe', 'midpkg:\n  package: midpkg\n');
		const midDir = await nestedPackage(dir, 'midpkg', 'leafpkg:\n  package: leafpkg\n');
		await nestedPackage(midDir, 'leafpkg', 'branchedDatabases: [data]\n');

		await scan();

		assert.equal(statusOf('status-deep-probe.midpkg.leafpkg'), STATUS.ERROR);
		assert.equal(registry.getStatus('midpkg.leafpkg'), undefined);
		assert.equal(registry.getStatus('leafpkg'), undefined);
	});

	it('heals a failed package linked in from outside the application directory', async () => {
		const dir = await application('status-linked-probe', 'linkedpkg:\n  package: linkedpkg\n');
		const packageDir = await outsideDirectory('branchedDatabases: [data]\n');
		await fs.mkdir(path.join(dir, 'node_modules'), { recursive: true });
		await fs.symlink(packageDir, path.join(dir, 'node_modules', 'linkedpkg'), 'dir');
		await scan();
		assert.equal(statusOf('status-linked-probe.linkedpkg'), STATUS.ERROR, 'precondition');

		await fs.writeFile(path.join(packageDir, 'config.yaml'), 'statusLoadsProbe: {}\n');
		await scan();

		assert.equal(statusOf('status-linked-probe.linkedpkg'), STATUS.HEALTHY);
		assert.equal(statusOf('status-linked-probe.linkedpkg.statusLoadsProbe'), STATUS.HEALTHY);
	});

	it('leaves an error a component reported over the loader failure since', async () => {
		const dir = await application('status-report-probe', 'statusThrowsProbe: {}\n');
		await scan();
		const thrown = registry.getStatus('status-report-probe.statusThrowsProbe').error;
		statusForComponent('status-report-probe.statusThrowsProbe').error('reported by the component', thrown);

		await fs.writeFile(path.join(dir, 'config.yaml'), 'statusLoadsProbe: {}\n');
		await scan();

		const reported = registry.getStatus('status-report-probe.statusThrowsProbe');
		assert.equal(reported?.status, STATUS.ERROR);
		assert.equal(reported.message, 'reported by the component');
	});

	it('ends a deferred load healthy once the application loads, not loading', async () => {
		await application('status-deferred-probe', 'statusLoadsProbe: {}\n');
		const waiting = new ComponentPreparationLockTimeoutError('preparation in progress');

		await scan(new Map([['status-deferred-probe', waiting]]));

		await waitFor(() => statusOf('status-deferred-probe') === STATUS.HEALTHY, 5000);
		assert.equal(starts, 1);
	});

	it('leaves what a cached application reported through a deferred load', async () => {
		await application('status-deferred-cached', 'statusLoadsProbe: {}\n');
		await scan();
		statusForComponent('status-deferred-cached').error('reported by the application');
		const waiting = new ComponentPreparationLockTimeoutError('preparation in progress');

		componentLoader.trackBootOutcomes(['status-deferred-cached']);

		await scan(new Map([['status-deferred-cached', waiting]]));
		await waitFor(() => componentLoader.bootVerdictOf('status-deferred-cached').outcome !== 'pending', 5000);

		assert.equal(registry.getStatus('status-deferred-cached')?.message, 'reported by the application');
		assert.equal(starts, 1, 'the cached application is not loaded again');
	});

	it('keeps a recovery failure for an application whose directory is gone', async () => {
		const dir = await application('status-recovery-probe', 'statusLoadsProbe: {}\n');
		await scan();
		await fs.rm(dir, { recursive: true, force: true });

		await scan(new Map([['status-recovery-probe', new Error('could not restore the previous release')]]));

		assert.equal(statusOf('status-recovery-probe'), STATUS.ERROR);
	});

	it('loads and reports an application recreated after it was retired', async () => {
		const dir = await application('status-return-probe', 'statusLoadsProbe: {}\n');
		await scan();
		await fs.rm(dir, { recursive: true, force: true });
		await scan();
		assert.equal(registry.getStatus('status-return-probe'), undefined, 'precondition: retired');

		await application('status-return-probe', 'statusLoadsProbe: {}\n');
		await scan();

		assert.equal(statusOf('status-return-probe'), STATUS.HEALTHY);
		assert.equal(starts, 2);
	});

	it('keeps an application whose name extends a removed or retried one', async () => {
		const shop = await application('status-shop', 'statusThrowsProbe: {}\n');
		await application('status-shop.eu', 'statusThrowsProbe: {}\n');
		await scan();
		assert.equal(statusOf('status-shop.eu.statusThrowsProbe'), STATUS.ERROR, 'precondition');

		await fs.writeFile(path.join(shop, 'config.yaml'), 'statusLoadsProbe: {}\n');
		await scan();
		assert.equal(statusOf('status-shop.eu.statusThrowsProbe'), STATUS.ERROR, 'retrying status-shop leaves it');

		await fs.rm(shop, { recursive: true, force: true });
		await scan();
		assert.equal(registry.getStatus('status-shop'), undefined);
		assert.equal(statusOf('status-shop.eu.statusThrowsProbe'), STATUS.ERROR, 'retiring status-shop leaves it');
	});

	it('retires a removed application and everything under it on the next scan', async () => {
		const dir = await application('status-retire-probe', 'statusThrowsProbe: {}\n');
		await scan();
		statusForComponent('status-retire-probe.live').warning('reported by the application');
		assert.equal(statusOf('status-retire-probe.statusThrowsProbe'), STATUS.ERROR, 'precondition');

		await fs.rm(dir, { recursive: true, force: true });
		await scan();

		assert.equal(registry.getStatus('status-retire-probe'), undefined);
		assert.equal(registry.getStatus('status-retire-probe.statusThrowsProbe'), undefined);
		assert.equal(registry.getStatus('status-retire-probe.live'), undefined);
	});
});

describe('ComponentStatusRegistry retire and remove', () => {
	const { ComponentStatusRegistry } = statusInternal;

	it('retires a component with its sub-components, leaving similarly prefixed names', () => {
		const registry = new ComponentStatusRegistry();
		registry.setStatus('dead-app', STATUS.ERROR, 'load failed', 'boom');
		registry.setStatus('dead-app.rest', STATUS.ERROR, 'plugin failed', 'boom');
		registry.setStatus('dead-apple', STATUS.HEALTHY, 'unrelated');

		registry.retire('dead-app');

		assert.equal(registry.getStatus('dead-app'), undefined);
		assert.equal(registry.getStatus('dead-app.rest'), undefined);
		assert.equal(registry.getStatus('dead-apple').status, STATUS.HEALTHY);
	});

	it('retires a component but keeps the subtrees named to keep', () => {
		const registry = new ComponentStatusRegistry();
		registry.setStatus('shop', STATUS.ERROR, 'load failed', 'boom');
		registry.setStatus('shop.rest', STATUS.HEALTHY);
		registry.setStatus('shop.eu', STATUS.HEALTHY);
		registry.setStatus('shop.eu.rest', STATUS.ERROR, 'plugin failed', 'boom');

		registry.retire('shop', ['shop.eu']);

		assert.deepEqual([...registry.getAllStatuses().keys()].sort(), ['shop.eu', 'shop.eu.rest']);
	});

	it('removes one component, leaving its sub-components', () => {
		const registry = new ComponentStatusRegistry();
		registry.setStatus('app', STATUS.ERROR, 'load failed', 'boom');
		registry.setStatus('app.rest', STATUS.HEALTHY);

		registry.remove('app');

		assert.equal(registry.getStatus('app'), undefined);
		assert.equal(registry.getStatus('app.rest').status, STATUS.HEALTHY);
	});
});
