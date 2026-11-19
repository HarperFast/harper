const assert = require('node:assert');
const { realpathSync } = require('node:fs');
const { dirname } = require('node:path');
const { isMainThread } = require('node:worker_threads');

describe('startSecretCustodyOnMainThread', function () {
	let componentLoader;
	let rootConfig;
	let mainThreadKey;
	let originalConfig;
	let originalPlugin;

	before(function () {
		if (!isMainThread) this.skip();
		const { getConfigObj, getConfigFilePath } = require('#src/config/configUtils');
		componentLoader = require('#src/components/componentLoader');
		rootConfig = getConfigObj();
		// the key the root load gives the root config's `secretCustody` entry
		mainThreadKey = `/secretCustody@${realpathSync(dirname(getConfigFilePath()))}`;
		originalConfig = rootConfig.secretCustody;
		originalPlugin = componentLoader.TRUSTED_RESOURCE_PLUGINS.secretCustody;
	});

	after(function () {
		if (!componentLoader) return;
		componentLoader.mainThreadInitialized.delete(mainThreadKey);
		if (originalConfig === undefined) delete rootConfig.secretCustody;
		else rootConfig.secretCustody = originalConfig;
		if (originalPlugin === undefined) delete componentLoader.TRUSTED_RESOURCE_PLUGINS.secretCustody;
		else componentLoader.TRUSTED_RESOURCE_PLUGINS.secretCustody = originalPlugin;
	});

	beforeEach(function () {
		rootConfig.secretCustody = { provider: 'file' };
		componentLoader.mainThreadInitialized.delete(mainThreadKey);
	});

	it('starts custody once with its config block, under the root load key', async function () {
		const starts = [];
		const startedModule = { started: true };
		componentLoader.TRUSTED_RESOURCE_PLUGINS.secretCustody = {
			startOnMainThread(options) {
				starts.push(options);
				return startedModule;
			},
		};

		await componentLoader.startSecretCustodyOnMainThread();
		await componentLoader.startSecretCustodyOnMainThread();

		assert.equal(starts.length, 1);
		assert.equal(starts[0].provider, 'file');
		assert.ok(starts[0].server);
		assert.equal(componentLoader.mainThreadInitialized.get(mainThreadKey), startedModule);
	});

	it('does nothing when the root config disables custody or no custody built-in is registered', async function () {
		let starts = 0;
		componentLoader.TRUSTED_RESOURCE_PLUGINS.secretCustody = {
			startOnMainThread() {
				starts++;
			},
		};
		rootConfig.secretCustody = false;
		await componentLoader.startSecretCustodyOnMainThread();
		delete rootConfig.secretCustody;
		await componentLoader.startSecretCustodyOnMainThread();
		assert.equal(starts, 0);

		rootConfig.secretCustody = {};
		delete componentLoader.TRUSTED_RESOURCE_PLUGINS.secretCustody;
		await componentLoader.startSecretCustodyOnMainThread();
		assert.equal(componentLoader.mainThreadInitialized.has(mainThreadKey), false);
	});

	it('contains a failed start and retries it on the next call', async function () {
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
		await componentLoader.startSecretCustodyOnMainThread();

		assert.equal(starts, 3);
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
		// a duplicate start would begin by now; settle every start so a regression fails rather than hangs
		await new Promise(setImmediate);
		const starts = pendingStarts.length;
		for (const finishStart of pendingStarts) finishStart({ startedBy: 'concurrent' });
		await Promise.all([first, second]);

		assert.equal(starts, 1);
		assert.equal(componentLoader.mainThreadInitialized.get(mainThreadKey)?.startedBy, 'concurrent');
	});
});
