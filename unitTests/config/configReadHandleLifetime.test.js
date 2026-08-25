const assert = require('node:assert');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { mkdtempSync, writeFileSync, rmSync, mkdirSync } = require('node:fs');
const { once } = require('node:events');
const { stringify } = require('yaml');
const { RootConfigWatcher } = require('#src/config/RootConfigWatcher');
const { OptionsWatcher } = require('#src/components/OptionsWatcher');
const { HARPER_CONFIG_FILE } = require('#src/utility/hdbTerms');

/**
 * `atomicWriteFile` replaces the root config by rename-over and retries with a blocking sleep.
 * On Windows that rename fails while any descriptor is open on the destination, and the sleep
 * blocks the event loop that would close one — so a root-config read that outlives the turn it
 * started in makes every retry fail and `set_configuration` return 500 (harper#2313).
 *
 * These tests pin the lifetime rather than the platform rule: a root-config read must be
 * complete by the time the change handler returns. They fail on a `fsPromises.readFile`
 * implementation on every platform.
 */
describe('root config read handle lifetime', () => {
	let fixture;
	let configFilePath;
	let previousRootPath;
	const openWatchers = [];

	beforeEach(() => {
		fixture = mkdtempSync(join(tmpdir(), 'harper.unit-test.config-read-lifetime-'));
		configFilePath = join(fixture, HARPER_CONFIG_FILE);
		writeFileSync(configFilePath, stringify({ 'test-component': { enabled: true } }));
		previousRootPath = process.env.ROOTPATH;
		process.env.ROOTPATH = fixture;
	});

	afterEach(async () => {
		await Promise.all(openWatchers.splice(0).map((watcher) => watcher.close()));
		if (previousRootPath === undefined) delete process.env.ROOTPATH;
		else process.env.ROOTPATH = previousRootPath;
		rmSync(fixture, { recursive: true, force: true });
	});

	it('RootConfigWatcher applies a change before handleChange returns', async () => {
		const watcher = new RootConfigWatcher();
		openWatchers.push(watcher);
		await watcher.ready;

		writeFileSync(configFilePath, stringify({ 'test-component': { enabled: false } }));
		watcher.handleChange();

		assert.deepStrictEqual(
			watcher.config,
			{ 'test-component': { enabled: false } },
			'the config must be re-read before control returns, or the descriptor outlives the turn'
		);
	});

	it('RootConfigWatcher swallows a read failure without throwing into the watcher callback', async () => {
		const watcher = new RootConfigWatcher();
		openWatchers.push(watcher);
		await watcher.ready;

		rmSync(configFilePath);
		assert.doesNotThrow(() => watcher.handleChange());
		assert.deepStrictEqual(watcher.config, { 'test-component': { enabled: true } });

		writeFileSync(configFilePath, ': not: valid: yaml:');
		assert.doesNotThrow(() => watcher.handleChange());
		assert.deepStrictEqual(watcher.config, { 'test-component': { enabled: true } });
	});

	it('RootConfigWatcher recovers a change it first observed as a half-written file', async () => {
		// A synchronous read can catch an in-place writer between its truncate and its write, and
		// chokidar may emit nothing further for that write — so an unusable read must be retried
		// rather than dropped, or the watcher serves stale config indefinitely.
		const watcher = new RootConfigWatcher();
		openWatchers.push(watcher);
		await watcher.ready;

		writeFileSync(configFilePath, '');
		watcher.handleChange();
		assert.deepStrictEqual(watcher.config, { 'test-component': { enabled: true } }, 'must not adopt an empty read');

		const changes = [];
		watcher.on('change', (config) => changes.push(config));
		writeFileSync(configFilePath, stringify({ 'test-component': { enabled: false } }));
		await once(watcher, 'change');
		await new Promise((resolve) => setTimeout(resolve, 100));
		// The count is not pinned: the armed re-read and chokidar's own event for the same write
		// race, and this watcher has never diffed. What must hold is that no emit carries the
		// half-written snapshot.
		assert.ok(changes.length > 0);
		for (const config of changes) assert.deepStrictEqual(config, { 'test-component': { enabled: false } });
		assert.deepStrictEqual(watcher.config, { 'test-component': { enabled: false } });
	});

	it('RootConfigWatcher stops re-reading a file that never becomes usable', async () => {
		const watcher = new RootConfigWatcher();
		openWatchers.push(watcher);
		await watcher.ready;

		writeFileSync(configFilePath, '');
		for (let attempt = 0; attempt < 20; attempt++) watcher.handleChange();
		await new Promise((resolve) => setTimeout(resolve, 400));

		assert.deepStrictEqual(watcher.config, { 'test-component': { enabled: true } });
	});

	it('OptionsWatcher recovers a root-config read that failed for a reason other than absence', async () => {
		const watcher = new OptionsWatcher('test-component', configFilePath, undefined, true);
		openWatchers.push(watcher);
		await watcher.ready;

		const errors = [];
		watcher.on('error', (error) => errors.push(error));
		// A directory in the file's place fails the read with EISDIR, standing in for the
		// transient replace-under-us failures Windows produces; the change must not be dropped.
		rmSync(configFilePath);
		mkdirSync(configFilePath);
		watcher._handleChangeForTests();
		assert.deepStrictEqual(errors, [], 'a recoverable read failure must not surface as an error');

		rmSync(configFilePath, { recursive: true });
		writeFileSync(configFilePath, stringify({ 'test-component': { enabled: false } }));
		await once(watcher, 'change');
		assert.strictEqual(watcher.get(['enabled']), false);
	});

	it('OptionsWatcher applies a root-config change before the change handler returns', async () => {
		const watcher = new OptionsWatcher('test-component', configFilePath, undefined, true);
		openWatchers.push(watcher);
		await watcher.ready;

		writeFileSync(configFilePath, stringify({ 'test-component': { enabled: false } }));
		watcher._handleChangeForTests();

		assert.strictEqual(watcher.get(['enabled']), false);
	});

	it('OptionsWatcher recovers an application config observed mid-write instead of removing it', async () => {
		const appConfigPath = join(fixture, 'config.yaml');
		writeFileSync(appConfigPath, stringify({ 'test-component': { enabled: true } }));
		const watcher = new OptionsWatcher('test-component', appConfigPath, undefined, false);
		openWatchers.push(watcher);
		await watcher.ready;

		const removes = [];
		watcher.on('remove', () => removes.push(true));
		writeFileSync(appConfigPath, '');
		watcher._handleChangeForTests();
		await new Promise((resolve) => setImmediate(resolve));
		assert.deepStrictEqual(removes, [], 'a half-written read must not read as the scope being removed');
		assert.strictEqual(watcher.get(['enabled']), true);

		writeFileSync(appConfigPath, stringify({ 'test-component': { enabled: false } }));
		await once(watcher, 'change');
		assert.strictEqual(watcher.get(['enabled']), false);
	});

	it('RootConfigWatcher treats a document that parses to nothing as incomplete', async () => {
		const watcher = new RootConfigWatcher();
		openWatchers.push(watcher);
		await watcher.ready;

		// A truncated write can leave a document that reads fine and parses to null.
		writeFileSync(configFilePath, '\n');
		watcher.handleChange();
		assert.deepStrictEqual(watcher.config, { 'test-component': { enabled: true } });
	});

	it('OptionsWatcher still reads an application config without blocking', async () => {
		// Application configs are written in place, never by rename-over, so they must keep the
		// non-blocking read — a slow or stalled component-config volume must not stall the thread.
		const appConfigPath = join(fixture, 'config.yaml');
		writeFileSync(appConfigPath, stringify({ 'test-component': { enabled: true } }));
		const watcher = new OptionsWatcher('test-component', appConfigPath, undefined, false);
		openWatchers.push(watcher);
		await watcher.ready;

		writeFileSync(appConfigPath, stringify({ 'test-component': { enabled: false } }));
		const changed = once(watcher, 'change');
		watcher._handleChangeForTests();

		assert.strictEqual(watcher.get(['enabled']), true, 'application config reads must not be synchronous');
		await changed;
		assert.strictEqual(watcher.get(['enabled']), false);
	});
});
