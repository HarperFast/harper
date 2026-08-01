'use strict';

const assert = require('node:assert');
const { mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { pathToFileURL } = require('node:url');
const { createRequire, Module } = require('node:module');
const { RuntimeModuleTracker } = require('#src/components/RuntimeModuleTracker');

describe('RuntimeModuleTracker', () => {
	beforeEach(() => {
		this.directory = mkdtempSync(join(tmpdir(), 'harper-runtime-modules-'));
		this.tracker = new RuntimeModuleTracker(() => this.directory);
	});

	afterEach(() => rmSync(this.directory, { recursive: true, force: true }));

	it('detects changed and missing loaded modules but ignores unused files', async () => {
		const modulePath = join(this.directory, 'resources.js');
		writeFileSync(modulePath, 'export const value = 1;');
		this.tracker.recordModule(pathToFileURL(modulePath).href, 'export const value = 1;');

		this.tracker.beginDeploy();
		writeFileSync(join(this.directory, 'unused.js'), 'unused');
		assert.equal(await this.tracker.finishDeploy(), false);

		this.tracker.beginDeploy();
		writeFileSync(modulePath, 'export const value = 2;');
		assert.equal(await this.tracker.finishDeploy(), true);

		this.tracker.beginDeploy();
		rmSync(modulePath);
		assert.equal(await this.tracker.finishDeploy(), true);
	});

	it('compares the same raw bytes that the loader recorded', async () => {
		const modulePath = join(this.directory, 'invalid-utf8.js');
		const source = Buffer.from([0x2f, 0x2f, 0x20, 0xff, 0x0a]);
		writeFileSync(modulePath, source);
		this.tracker.recordModule(pathToFileURL(modulePath).href, source);

		this.tracker.beginDeploy();
		assert.equal(await this.tracker.finishDeploy(), false);
	});

	it('detects a new higher-priority extensionless resolution candidate', async () => {
		const referrerPath = join(this.directory, 'resources.js');
		const jsonPath = join(this.directory, 'helper.json');
		writeFileSync(referrerPath, 'import helper from "./helper";');
		writeFileSync(jsonPath, '{}');
		const initiallyResolved = createRequire(pathToFileURL(referrerPath)).resolve('./helper');
		assert.equal(initiallyResolved, jsonPath);
		this.tracker.recordModule(pathToFileURL(jsonPath).href, '{}');
		this.tracker.recordResolution('./helper', pathToFileURL(referrerPath).href, pathToFileURL(initiallyResolved).href);

		this.tracker.beginDeploy();
		writeFileSync(join(this.directory, 'helper.js'), 'export default {};');
		assert.equal(await this.tracker.finishDeploy(), true);
	});

	it('fails closed when Node resolution cache invalidation is unavailable', async () => {
		const referrerPath = join(this.directory, 'resources.js');
		const helperPath = join(this.directory, 'helper.js');
		writeFileSync(referrerPath, 'import helper from "./helper";');
		writeFileSync(helperPath, 'export default {};');
		this.tracker.recordModule(pathToFileURL(helperPath).href, 'export default {};');
		this.tracker.recordResolution('./helper', pathToFileURL(referrerPath).href, pathToFileURL(helperPath).href);

		const pathCache = Module._pathCache;
		try {
			Module._pathCache = undefined;
			this.tracker.beginDeploy();
			assert.equal(await this.tracker.finishDeploy(), true);
		} finally {
			Module._pathCache = pathCache;
		}
	});

	it('conservatively invalidates native and mixed-generation runtimes', async () => {
		this.tracker.markNativeRuntime();
		this.tracker.beginDeploy();
		assert.equal(await this.tracker.finishDeploy(), true);

		const observedTracker = new RuntimeModuleTracker(() => this.directory);
		const modulePath = join(this.directory, 'lazy.js');
		writeFileSync(modulePath, 'export default 1;');
		observedTracker.beginDeploy();
		observedTracker.recordModule(pathToFileURL(modulePath).href, 'export default 1;');
		assert.equal(await observedTracker.finishDeploy(), true);
	});

	it('ignores modules outside the deployed application root', async () => {
		const outsideDirectory = mkdtempSync(join(tmpdir(), 'harper-runtime-outside-'));
		try {
			const modulePath = join(outsideDirectory, 'shared.js');
			writeFileSync(modulePath, 'old');
			this.tracker.recordModule(pathToFileURL(modulePath).href, 'old');
			this.tracker.beginDeploy();
			writeFileSync(modulePath, 'new');
			assert.equal(await this.tracker.finishDeploy(), false);
		} finally {
			rmSync(outsideDirectory, { recursive: true, force: true });
		}
	});
});
