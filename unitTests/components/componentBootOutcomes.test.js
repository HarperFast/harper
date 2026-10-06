'use strict';

// What a worker held for certification reports about its boot load (server/threads/heldStart.ts reads it). The loader
// is the real one, loading the real components root of this unit run.

const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs/promises');

const testUtils = require('../testUtils.js');
testUtils.preTestPrep();

const { withComponentPreparationLock } = require('#src/components/componentPreparationLock');
const { internal: statusInternal } = require('#src/components/status/index');
const { getConfigPath } = require('#src/config/configUtils');
const { CONFIG_PARAMS } = require('#src/utility/hdbTerms');
const { waitFor } = require('../waitFor.js');

const LOADER = require.resolve('#src/components/componentLoader');

describe("a held worker's boot outcomes", function () {
	this.timeout(20000);
	let componentLoader;
	let componentsRoot;
	let sharedLoader;
	const created = [];

	// The loader resolves its components root once, as it loads, and a suite before this one may have moved the root
	// since: this suite loads an instance of its own, so the root it writes is the root that instance reads.
	before(async () => {
		componentsRoot = getConfigPath(CONFIG_PARAMS.COMPONENTSROOT);
		await fs.mkdir(componentsRoot, { recursive: true });
		sharedLoader = require.cache[LOADER];
		delete require.cache[LOADER];
		componentLoader = require('#src/components/componentLoader');
	});

	after(() => {
		if (sharedLoader) require.cache[LOADER] = sharedLoader;
		else delete require.cache[LOADER];
	});
	const plugins = [];
	let refusedStarts;

	function plugin(name, implementation) {
		componentLoader.TRUSTED_RESOURCE_PLUGINS[name] = implementation;
		plugins.push(name);
	}

	async function component(name, configYaml) {
		const dir = path.join(componentsRoot, name);
		await fs.mkdir(dir, { recursive: true });
		await fs.writeFile(path.join(dir, 'config.yaml'), configYaml);
		created.push(dir);
		return dir;
	}

	function loadAll(failClosed) {
		return componentLoader.loadComponentDirectories(
			new Map(),
			{ isWorker: true, set() {} },
			new WeakMap(),
			undefined,
			failClosed
		);
	}

	beforeEach(() => {
		refusedStarts = 0;
		plugin('bootLoadsProbe', { start() {} });
		plugin('bootThrowsProbe', {
			start() {
				throw new Error('threw at load');
			},
		});
		plugin('bootRefusedProbe', { start: () => refusedStarts++ });
	});

	afterEach(async () => {
		for (const name of plugins.splice(0)) delete componentLoader.TRUSTED_RESOURCE_PLUGINS[name];
		componentLoader.loadedPaths.clear();
		componentLoader.trackBootOutcomes([]);
		for (const dir of created.splice(0)) await fs.rm(dir, { recursive: true, force: true });
		statusInternal.componentStatusRegistry.reset();
	});

	it('reports what each tracked application did, and refuses one that failed closed', async () => {
		await component('boot-loads-probe', 'bootLoadsProbe: {}\n');
		await component('boot-throws-probe', 'bootThrowsProbe: {}\n');
		await component('boot-refused-probe', 'bootRefusedProbe: {}\n');
		await component('boot-untracked-probe', 'bootLoadsProbe: {}\n');
		const refusal = new Error('release d2 of boot-refused-probe was rejected');
		componentLoader.trackBootOutcomes(['boot-loads-probe', 'boot-throws-probe', 'boot-refused-probe', 'boot-missing']);

		await loadAll(new Map([['boot-refused-probe', refusal]]));

		assert.deepStrictEqual(componentLoader.bootVerdictOf('boot-loads-probe'), { outcome: 'loaded', failures: [] });
		const thrown = componentLoader.bootVerdictOf('boot-throws-probe');
		assert.equal(thrown.outcome, 'failed');
		assert.equal(thrown.failures.length, 1);
		assert.match(thrown.failures[0].message, /threw at load/);
		const refused = componentLoader.bootVerdictOf('boot-refused-probe');
		assert.equal(refused.outcome, 'failed');
		assert.match(refused.failures[0].message, /was rejected/);
		assert.equal(refusedStarts, 0, 'a release that failed closed runs nothing');
		const status = statusInternal.componentStatusRegistry.getStatus('boot-refused-probe');
		assert.equal(status?.status, 'error');
		assert.equal(status?.message, refusal.message, 'the status says why, not that a recovery failed');
		assert.equal(componentLoader.bootVerdictOf('boot-missing').outcome, 'absent');
		assert.equal(componentLoader.bootVerdictOf('boot-untracked-probe').outcome, 'absent');
	});

	it('reports a load that threw a primitive or a frozen error by what it threw', async () => {
		plugin('bootThrowsStringProbe', {
			start() {
				throw 'threw a string';
			},
		});
		plugin('bootThrowsFrozenProbe', {
			start() {
				throw Object.freeze(new Error('threw a frozen error'));
			},
		});
		await component('boot-string-probe', 'bootThrowsStringProbe: {}\n');
		await component('boot-frozen-probe', 'bootThrowsFrozenProbe: {}\n');
		componentLoader.trackBootOutcomes(['boot-string-probe', 'boot-frozen-probe']);

		await loadAll();

		for (const [name, message] of [
			['boot-string-probe', /due to: threw a string$/],
			['boot-frozen-probe', /due to: threw a frozen error$/],
		]) {
			const verdict = componentLoader.bootVerdictOf(name);
			assert.equal(verdict.outcome, 'failed');
			assert.match(verdict.failures[0].message, message);
		}
	});

	it('reports a component whose env declaration cannot be processed as failed, by why', async () => {
		await component('boot-env-probe', 'env:\n  - not-a-mapping\n');
		componentLoader.trackBootOutcomes(['boot-env-probe']);

		await loadAll();

		const verdict = componentLoader.bootVerdictOf('boot-env-probe');
		assert.equal(verdict.outcome, 'failed');
		assert.match(
			verdict.failures[0].message,
			/Could not load component 'boot-env-probe' due to: the 'env' config block/
		);
	});

	it('reports a load still waiting on a preparation as pending, until it runs', async () => {
		const name = 'boot-deferred-probe';
		const componentDir = path.join(componentsRoot, name);
		// An interrupted extraction its recovery can settle only under the preparation lock held below.
		const asideRoot = path.join(componentsRoot, '.deploy-aside', name);
		await fs.mkdir(path.join(asideRoot, '.in-progress-123-previous'), { recursive: true });
		await fs.writeFile(path.join(asideRoot, '.in-progress-123-previous', 'config.yaml'), 'bootLoadsProbe: {}\n');
		await fs.mkdir(componentDir, { recursive: true });
		await fs.writeFile(path.join(componentDir, 'partial'), 'partial');
		created.push(componentDir, asideRoot);
		let releasePreparation;
		let preparationHeld;
		const preparationStarted = new Promise((resolve) => (preparationHeld = resolve));
		const preparation = withComponentPreparationLock(componentDir, async () => {
			preparationHeld();
			await new Promise((resolve) => (releasePreparation = resolve));
		});
		try {
			await preparationStarted;
			componentLoader.trackBootOutcomes([name]);
			await loadAll();
			assert.equal(componentLoader.bootVerdictOf(name).outcome, 'pending');
			releasePreparation();
			await preparation;
			await waitFor(() => componentLoader.bootVerdictOf(name).outcome !== 'pending', { timeout: 5000 });
			assert.equal(componentLoader.bootVerdictOf(name).outcome, 'loaded');
		} finally {
			releasePreparation?.();
			await preparation;
		}
	});

	it('reports an application whose only component is not installed as skipped', async () => {
		await component(
			'boot-if-installed-probe',
			'nestedProbe:\n  package: boot-nested-missing-probe\n  loadComponent: if-installed\n'
		);
		componentLoader.trackBootOutcomes(['boot-if-installed-probe']);
		await loadAll();
		assert.equal(componentLoader.bootVerdictOf('boot-if-installed-probe').outcome, 'skipped');
	});
});
