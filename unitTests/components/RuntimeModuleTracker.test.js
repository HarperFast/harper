'use strict';

const assert = require('node:assert');
const { mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { pathToFileURL } = require('node:url');
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

	it('detects a new higher-priority extensionless resolution candidate', async () => {
		const referrerPath = join(this.directory, 'resources.js');
		const jsonPath = join(this.directory, 'helper.json');
		writeFileSync(referrerPath, 'import helper from "./helper";');
		writeFileSync(jsonPath, '{}');
		this.tracker.recordModule(pathToFileURL(jsonPath).href, '{}');
		this.tracker.recordResolution('./helper', pathToFileURL(referrerPath).href, pathToFileURL(jsonPath).href);

		this.tracker.beginDeploy();
		writeFileSync(join(this.directory, 'helper.js'), 'export default {};');
		assert.equal(await this.tracker.finishDeploy(), true);
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
