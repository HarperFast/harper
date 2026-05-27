const assert = require('node:assert/strict');
const { RootConfigWatcher } = require('#src/config/RootConfigWatcher');
const { tmpdir } = require('node:os');
const { once } = require('node:events');
const { join } = require('node:path');
const { writeFileSync, mkdtempSync, rmSync, renameSync } = require('node:fs');
const { writeFile } = require('node:fs/promises');
const { replace, fake, restore, spy } = require('sinon');
const configUtils = require('#js/config/configUtils');
const { stringify } = require('yaml');

describe('RootConfigWatcher', () => {
	beforeEach(() => {
		this.fixture = mkdtempSync(join(tmpdir(), 'harper.unit-test.root-config-watcher-'));
		this.configFilePath = join(this.fixture, 'config.yaml');
		replace(configUtils, 'getConfigFilePath', fake.returns(this.configFilePath));
	});

	afterEach(() => {
		restore();
		rmSync(this.fixture, { recursive: true, force: true });
	});

	it('should instantiate and watch the root Harper config file', async () => {
		const expected = { foo: 'bar' };
		writeFileSync(this.configFilePath, stringify(expected));
		const configWatcher = new RootConfigWatcher();

		assert.ok(
			configWatcher instanceof RootConfigWatcher,
			'RootConfigWatcher should be an instance of RootConfigWatcher'
		);
		assert.equal(configWatcher.config, undefined, 'RootConfigWatcher should not have a config property yet');

		const [actual] = await configWatcher.ready;

		assert.deepEqual(expected, actual, 'RootConfigWatcher should have a config property after ready() is called');

		expected.foo = 'baz';

		await writeFile(this.configFilePath, stringify(expected));

		const [updated] = await once(configWatcher, 'change');

		assert.deepEqual(updated, expected, 'RootConfigWatcher should emit a change event with the updated config');

		const closeSpy = spy();
		configWatcher.on('close', closeSpy);
		const closeReturn = configWatcher.close();

		assert.equal(closeSpy.callCount, 1, 'close() should emit a close event');
		assert.deepEqual(closeReturn, configWatcher, 'close() should return the instance of RootConfigWatcher');
		assert.equal(
			configWatcher.config,
			undefined,
			'RootConfigWatcher should not have a config property after close() is called'
		);
	});

	it('should detect changes written via temp-file + rename (atomic write)', async () => {
		const initial = { foo: 'bar' };
		writeFileSync(this.configFilePath, stringify(initial));
		const configWatcher = new RootConfigWatcher();

		const [readyValue] = await configWatcher.ready;
		assert.deepEqual(readyValue, initial, 'watcher should pick up initial config');

		const updated = { foo: 'baz' };
		const tempPath = `${this.configFilePath}.${process.pid}.${Date.now()}.tmp`;
		writeFileSync(tempPath, stringify(updated));
		renameSync(tempPath, this.configFilePath);

		const [changeValue] = await once(configWatcher, 'change');
		assert.deepEqual(changeValue, updated, 'watcher should fire change after atomic rename');

		configWatcher.close();
	});

	describe('polling fallback on watcher exhaustion', () => {
		// harper#488: when ENOSPC/EMFILE fires on the underlying chokidar
		// watcher, the RootConfigWatcher should swap to a polling watcher
		// rather than surfacing the error to consumers.

		it('falls back to polling on ENOSPC and continues to receive change events', async () => {
			const initial = { foo: 'bar' };
			writeFileSync(this.configFilePath, stringify(initial));
			const configWatcher = new RootConfigWatcher();
			await configWatcher.ready;

			const errorSpy = spy();
			configWatcher.on('error', errorSpy);

			assert.equal(configWatcher._usingPollingForTests, false);

			configWatcher._simulateWatcherErrorForTests(Object.assign(new Error('boom'), { code: 'ENOSPC' }));
			await new Promise((resolve) => setTimeout(resolve, 50));

			assert.equal(configWatcher._usingPollingForTests, true, 'should have flipped to polling');
			assert.equal(errorSpy.callCount, 0, 'ENOSPC should be swallowed');

			// Polling watcher should pick up subsequent writes; default polling
			// interval is 1s, so allow up to ~3s for the change event.
			const updated = { foo: 'after-fallback' };
			await writeFile(this.configFilePath, stringify(updated));
			const [changeValue] = await once(configWatcher, 'change');
			assert.deepEqual(changeValue, updated, 'polling watcher should fire change');

			configWatcher.close();
		}).timeout(5000);

		it('propagates non-exhaustion errors and does not fall back', async () => {
			writeFileSync(this.configFilePath, stringify({ foo: 'bar' }));
			const configWatcher = new RootConfigWatcher();
			await configWatcher.ready;

			const errorSpy = spy();
			configWatcher.on('error', errorSpy);

			configWatcher._simulateWatcherErrorForTests(Object.assign(new Error('boom'), { code: 'EACCES' }));
			await new Promise((resolve) => setTimeout(resolve, 20));

			assert.equal(configWatcher._usingPollingForTests, false);
			assert.equal(errorSpy.callCount, 1, 'non-exhaustion error should propagate');

			configWatcher.close();
		});

		it('swallows additional exhaustion errors during recovery', async () => {
			writeFileSync(this.configFilePath, stringify({ foo: 'bar' }));
			const configWatcher = new RootConfigWatcher();
			await configWatcher.ready;

			const errorSpy = spy();
			configWatcher.on('error', errorSpy);

			const enospc = () => Object.assign(new Error('boom'), { code: 'ENOSPC' });
			configWatcher._simulateWatcherErrorForTests(enospc());
			configWatcher._simulateWatcherErrorForTests(enospc());
			configWatcher._simulateWatcherErrorForTests(Object.assign(new Error('boom'), { code: 'EMFILE' }));

			await new Promise((resolve) => setTimeout(resolve, 50));

			assert.equal(configWatcher._usingPollingForTests, true);
			assert.equal(errorSpy.callCount, 0, 'all exhaustion errors should be swallowed');

			configWatcher.close();
		});

		it('does not reopen watcher if close() is called during recovery', async () => {
			writeFileSync(this.configFilePath, stringify({ foo: 'bar' }));
			const configWatcher = new RootConfigWatcher();
			await configWatcher.ready;

			assert.equal(configWatcher._openCountForTests, 1, 'one initial open');

			configWatcher._simulateWatcherErrorForTests(Object.assign(new Error('boom'), { code: 'ENOSPC' }));
			configWatcher.close();

			await new Promise((resolve) => setTimeout(resolve, 100));

			assert.equal(configWatcher._openCountForTests, 1, 'reopen must be suppressed by the close-during-fallback guard');
		});
	});
});
