const assert = require('node:assert');
const sinon = require('sinon');
const path = require('node:path');
const { isMainThread } = require('node:worker_threads');
const { tmpdir } = require('node:os');
const { mkdtempSync, writeFileSync, rmSync, realpathSync } = require('node:fs');

// #2780: boot-time application installs need secret custody, which is itself a root built-in. It is started
// ahead of installApplications(), and the root load must then reuse that start rather than run it again.
describe('startSecretCustodyOnMainThread (#2780)', function () {
	before(function () {
		if (!isMainThread) this.skip();
	});

	let rootDir;
	let rootConfig;
	let componentLoader;
	let sandbox;
	let originalPlugin;
	let mainThreadKey;
	const resources = { isWorker: false, set: sinon.stub() };

	before(function () {
		sandbox = sinon.createSandbox();
		rootDir = realpathSync(mkdtempSync(path.join(tmpdir(), 'harper-custody-early-')));
		writeFileSync(path.join(rootDir, 'harper-config.yaml'), 'secretCustody: {}\n');
		mainThreadKey = `/secretCustody@${rootDir}`;

		const env = require('#src/utility/environment/environmentManager');
		sandbox.stub(env, 'get').callsFake((key) => {
			if (key === 'COMPONENTSROOT') return rootDir;
			if (key === 'CLUSTERING_ENABLED') return false;
			if (key === 'MAX_HEADER_SIZE') return 8192;
			if (key === 'HTTP_PORT') return 9925;
			if (key === 'CUSTOM_FUNCTIONS') return false;
			return undefined;
		});
		const configUtils = require('#src/config/configUtils');
		sandbox.stub(configUtils, 'getConfigObj').callsFake(() => rootConfig);
		sandbox.stub(configUtils, 'getConfigFilePath').returns(path.join(rootDir, 'harper-config.yaml'));
		// the root load would otherwise start a process-wide watcher on the (temporary) root config
		sandbox.stub(require('#src/resources/models/bootstrap'), 'startModelsConfigHotReload').returns(false);

		componentLoader = require('#src/components/componentLoader');
		originalPlugin = componentLoader.TRUSTED_RESOURCE_PLUGINS.secretCustody;
	});

	after(function () {
		sandbox.restore();
		if (originalPlugin === undefined) delete componentLoader.TRUSTED_RESOURCE_PLUGINS.secretCustody;
		else componentLoader.TRUSTED_RESOURCE_PLUGINS.secretCustody = originalPlugin;
		rmSync(rootDir, { recursive: true, force: true });
	});

	beforeEach(function () {
		rootConfig = { secretCustody: { provider: 'file' } };
		componentLoader.mainThreadInitialized.delete(mainThreadKey);
		componentLoader.loadedPaths.delete(rootDir);
	});

	it('starts custody with its config block, and the root load reuses that start', async function () {
		const starts = [];
		componentLoader.TRUSTED_RESOURCE_PLUGINS.secretCustody = {
			startOnMainThread(options) {
				starts.push(options);
				return { startedBy: 'early' };
			},
		};

		await componentLoader.startSecretCustodyOnMainThread();
		assert.equal(starts.length, 1);
		assert.equal(starts[0].provider, 'file');
		assert.ok(starts[0].server, 'the hook receives the server');
		assert.equal(componentLoader.mainThreadInitialized.get(mainThreadKey)?.startedBy, 'early');

		await componentLoader.loadComponent(rootDir, resources, 'hdb', { isRoot: true });
		assert.equal(starts.length, 1, 'the root load must not start custody a second time');

		await componentLoader.startSecretCustodyOnMainThread();
		assert.equal(starts.length, 1, 'a later boot pass (restart) must not start it again either');
	});

	it('does nothing when the root config disables custody or no custody built-in is registered', async function () {
		let starts = 0;
		componentLoader.TRUSTED_RESOURCE_PLUGINS.secretCustody = {
			startOnMainThread() {
				starts++;
			},
		};
		rootConfig = { secretCustody: false };
		await componentLoader.startSecretCustodyOnMainThread();
		rootConfig = {};
		await componentLoader.startSecretCustodyOnMainThread();
		assert.equal(starts, 0);

		rootConfig = { secretCustody: {} };
		delete componentLoader.TRUSTED_RESOURCE_PLUGINS.secretCustody;
		await componentLoader.startSecretCustodyOnMainThread();
		assert.equal(componentLoader.mainThreadInitialized.has(mainThreadKey), false);
	});

	it('contains a failed start and leaves it for the next load to retry', async function () {
		let starts = 0;
		componentLoader.TRUSTED_RESOURCE_PLUGINS.secretCustody = {
			startOnMainThread() {
				starts++;
				if (starts === 1) throw new Error('sync custody failure');
				if (starts === 2) return Promise.reject(new Error('async custody failure'));
				return { startedOn: starts };
			},
		};

		await componentLoader.startSecretCustodyOnMainThread();
		assert.equal(componentLoader.mainThreadInitialized.has(mainThreadKey), false);
		await componentLoader.startSecretCustodyOnMainThread();
		assert.equal(componentLoader.mainThreadInitialized.has(mainThreadKey), false);

		await componentLoader.loadComponent(rootDir, resources, 'hdb', { isRoot: true });
		assert.equal(starts, 3, 'the root load retries the failed start');
		assert.equal(componentLoader.mainThreadInitialized.get(mainThreadKey)?.startedOn, 3);
	});

	it('runs one start for concurrent callers', async function () {
		const pendingStarts = [];
		componentLoader.TRUSTED_RESOURCE_PLUGINS.secretCustody = {
			startOnMainThread() {
				return new Promise((resolve) => pendingStarts.push(resolve));
			},
		};

		const first = componentLoader.startSecretCustodyOnMainThread();
		const second = componentLoader.startSecretCustodyOnMainThread();
		while (pendingStarts.length === 0) await new Promise(setImmediate);
		// a duplicate start would begin within these turns; settle every start so a regression fails, not hangs
		await new Promise(setImmediate);
		const starts = pendingStarts.length;
		for (const finishStart of pendingStarts) finishStart({ startedBy: 'concurrent' });
		await Promise.all([first, second]);
		assert.equal(starts, 1);
		assert.equal(componentLoader.mainThreadInitialized.get(mainThreadKey)?.startedBy, 'concurrent');
	});
});
