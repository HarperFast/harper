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

describe('whole-application status lifecycle', () => {
	const registry = internal.componentStatusRegistry;
	const resources = { isWorker: true, set() {} };
	let tempDir;
	let componentsRoot;
	let createdRoot;

	before(() => {
		tempDir = mkdtempSync(path.join(tmpdir(), 'harper-app-status-'));
		componentsRoot = configUtils.getConfigPath(CONFIG_PARAMS.COMPONENTSROOT);
		createdRoot = !existsSync(componentsRoot);
		mkdirSync(componentsRoot, { recursive: true });
	});

	after(() => {
		if (tempDir && existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
		if (createdRoot && existsSync(componentsRoot)) rmSync(componentsRoot, { recursive: true, force: true });
	});

	function makeApp(baseDir, name, configText) {
		const dir = path.join(baseDir, name);
		mkdirSync(dir, { recursive: true });
		writeFileSync(path.join(dir, 'config.yaml'), configText);
		return dir;
	}

	it('records a whole-application load failure under the application name', async () => {
		const dir = makeApp(tempDir, 'broken-app', 'branchedDatabases: [data]\n');

		await loadComponent(dir, resources, 'test-origin', { isRoot: false, appName: 'broken-app' });

		const status = registry.getStatus('broken-app');
		assert.ok(status, 'the application has a status entry');
		assert.strictEqual(status.status, STATUS.ERROR);
		assert.match(String(status.error?.message ?? status.error), /branchedDatabases/);
	});

	it('heals a failed application on the next directory scan, with no manual cache reset', async function () {
		this.timeout(20000);
		const dir = makeApp(componentsRoot, 'heal-probe', 'branchedDatabases: [data]\n');

		try {
			await loadComponentDirectories(new Map(), resources);
			assert.strictEqual(
				registry.getStatus('heal-probe')?.status,
				STATUS.ERROR,
				'precondition: the scan recorded the load failure'
			);

			writeFileSync(path.join(dir, 'config.yaml'), '# nothing to load\n');
			await loadComponentDirectories(new Map(), resources);

			assert.strictEqual(registry.getStatus('heal-probe').status, STATUS.HEALTHY);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it('keeps a nested package failure on its scoped key instead of reporting it processed', async () => {
		const dir = makeApp(tempDir, 'host-app', 'badpkg:\n  package: badpkg\n');
		const nestedDir = path.join(dir, 'node_modules', 'badpkg');
		mkdirSync(nestedDir, { recursive: true });
		writeFileSync(path.join(nestedDir, 'config.yaml'), 'branchedDatabases: [data]\n');

		await loadComponent(dir, resources, 'test-origin', { isRoot: false, appName: 'host-app' });

		const nested = registry.getStatus('host-app.badpkg');
		assert.ok(nested, 'the nested component has a status entry');
		assert.strictEqual(nested.status, STATUS.ERROR, 'the nested failure is recorded, not marked processed');
		assert.strictEqual(registry.getStatus('host-app').status, STATUS.HEALTHY);
	});

	it('scopes a doubly nested failure under the full application key path', async () => {
		const dir = makeApp(tempDir, 'deep-app', 'midpkg:\n  package: midpkg\n');
		const midDir = path.join(dir, 'node_modules', 'midpkg');
		mkdirSync(midDir, { recursive: true });
		writeFileSync(path.join(midDir, 'config.yaml'), 'leafpkg:\n  package: leafpkg\n');
		const leafDir = path.join(midDir, 'node_modules', 'leafpkg');
		mkdirSync(leafDir, { recursive: true });
		writeFileSync(path.join(leafDir, 'config.yaml'), 'branchedDatabases: [data]\n');

		await loadComponent(dir, resources, 'test-origin', { isRoot: false, appName: 'deep-app' });

		assert.strictEqual(registry.getStatus('deep-app.midpkg.leafpkg')?.status, STATUS.ERROR);
		assert.strictEqual(registry.getStatus('leafpkg'), undefined, 'no entry escapes to an unscoped key');

		registry.retire('deep-app');
		assert.strictEqual(registry.getStatus('deep-app.midpkg.leafpkg'), undefined);
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
		const doomedDir = makeApp(componentsRoot, 'status-retire-probe', 'branchedDatabases: [data]\n');

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
		}
	});
});
