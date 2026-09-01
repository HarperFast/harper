const assert = require('node:assert');
const { RootConfigWatcher } = require('#src/config/RootConfigWatcher');
const { tmpdir } = require('node:os');
const { once } = require('node:events');
const { join } = require('node:path');
const { writeFileSync, mkdtempSync, rmSync, renameSync, chmodSync, readFileSync } = require('node:fs');
const { writeFile } = require('node:fs/promises');
const { setTimeout: delay } = require('node:timers/promises');
const { replace, fake, restore, spy } = require('sinon');
const chokidar = require('chokidar');
const configUtils = require('#src/config/configUtils');
const { stringify } = require('yaml');

// `function` so the suite can set a timeout: these tests await watcher events that may never
// arrive, and .mocharc.json's `timeout: 0` would let that wedge the whole run
describe('RootConfigWatcher', function () {
	this.timeout(30000);

	// `this` inside an `it(function () {...})` is mocha's Context, not the object beforeEach writes
	// the fixture onto; cases that need this.skip() read the fixture through here instead.
	const suite = this;

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

		const change = once(configWatcher, 'change');
		await writeFile(this.configFilePath, stringify(expected));

		const [updated] = await change;

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

	it('does not resolve ready before the watcher is armed', async () => {
		writeFileSync(this.configFilePath, stringify({ foo: 'bar' }));
		const configWatcher = new RootConfigWatcher();

		assert.equal(configWatcher._armedForTests, false, 'a freshly constructed watcher is not armed');
		await configWatcher.ready;

		// Callers take `ready` as "watching" and write immediately after it; see DESIGN.md,
		// "`ready` means the watcher is armed".
		assert.equal(configWatcher._armedForTests, true, 'ready must not resolve before the watcher is armed');

		configWatcher.close();
	});

	it('does not publish config staged before an arming fallback', async () => {
		writeFileSync(this.configFilePath, stringify({ foo: 'staged' }));
		const configWatcher = new RootConfigWatcher();

		configWatcher.handleChange();
		assert.deepEqual(configWatcher.config, { foo: 'staged' }, 'the pre-arm read must stage the first config');
		rmSync(this.configFilePath);

		const [value] = await configWatcher.ready;

		assert.strictEqual(value, undefined, 'an arming fallback must not publish the superseded staged config');
		assert.strictEqual(configWatcher.config, undefined, 'the watcher must settle without a loaded config');
		configWatcher.close();
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
		const change = once(configWatcher, 'change');
		renameSync(tempPath, this.configFilePath);

		const [changeValue] = await change;
		assert.deepEqual(changeValue, updated, 'watcher should fire change after atomic rename');

		configWatcher.close();
	});

	it('finishes reading the config before its change callback returns', async () => {
		const initial = { foo: 'bar' };
		writeFileSync(this.configFilePath, stringify(initial));
		const configWatcher = new RootConfigWatcher();
		await configWatcher.ready;

		const updated = { foo: 'baz' };
		writeFileSync(this.configFilePath, stringify(updated));
		configWatcher.handleChange();

		assert.deepEqual(configWatcher.config, updated, 'watcher must not leave a same-thread read in flight');
		configWatcher.close();
	});

	// `harper_logger.start()` awaits this promise with no timeout, so every terminal read outcome
	// has to settle it.
	it('resolves ready for a config that parses to nothing', async () => {
		writeFileSync(this.configFilePath, '# nothing but a comment\n');
		const configWatcher = new RootConfigWatcher();

		const [value] = await configWatcher.ready;

		assert.strictEqual(value, undefined, 'a config that parses to nothing must still settle the boot barrier');
		configWatcher.close();
	}).timeout(5000);

	it('resolves ready on an empty config once the retry ladder is spent', async () => {
		writeFileSync(this.configFilePath, '');
		const configWatcher = new RootConfigWatcher();

		const [value] = await configWatcher.ready;

		assert.strictEqual(value, undefined, 'a file that stays empty must settle the barrier carrying no config');
		configWatcher.close();
	}).timeout(10000);

	// chokidar's initial scan finds nothing to report, so arming is the only place that can tell
	// this apart from a watcher that has simply not read yet. A missing file is not a lock, so it
	// must settle at once rather than spend the ladder — `harper_logger.start()` waits on this.
	it('resolves ready when there is no config file to read', async () => {
		const configWatcher = new RootConfigWatcher();

		const [value] = await configWatcher.ready;

		assert.strictEqual(value, undefined, 'a missing config file must still settle the boot barrier');
		assert.equal(configWatcher._readCountForTests, 1, 'ENOENT must not take the retry ladder');
		configWatcher.close();
	}).timeout(10000);

	it('settles ready when the watcher is closed before it arms', async () => {
		writeFileSync(this.configFilePath, stringify({ foo: 'bar' }));
		const configWatcher = new RootConfigWatcher();

		configWatcher.close();

		await configWatcher.ready;
	});

	it('resolves ready for a config that cannot be parsed', async () => {
		writeFileSync(this.configFilePath, 'foo: [unclosed\n');
		const configWatcher = new RootConfigWatcher();

		const [value] = await configWatcher.ready;

		assert.strictEqual(value, undefined, 'an unparseable config must settle the barrier carrying no config');

		// A parse failure is terminal for that read, but the watcher still has to deliver the file
		// once an operator fixes it.
		const change = once(configWatcher, 'change');
		writeFileSync(this.configFilePath, stringify({ foo: 'bar' }));
		const [updated] = await change;

		assert.deepEqual(updated, { foo: 'bar' }, 'a repaired config must arrive as a change');
		configWatcher.close();
	}).timeout(10000);

	it('treats an empty read as a writer mid-write, not an empty config', async () => {
		writeFileSync(this.configFilePath, stringify({ foo: 'bar' }));
		const configWatcher = new RootConfigWatcher();
		await configWatcher.ready;

		// A non-atomic writer truncates before it writes; a read landing in between sees nothing.
		// chokidar throttles the change event that carries the content as a duplicate of the
		// truncate's, so discarding the empty read strands the config on the stale value.
		const before = configWatcher._readCountForTests;
		writeFileSync(this.configFilePath, '');
		configWatcher.handleChange();
		assert.deepEqual(configWatcher.config, { foo: 'bar' }, 'an empty read must not clear the loaded config');

		// Nothing touches the file again, so chokidar has only the truncate to report: the reads
		// beyond that one came from ladder rungs.
		for (let waited = 0; waited < 3000 && configWatcher._readCountForTests - before < 4; waited += 50) await delay(50);
		assert.ok(
			configWatcher._readCountForTests - before >= 4,
			`the ladder attempted ${configWatcher._readCountForTests - before} reads after the empty read`
		);

		const change = once(configWatcher, 'change');
		writeFileSync(this.configFilePath, stringify({ foo: 'baz' }));
		const [updated] = await change;
		assert.deepEqual(updated, { foo: 'baz' }, 'the content the writer went on to write must still arrive');

		configWatcher.close();
	});

	it('ignores a watcher callback that lands after close()', async () => {
		writeFileSync(this.configFilePath, stringify({ foo: 'bar' }));
		const configWatcher = new RootConfigWatcher();
		await configWatcher.ready;

		configWatcher.close();
		writeFileSync(this.configFilePath, stringify({ foo: 'baz' }));
		configWatcher.handleChange();

		assert.equal(configWatcher.config, undefined, 'a closed watcher must not read or repopulate its config');
	});

	// A mode-000 file denies the watcher's read the way a Windows sharing violation does without
	// stubbing node:fs, which AGENTS.md forbids. It has to be the file and not its directory:
	// chokidar cannot watch an unreadable directory. Root ignores the mode and Windows has no POSIX
	// modes, so those hosts skip.
	const denyReads = (filePath) => {
		chmodSync(filePath, 0o000);
		try {
			readFileSync(filePath, 'utf-8');
			chmodSync(filePath, 0o644);
			return false;
		} catch {
			return true;
		}
	};

	it('retries a failed config read until it succeeds, without waiting for another change event', async function () {
		writeFileSync(suite.configFilePath, stringify({ foo: 'bar' }));
		const configWatcher = new RootConfigWatcher();
		await configWatcher.ready;

		const firstChange = once(configWatcher, 'change');
		writeFileSync(suite.configFilePath, stringify({ foo: 'baz' }));
		await firstChange;

		if (!denyReads(suite.configFilePath)) {
			configWatcher.close();
			return this.skip();
		}

		configWatcher.handleChange();
		assert.deepEqual(configWatcher.config, { foo: 'baz' }, 'a failed read must keep the previous config');

		const change = once(configWatcher, 'change');
		chmodSync(suite.configFilePath, 0o644);
		const [updated] = await change;

		// chokidar reports the unlocking chmod as a change of its own, so this asserts that the
		// config comes back, not which path delivered it; configReadRetry.test.js covers the ladder.
		assert.deepEqual(updated, { foo: 'baz' }, 'a read denied once must not leave the config stale');
		configWatcher.close();
	});

	it('cancels a pending read retry on close', async function () {
		writeFileSync(suite.configFilePath, stringify({ foo: 'bar' }));
		const configWatcher = new RootConfigWatcher();
		await configWatcher.ready;

		if (!denyReads(suite.configFilePath)) {
			configWatcher.close();
			return this.skip();
		}

		configWatcher.handleChange();
		configWatcher.close();
		chmodSync(suite.configFilePath, 0o644);

		// close() clears the config, so a retry that outlived it would reload and set it again.
		await delay(400);
		assert.equal(configWatcher.config, undefined, 'close() must not leave a retry timer behind');
	});

	// A truncated write usually leaves a *prefix* on disk, and `foo: [1, 2` is what a prefix of
	// `foo: [1, 2, 3]` looks like: unparseable, with the event carrying the rest of the document
	// throttled away by chokidar as a duplicate.
	it('rides out an unparseable read on the same ladder as an empty one', async () => {
		writeFileSync(this.configFilePath, stringify({ foo: 'bar' }));
		const configWatcher = new RootConfigWatcher();
		await configWatcher.ready;

		const before = configWatcher._readCountForTests;
		writeFileSync(this.configFilePath, 'foo: [1, 2');
		configWatcher.handleChange();

		for (let waited = 0; waited < 3000 && configWatcher._readCountForTests - before < 3; waited += 50) await delay(50);

		assert.ok(
			configWatcher._readCountForTests - before >= 3,
			`the ladder attempted ${configWatcher._readCountForTests - before} reads after the unparseable read`
		);
		assert.deepEqual(configWatcher.config, { foo: 'bar' }, 'a mid-write prefix must not replace the config');
		configWatcher.close();
	}).timeout(10000);

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
			const change = once(configWatcher, 'change');
			await writeFile(this.configFilePath, stringify(updated));
			const [changeValue] = await change;
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

		// `once(this, 'ready')` is what usually absorbs an `error`, and settling the barrier is
		// what removes it — so the production shape has no listener at all by the time a scan
		// error is reported, and an unlistened `error` throws out of chokidar's dispatch.
		it('does not throw a scan error at an emitter no one is listening to', async () => {
			const configWatcher = new RootConfigWatcher();
			await configWatcher.ready;

			configWatcher._simulateWatcherErrorForTests(Object.assign(new Error('boom'), { code: 'EACCES' }));

			configWatcher.close();
		}).timeout(10000);

		// A scan error is terminal for the barrier — chokidar may never emit its own `ready` after
		// one — but it is not the scan finishing, so the arming re-read still has to happen.
		it('settles ready on a scan error without giving up the arming re-read', async () => {
			writeFileSync(this.configFilePath, stringify({ foo: 'bar' }));
			const configWatcher = new RootConfigWatcher();

			configWatcher._simulateWatcherErrorForTests(Object.assign(new Error('boom'), { code: 'EACCES' }));

			await configWatcher.ready;
			assert.equal(configWatcher._armedForTests, false, 'a scan error is not the scan finishing');

			// The write that the unarmed window swallows is exactly what the arming re-read exists
			// to recover, so it must still arrive with no further watcher event.
			writeFileSync(this.configFilePath, stringify({ foo: 'armed' }));
			for (let waited = 0; waited < 3000 && !configWatcher._armedForTests; waited += 50) await delay(50);

			assert.equal(configWatcher._armedForTests, true, 'the watcher must still arm after a scan error');
			assert.deepEqual(configWatcher.config, { foo: 'armed' }, 'arming must still re-read');
			configWatcher.close();
		}).timeout(5000);

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

		it('a synchronous throw from close() stays inside the reopen chain', async () => {
			// The reopen used to be spelled `Promise.resolve(this.#watcher.close())`, whose argument
			// is evaluated eagerly: a close() that throws synchronously threw out of the 'error'
			// listener itself, past the chained .catch(), and Node reported it as an uncaught
			// exception instead of reopening on polling.
			writeFileSync(this.configFilePath, stringify({ foo: 'bar' }));

			const realWatch = chokidar.default.watch;
			const handlers = {};
			const fakeWatcher = {
				on(event, handler) {
					handlers[event] = handler;
					return fakeWatcher;
				},
				close() {
					throw new Error('close failed synchronously');
				},
			};
			chokidar.default.watch = () => fakeWatcher;

			let configWatcher;
			try {
				configWatcher = new RootConfigWatcher();

				assert.doesNotThrow(() =>
					configWatcher._simulateWatcherErrorForTests(Object.assign(new Error('boom'), { code: 'ENOSPC' }))
				);
				await new Promise((resolve) => setImmediate(resolve));

				assert.equal(configWatcher._usingPollingForTests, true, 'should have flipped to polling');
				assert.equal(configWatcher._openCountForTests, 2, 'should have reopened after the failed close()');
			} finally {
				chokidar.default.watch = realWatch;
				// The fake watcher's close() always throws; swap it for a real no-op before
				// teardown so configWatcher.close() (unrelated to this test) doesn't also throw.
				fakeWatcher.close = () => {};
				configWatcher?.close();
			}
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
