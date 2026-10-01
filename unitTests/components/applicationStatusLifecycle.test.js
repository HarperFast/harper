'use strict';

const assert = require('node:assert');
const path = require('path');
const { tmpdir } = require('os');
const { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } = require('fs');

const testUtils = require('../testUtils.js');
testUtils.preTestPrep();

const { internal, STATUS } = require('#src/components/status/index');
const { loadComponent, loadComponentDirectories, forgetLoadedPath } = require('#src/components/componentLoader');
const configUtils = require('#src/config/configUtils');
const { CONFIG_PARAMS } = require('#src/utility/hdbTerms');

// The whole-application status entry must tell the truth across the application's life: a load
// failure is recorded under the application's name, a later clean load heals it, a nested
// component's failure is not papered over as processed, and a removed application's last status
// does not outlive it. harperdb#3184 was the observable cost of these entries lying.
describe('whole-application status lifecycle', () => {
	const registry = internal.componentStatusRegistry;
	const resources = { isWorker: true, set() {} };
	let tempDir;

	before(() => {
		tempDir = mkdtempSync(path.join(tmpdir(), 'harper-app-status-'));
	});

	after(() => {
		if (tempDir && existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
	});

	function makeApp(name, configText) {
		const dir = path.join(tempDir, name);
		mkdirSync(dir, { recursive: true });
		writeFileSync(path.join(dir, 'config.yaml'), configText);
		return dir;
	}

	it('records a whole-application load failure under the application name', async () => {
		const dir = makeApp('broken-app', 'branchedDatabases: [data]\n');

		await loadComponent(dir, resources, 'test-origin', { isRoot: false, appName: 'broken-app' });

		const status = registry.getStatus('broken-app');
		assert.ok(status, 'the application has a status entry');
		assert.strictEqual(status.status, STATUS.ERROR);
		assert.match(String(status.error?.message ?? status.error), /branchedDatabases/);
	});

	it('heals the entry when the next load cycle succeeds', async () => {
		const dir = path.join(tempDir, 'broken-app');
		writeFileSync(path.join(dir, 'config.yaml'), '# nothing to load\n');
		forgetLoadedPath(dir);

		await loadComponent(dir, resources, 'test-origin', { isRoot: false, appName: 'broken-app' });

		assert.strictEqual(registry.getStatus('broken-app').status, STATUS.HEALTHY);
	});

	it('keeps a nested package failure on its scoped key instead of reporting it processed', async () => {
		const dir = makeApp('host-app', 'badpkg:\n  package: badpkg\n');
		const nestedDir = path.join(dir, 'node_modules', 'badpkg');
		mkdirSync(nestedDir, { recursive: true });
		writeFileSync(path.join(nestedDir, 'config.yaml'), 'branchedDatabases: [data]\n');

		await loadComponent(dir, resources, 'test-origin', { isRoot: false, appName: 'host-app' });

		const nested = registry.getStatus('host-app.badpkg');
		assert.ok(nested, 'the nested component has a status entry');
		assert.strictEqual(nested.status, STATUS.ERROR, 'the nested failure is recorded, not marked processed');
		// The failure stays scoped to the component that failed; the application's own load cycle
		// completed, which is what its entry reports.
		assert.strictEqual(registry.getStatus('host-app').status, STATUS.HEALTHY);
	});

	it('retires exact and scoped keys, leaving similarly prefixed names alone', () => {
		registry.setStatus('dead-app', STATUS.ERROR, 'load failed', 'boom');
		registry.setStatus('dead-app.rest', STATUS.ERROR, 'plugin failed', 'boom');
		registry.setStatus('dead-apple', STATUS.HEALTHY, 'unrelated');

		registry.retire('dead-app');

		assert.strictEqual(registry.getStatus('dead-app'), undefined);
		assert.strictEqual(registry.getStatus('dead-app.rest'), undefined);
		assert.strictEqual(registry.getStatus('dead-apple').status, STATUS.HEALTHY);
	});

	it('retires a removed application on the next directory scan', async function () {
		this.timeout(20000);
		const componentsRoot = configUtils.getConfigPath(CONFIG_PARAMS.COMPONENTSROOT);
		const createdRoot = !existsSync(componentsRoot);
		mkdirSync(componentsRoot, { recursive: true });
		const doomedDir = path.join(componentsRoot, 'status-retire-probe');
		mkdirSync(doomedDir, { recursive: true });
		writeFileSync(path.join(doomedDir, 'config.yaml'), 'branchedDatabases: [data]\n');

		try {
			await loadComponentDirectories(new Map(), resources);
			assert.strictEqual(
				registry.getStatus('status-retire-probe')?.status,
				STATUS.ERROR,
				'precondition: the scan recorded the load failure'
			);

			rmSync(doomedDir, { recursive: true, force: true });
			forgetLoadedPath(doomedDir);
			await loadComponentDirectories(new Map(), resources);

			assert.strictEqual(
				registry.getStatus('status-retire-probe'),
				undefined,
				'the removed application left no status behind'
			);
		} finally {
			if (existsSync(doomedDir)) rmSync(doomedDir, { recursive: true, force: true });
			if (createdRoot) rmSync(componentsRoot, { recursive: true, force: true });
		}
	});
});
