/* eslint-disable sonarjs/no-nested-functions */
const { OptionsWatcher } = require('#src/components/OptionsWatcher');
const { EventEmitter, once } = require('node:events');
const assert = require('node:assert');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { mkdtempSync, writeFileSync, rmSync, chmodSync, readFileSync } = require('node:fs');
const { writeFile, rm } = require('node:fs/promises');
const { setTimeout: delay } = require('node:timers/promises');
const { stringify } = require('yaml');
const { spy } = require('sinon');
const chokidar = require('chokidar');
const { DEFAULT_CONFIG } = require('#src/components/DEFAULT_CONFIG');
const { cloneDeep } = require('lodash');

/**
 * This function asserts that an event is emitted.
 * It also allows for triggering the event and performing additional assertions.
 * The `triggerEvent` and `additionalAssertions` parameters can by async.
 * @param {EventEmitter} ee
 * @param {string} event
 * @param {Function} [triggerEvent]
 * @param {Function} [additionalAssertions]
 */
async function assertEvent(ee, event, triggerEvent, additionalAssertions) {
	const eventSpy = spy();
	ee.on(event, eventSpy);
	const eventTriggered = once(ee, event);
	try {
		await triggerEvent?.();
		await eventTriggered;
		await additionalAssertions?.(eventSpy);
	} finally {
		ee.removeListener(event, eventSpy);
	}
}

const NAME = 'test-component';

const OPTIONS = {
	nil: null,
	str: 'foo',
	bool: true,
	num: 100,
	arr: [1, 2, 3],
	obj: {
		nil: null,
		str: 'bar',
		bool: false,
		num: 200,
		arr: [4, 5, 6],
		deep: {
			x: 1,
		},
	},
};

const CONFIG = {
	[NAME]: OPTIONS,
};

function getFixtureName() {
	return join(tmpdir(), 'harper.unit-test.options-watcher-');
}

function createFixture(config = CONFIG) {
	const fixture = mkdtempSync(getFixtureName());
	const configFilePath = join(fixture, 'config.yaml');
	writeFileSync(configFilePath, stringify(config), 'utf-8');

	return { fixture, configFilePath };
}

async function setup() {
	const { fixture, configFilePath } = createFixture();

	const options = new OptionsWatcher(NAME, configFilePath);

	await options.ready;

	return {
		fixture,
		configFilePath,
		options,
	};
}

async function teardown({ fixture, options }) {
	await options.close();
	try {
		rmSync(fixture, { recursive: true, force: true });
		// eslint-disable-next-line sonarjs/no-ignored-exceptions
	} catch {
		// best effort to clean up - but doesn't matter too much since this is a temp directory
	}
}

describe('OptionsWatcher', () => {
	it('should instantiate with a file path and emit a ready event', async () => {
		const { fixture, configFilePath } = createFixture();

		const options = new OptionsWatcher(NAME, configFilePath);

		assert.ok(options instanceof EventEmitter, 'OptionsWatcher should be an instance of EventEmitter');

		// The `OptionsWatcher` class emits a `'ready'` event, so assert that using the `assertEvent` utility.
		// The class also includes a `ready` property that returns a promise tracking the `'ready'` event, that is tested in the next test.
		await assertEvent(options, 'ready', undefined, (eventSpy) => {
			assert.equal(eventSpy.callCount, 1);
			assert.deepEqual(eventSpy.getCall(0).args, [OPTIONS], 'should emit the initial config');
		});

		await teardown({ fixture, options });
	});

	it('should instantiate and emit ready even if the file does not exist', async () => {
		const { fixture, configFilePath } = createFixture();
		rmSync(configFilePath, { force: true });

		const options = new OptionsWatcher(NAME, configFilePath);

		await assertEvent(options, 'ready', undefined, (eventSpy) => {
			assert.equal(eventSpy.callCount, 1);
		});

		assert.equal(options.getAll(), undefined, 'should return undefined if the file does not exist');

		await teardown({ fixture, options });
	});

	it('should await ready event via `ready()` method', async () => {
		const { fixture, configFilePath } = createFixture();

		const options = new OptionsWatcher(NAME, configFilePath);

		// This test is very similar to the `assertEvent` utility (thats also used in the previous test), but we want to ensure that the `ready()` method works as expected.
		// So instead of awaiting the `once(options, 'ready')` promise, await the `ready()` method and ensure the spy is called once.
		const readySpy = spy();
		options.on('ready', readySpy);
		await options.ready;
		assert.equal(readySpy.callCount, 1);

		await teardown({ fixture, options });
	});

	it('should correctly return the initial configuration', async () => {
		const { fixture, options } = await setup();
		const expected = cloneDeep(OPTIONS);
		assert.equal(options.get(['nil']), expected.nil, 'should return a top-level null value');
		assert.equal(options.get(['str']), expected.str, 'should return a top-level string value');
		assert.equal(options.get(['bool']), expected.bool, 'should return a top-level boolean value');
		assert.equal(options.get(['num']), expected.num, 'should return a top-level number value');
		assert.deepEqual(options.get(['arr']), expected.arr, 'should return a top-level array value');
		assert.deepEqual(options.get(['obj']), expected.obj, 'should return a top-level object value');
		assert.equal(options.get(['obj', 'nil']), expected.obj.nil, 'should return a nested null value');
		assert.equal(options.get(['obj', 'str']), expected.obj.str, 'should return a nested string value');
		assert.equal(options.get(['obj', 'bool']), expected.obj.bool, 'should return a nested boolean value');
		assert.equal(options.get(['obj', 'num']), expected.obj.num, 'should return a nested number value');
		assert.deepEqual(options.get(['obj', 'arr']), expected.obj.arr, 'should return a nested array value');
		assert.deepEqual(options.get(['obj', 'deep']), expected.obj.deep, 'should return a nested object value');
		assert.equal(options.get(['obj', 'deep', 'x']), expected.obj.deep.x, 'should return a deeply nested value');

		assert.equal(options.get(['nonExistent']), undefined, 'should return undefined for a non-existent property');
		assert.equal(
			options.get(['obj', 'nonExistent']),
			undefined,
			'should return undefined for a non-existent nested property'
		);
		assert.equal(
			options.get(['obj', 'deep', 'nonExistent']),
			undefined,
			'should return undefined for a non-existent deeply nested property'
		);

		assert.deepEqual(options.getAll(), expected, 'should return the entire configuration');

		await teardown({ fixture, options });
	});

	it('finishes root config reads before its change callback returns', async () => {
		const fixture = mkdtempSync(getFixtureName());
		const configFilePath = join(fixture, 'harper-config.yaml');
		writeFileSync(configFilePath, stringify(CONFIG), 'utf-8');
		const options = new OptionsWatcher(NAME, configFilePath, undefined, true);
		await options.ready;

		const updated = { ...CONFIG, [NAME]: { ...OPTIONS, str: 'updated' } };
		writeFileSync(configFilePath, stringify(updated), 'utf-8');
		options._refreshForTests();

		assert.equal(options.get(['str']), 'updated', 'root watcher must not leave a same-thread read in flight');
		await teardown({ fixture, options });
	});

	// `<name>: [1, 2` is what a prefix of `<name>: [1, 2, 3]` looks like on disk mid-write: it does
	// not parse, and the event carrying the rest of the document is the one chokidar throttles away.
	it('rides out an unparseable read on the retry ladder', async () => {
		const fixture = mkdtempSync(getFixtureName());
		const configFilePath = join(fixture, 'harper-config.yaml');
		writeFileSync(configFilePath, stringify(CONFIG), 'utf-8');
		const options = new OptionsWatcher(NAME, configFilePath);
		await options.ready;

		const before = options._readCountForTests;
		writeFileSync(configFilePath, `${NAME}: [1, 2`, 'utf-8');
		options._refreshForTests();

		for (let waited = 0; waited < 3000 && options._readCountForTests - before < 3; waited += 50) await delay(50);

		assert.ok(
			options._readCountForTests - before >= 3,
			`the ladder attempted ${options._readCountForTests - before} reads after the unparseable read`
		);
		assert.deepEqual(options.getAll(), OPTIONS, 'a mid-write prefix must not replace the scope config');

		await teardown({ fixture, options });
	}).timeout(10000);

	// `once(this, 'ready')` turns an `error` emitted before `ready` into a rejection, and
	// `componentLoader` awaits `Scope.ready` — so a failing watcher used to fail the component load
	// rather than settle it onto the defaults the way every read outcome does.
	it('settles ready when the watcher itself fails', async () => {
		const { fixture, configFilePath } = createFixture();
		const options = new OptionsWatcher(NAME, configFilePath);
		const errorSpy = spy();
		options.on('error', errorSpy);

		options._simulateWatcherErrorForTests(Object.assign(new Error('boom'), { code: 'EACCES' }));

		await options.ready;
		assert.equal(errorSpy.callCount, 1, 'the watcher error must still reach consumers');

		await teardown({ fixture, options });
	});

	// `componentLoader` builds scopes from a memoized view of the config, so a block removed under a
	// booting worker leaves a read that parses perfectly and simply has nothing for this scope.
	it('settles ready when the config that read fine no longer carries this scope', async () => {
		const fixture = mkdtempSync(getFixtureName());
		const configFilePath = join(fixture, 'harper-config.yaml');
		writeFileSync(configFilePath, stringify({ somethingElse: true }), 'utf-8');
		const options = new OptionsWatcher(NAME, configFilePath);

		await options.ready;

		await teardown({ fixture, options });
	}).timeout(5000);

	it('keeps the config a scope-less read produced instead of falling back to the defaults', async () => {
		const fixture = mkdtempSync(getFixtureName());
		const configFilePath = join(fixture, 'config.yaml');
		writeFileSync(configFilePath, stringify({ somethingElse: true }), 'utf-8');
		const options = new OptionsWatcher(NAME, configFilePath);

		await options.ready;
		assert.deepEqual(options.getRoot(), { somethingElse: true });

		await teardown({ fixture, options });
	}).timeout(5000);

	it('does not let a throwing error listener escape the failure path', async () => {
		const { fixture, configFilePath } = createFixture();
		const options = new OptionsWatcher(NAME, configFilePath);
		options.on('error', () => {
			throw new Error('listener boom');
		});

		options._simulateWatcherErrorForTests(Object.assign(new Error('boom'), { code: 'EACCES' }));

		await teardown({ fixture, options });
	});

	it('emits remove when a scope declared with no body is deleted', async () => {
		const fixture = mkdtempSync(getFixtureName());
		const configFilePath = join(fixture, 'harper-config.yaml');
		writeFileSync(configFilePath, stringify({ [NAME]: null }), 'utf-8');
		const options = new OptionsWatcher(NAME, configFilePath);
		await options.ready;
		assert.strictEqual(options.getAll(), null, '`myPlugin:` with no body is a configured scope');

		const removed = once(options, 'remove');
		writeFileSync(configFilePath, stringify({ somethingElse: true }), 'utf-8');
		options._refreshForTests();
		await removed;

		await teardown({ fixture, options });
	}).timeout(5000);

	// The failure paths emit `ready` from a retry timer and from chokidar's error dispatch, where a
	// throwing listener is an uncaught exception rather than something a caller can absorb.
	it('does not let a throwing ready listener escape the failure path', async () => {
		const { fixture, configFilePath } = createFixture();
		const options = new OptionsWatcher(NAME, configFilePath);
		options.on('ready', () => {
			throw new Error('listener boom');
		});
		options.on('error', () => {});

		options._simulateWatcherErrorForTests(Object.assign(new Error('boom'), { code: 'EACCES' }));

		await teardown({ fixture, options });
	});

	it('re-reads the root config when the watcher arms', async () => {
		const fixture = mkdtempSync(getFixtureName());
		const configFilePath = join(fixture, 'harper-config.yaml');
		writeFileSync(configFilePath, stringify(CONFIG), 'utf-8');
		const options = new OptionsWatcher(NAME, configFilePath);
		await options.ready;

		for (let waited = 0; waited < 3000 && !options._armedForTests; waited += 50) await delay(50);
		assert.equal(options._armedForTests, true, 'the watcher must arm once chokidar has finished its scan');
		// A write landing in the unarmed window is reported by no event, so the arming re-read is the
		// only thing that can deliver it — arming must read rather than trust the scan's read.
		assert.ok(options._readCountForTests >= 2, `arming must re-read (${options._readCountForTests} reads)`);

		await teardown({ fixture, options });
	});

	// Where the platform has an arming grace (darwin), the re-read lands a beat after `ready`, and
	// a deletion in between used to reach the scope as a `remove` before chokidar had reported —
	// or finished processing — the unlink itself. A consumer acting on that early `remove` recreates
	// the file inside chokidar's own teardown window, where the `add` is not observed at all, and
	// the scope keeps the defaults with no further event coming (harper#2191 review).
	it('does not read a missing file as a deletion when the re-read came from arming', async () => {
		const fixture = mkdtempSync(getFixtureName());
		const configFilePath = join(fixture, 'harper-config.yaml');
		writeFileSync(configFilePath, stringify(CONFIG), 'utf-8');
		const options = new OptionsWatcher(NAME, configFilePath);
		await options.ready;

		let removed = false;
		options.on('remove', () => {
			removed = true;
		});
		rmSync(configFilePath);
		// Asserted before yielding, so chokidar's own `unlink` — which is what may legitimately
		// report this deletion — cannot have run yet.
		options._refreshForTests(true);

		assert.equal(removed, false, 'the arm gate exists to catch a write, not to report a deletion');
		assert.equal(options.get(['str']), 'foo', 'the applied config must survive the arming re-read');

		await teardown({ fixture, options });
	});

	it('still reads a missing file as a deletion on an ordinary re-read', async () => {
		const fixture = mkdtempSync(getFixtureName());
		const configFilePath = join(fixture, 'harper-config.yaml');
		writeFileSync(configFilePath, stringify(CONFIG), 'utf-8');
		const options = new OptionsWatcher(NAME, configFilePath);
		await options.ready;

		let removed = false;
		options.on('remove', () => {
			removed = true;
		});
		rmSync(configFilePath);
		options._refreshForTests();

		assert.equal(removed, true, 'an ENOENT read outside the arm gate is still the install/removal path');

		await teardown({ fixture, options });
	});

	// A mode-000 file denies the read the way a Windows sharing violation does without stubbing
	// node:fs, which AGENTS.md forbids. It has to be the file and not its directory: chokidar
	// cannot watch an unreadable directory and synthesizes an `unlink` when it tries. chmod leaves
	// mtime alone, so no watcher event fires for the lock or its release and a retry is provably
	// the only thing that can read the file again. Root ignores the mode and Windows has no POSIX
	// modes, so those hosts skip.
	function denyReads(filePath) {
		chmodSync(filePath, 0o000);
		try {
			readFileSync(filePath, 'utf-8');
			chmodSync(filePath, 0o644);
			return false;
		} catch {
			return true;
		}
	}

	it('keeps the previous options through a denied read and applies the file once it clears', async function () {
		const fixture = mkdtempSync(getFixtureName());
		const configFilePath = join(fixture, 'harper-config.yaml');
		writeFileSync(configFilePath, stringify(CONFIG), 'utf-8');
		const options = new OptionsWatcher(NAME, configFilePath, undefined, true);
		await options.ready;
		if (!denyReads(configFilePath)) {
			await teardown({ fixture, options });
			return this.skip();
		}

		chmodSync(configFilePath, 0o644);
		const errors = [];
		options.on('error', (error) => errors.push(error));

		// Written and locked in one synchronous block, so the watcher event this write queues is
		// already denied by the time it runs and the new contents sit on disk unreachable. Which
		// path delivers them after the unlock is not observable here — chokidar reports a chmod as
		// a change of its own — so this asserts the invariant, and configReadRetry.test.js proves
		// the ladder that upholds it when no event follows.
		const updated = { ...CONFIG, [NAME]: { ...OPTIONS, str: 'unlocked' } };
		writeFileSync(configFilePath, stringify(updated), 'utf-8');
		chmodSync(configFilePath, 0o000);

		await delay(300);
		assert.deepEqual(errors, [], 'a denied read must be retried before it is surfaced');
		assert.equal(options.get(['str']), 'foo', 'a denied read must leave the previous options in place');

		chmodSync(configFilePath, 0o644);
		for (let waited = 0; waited < 2500 && options.get(['str']) !== 'unlocked'; waited += 50) await delay(50);

		assert.equal(options.get(['str']), 'unlocked', 'a lock that clears must leave the options current');
		assert.deepEqual(errors, [], 'a lock that clears within the ladder must never surface');
		await teardown({ fixture, options });
	});

	it('retries a denied application-config read instead of settling the scope on the defaults', async function () {
		// Application configs read asynchronously so a stalled component-config volume cannot block
		// the thread — which is a reason not to *block*, not a reason for a transient failure to be
		// terminal. Nothing emits a second watcher event when it clears.
		const fixture = mkdtempSync(getFixtureName());
		const appConfigPath = join(fixture, 'config.yaml');
		writeFileSync(appConfigPath, stringify(CONFIG), 'utf-8');
		const options = new OptionsWatcher(NAME, appConfigPath, undefined, false);
		await options.ready;
		if (!denyReads(appConfigPath)) {
			await teardown({ fixture, options });
			return this.skip();
		}

		const errors = [];
		options.on('error', (error) => errors.push(error));

		// The file stays locked, so chokidar reports nothing further — chmod leaves mtime alone —
		// and every read past the first can only have come from a ladder rung.
		const before = options._readCountForTests;
		await options._refreshForTests();
		for (let waited = 0; waited < 3000 && options._readCountForTests - before < 3; waited += 50) await delay(50);

		assert.ok(
			options._readCountForTests - before >= 3,
			`the ladder attempted ${options._readCountForTests - before} reads while the lock held`
		);
		assert.deepEqual(errors, [], 'a denied read must be retried before it is surfaced');
		assert.equal(options.get(['str']), 'foo', 'a denied read must leave the previous options in place');

		chmodSync(appConfigPath, 0o644);
		await teardown({ fixture, options });
	});

	// `DEFAULT_CONFIG` names six scopes, and a boot that finds none of its own config hands the
	// scope that scope's defaults. Read as a value the file supplied, the next read of the very
	// same file looks like the block being deleted — a `remove`, and through `Scope` a restart, on
	// a config that never changed.
	it('does not report a removal for the defaults it booted on', async () => {
		const fixture = mkdtempSync(getFixtureName());
		const configFilePath = join(fixture, 'harper-config.yaml');
		writeFileSync(configFilePath, stringify({ http: { port: 9926 } }), 'utf-8');
		const options = new OptionsWatcher('graphqlSchema', configFilePath, undefined, true);
		await options.ready;
		assert.equal(options.get(['files']), DEFAULT_CONFIG.graphqlSchema.files, 'the boot falls back to the defaults');

		let removed = false;
		options.on('remove', () => {
			removed = true;
		});
		await options._refreshForTests();
		await options._refreshForTests();

		assert.equal(removed, false, 'the defaults are not a configuration that can be removed');
		await teardown({ fixture, options });
	});

	it('reports a truthy config arrival and its later removal after boot fallback', async () => {
		const fixture = mkdtempSync(getFixtureName());
		const configFilePath = join(fixture, 'harper-config.yaml');
		writeFileSync(configFilePath, stringify({ http: { port: 9926 } }), 'utf-8');
		const options = new OptionsWatcher('graphqlSchema', configFilePath, undefined, true);
		await options.ready;

		let arrived;
		let changed = 0;
		options.on('ready', (value) => {
			arrived = value;
		});
		options.on('change', () => changed++);
		writeFileSync(configFilePath, stringify({ graphqlSchema: DEFAULT_CONFIG.graphqlSchema }), 'utf-8');
		await options._refreshForTests();
		assert.deepEqual(arrived, DEFAULT_CONFIG.graphqlSchema, 'a truthy fallback must not mask the config arrival');
		assert.equal(changed, 0, 'the first source config is an arrival, not a merge');

		const removed = once(options, 'remove');
		writeFileSync(configFilePath, stringify({ http: { port: 9926 } }), 'utf-8');
		await options._refreshForTests();
		await removed;

		await teardown({ fixture, options });
	});

	// A scope declared with no body is configured and falsy. Filling it in is a change; only the
	// unconfigured → configured transition is a `ready`, which `Scope` answers with a restart.
	it('delivers a filled-in falsy scope as a change, not a second ready', async () => {
		const fixture = mkdtempSync(getFixtureName());
		const configFilePath = join(fixture, 'harper-config.yaml');
		writeFileSync(configFilePath, `${NAME}:\n`, 'utf-8');
		const options = new OptionsWatcher(NAME, configFilePath, undefined, true);

		const [value] = await options.ready;
		assert.strictEqual(value, null, 'a scope declared with no body is configured as null');

		let readyAgain = 0;
		options.on('ready', () => readyAgain++);
		const changed = once(options, 'change');
		writeFileSync(configFilePath, stringify(CONFIG), 'utf-8');
		await changed;

		assert.equal(readyAgain, 0, 'filling in a configured scope is not the unconfigured transition');
		assert.equal(options.get(['str']), 'foo', 'the filled-in value must be applied');
		await teardown({ fixture, options });
	});

	// The other half of not reporting a deletion from the arming re-read: the unarmed window is
	// exactly where an `unlink` can go missing, so an absence it observes cannot just be dropped.
	it('still reports an absence the arming re-read observed, once the loop has had its turn', async () => {
		const fixture = mkdtempSync(getFixtureName());
		const configFilePath = join(fixture, 'harper-config.yaml');
		writeFileSync(configFilePath, stringify(CONFIG), 'utf-8');
		const options = new OptionsWatcher(NAME, configFilePath, undefined, true);
		await options.ready;

		// Armed first, so the watcher's own arming re-read is already spent and cannot be mistaken
		// for the re-check below.
		for (let waited = 0; waited < 3000 && !options._armedForTests; waited += 10) await delay(10);

		const removed = once(options, 'remove');
		rmSync(configFilePath);
		options._refreshForTests(true);
		// Captured synchronously, so only the re-check the arming read queued can move it: one
		// check-phase turn later, ahead of anything chokidar can deliver (which needs a poll-phase
		// turn first), and `#handleUnlink` does not read at all.
		const afterArming = options._readCountForTests;
		await new Promise((resolve) => setImmediate(resolve));

		assert.ok(
			options._readCountForTests > afterArming,
			'the absence the arming re-read saw must be re-checked, not dropped'
		);
		await removed;
		assert.equal(options.get(['str']), undefined, 'the scope must fall back to its defaults');
		await teardown({ fixture, options });
	});

	// `Scope.ready` has no timeout, so a shutdown mid-ladder must not strand `componentLoader`.
	it('settles ready when it is closed mid-ladder', async function () {
		this.timeout(2000);
		const fixture = mkdtempSync(getFixtureName());
		const configFilePath = join(fixture, 'harper-config.yaml');
		// Empty, so the ladder is still running and `ready` is nowhere near its own settle.
		writeFileSync(configFilePath, '', 'utf-8');

		const options = new OptionsWatcher(NAME, configFilePath, undefined, true);

		await options.close();
		await options.ready;

		rmSync(fixture, { recursive: true, force: true });
	});

	it('still becomes ready when the config cannot be applied at boot', async () => {
		const fixture = mkdtempSync(getFixtureName());
		const configFilePath = join(fixture, 'harper-config.yaml');
		writeFileSync(configFilePath, `${NAME}:\n  str: [unclosed\n`, 'utf-8');
		const options = new OptionsWatcher(NAME, configFilePath, undefined, true);

		const errors = [];
		options.on('error', (error) => errors.push(error));

		// componentLoader awaits this with no timeout and nothing consumes `error`, so a failure
		// that leaves `ready` unemitted hangs the boot instead of surfacing.
		await options.ready;

		assert.equal(errors.length, 1, 'the failure must still surface');
		assert.deepEqual(options.getAll(), DEFAULT_CONFIG[NAME], 'boot falls back to the defaults');
		await teardown({ fixture, options });
	});

	it('re-reads from the ladder while the file stays locked, with no watcher event to help', async function () {
		const fixture = mkdtempSync(getFixtureName());
		const configFilePath = join(fixture, 'harper-config.yaml');
		writeFileSync(configFilePath, stringify(CONFIG), 'utf-8');
		const options = new OptionsWatcher(NAME, configFilePath, undefined, true);
		await options.ready;
		if (!denyReads(configFilePath)) {
			await teardown({ fixture, options });
			return this.skip();
		}

		options.on('error', () => {});
		const before = options._readCountForTests;
		options._refreshForTests();

		// Nothing touches the file for the rest of the case, so chokidar has nothing to report: any
		// further read attempt came from a ladder rung.
		for (let waited = 0; waited < 3000 && options._readCountForTests - before < 3; waited += 50) await delay(50);

		assert.ok(
			options._readCountForTests - before >= 3,
			`the ladder attempted ${options._readCountForTests - before} reads while the lock held`
		);
		chmodSync(configFilePath, 0o644);
		await teardown({ fixture, options });
	});

	it('surfaces a denied root config read once the retry ladder is spent', async function () {
		const fixture = mkdtempSync(getFixtureName());
		const configFilePath = join(fixture, 'harper-config.yaml');
		writeFileSync(configFilePath, stringify(CONFIG), 'utf-8');
		const options = new OptionsWatcher(NAME, configFilePath, undefined, true);
		await options.ready;
		if (!denyReads(configFilePath)) {
			await teardown({ fixture, options });
			return this.skip();
		}

		const errored = once(options, 'error');
		options._refreshForTests();
		const [error] = await errored;

		assert.equal(error.code, 'EACCES', 'a lock that outlives the ladder must not be swallowed');
		chmodSync(configFilePath, 0o644);
		await teardown({ fixture, options });
	});

	it('does not read a writer truncate window as a removed config', async () => {
		const fixture = mkdtempSync(getFixtureName());
		const configFilePath = join(fixture, 'harper-config.yaml');
		writeFileSync(configFilePath, stringify(CONFIG), 'utf-8');
		const options = new OptionsWatcher(NAME, configFilePath, undefined, true);
		await options.ready;

		let removed = false;
		options.on('remove', () => {
			removed = true;
		});
		writeFileSync(configFilePath, '', 'utf-8');
		options._refreshForTests();

		assert.equal(removed, false, 'an empty read must not read as a deleted scope');
		assert.equal(options.get(['str']), 'foo', 'the loaded options must survive a truncate window');
		await teardown({ fixture, options });
	});

	it('does not write an applied config into the shared defaults', async function () {
		// `.mocharc.json` sets `timeout: 0`, so a lost event here wedges the whole run rather than
		// failing this case.
		this.timeout(10_000);
		const fixture = mkdtempSync(getFixtureName());
		const configFilePath = join(fixture, 'harper-config.yaml');
		writeFileSync(configFilePath, stringify({ graphqlSchema: { files: 'a.graphql' } }), 'utf-8');
		const options = new OptionsWatcher('graphqlSchema', configFilePath, undefined, true);
		await options.ready;

		const removed = once(options, 'remove');
		rmSync(configFilePath);
		await removed;
		const fallbackRoot = options.getRoot();
		assert.notStrictEqual(fallbackRoot, DEFAULT_CONFIG, 'a reset must clone the root defaults');
		assert.notStrictEqual(
			fallbackRoot.graphqlSchema,
			DEFAULT_CONFIG.graphqlSchema,
			'a reset must clone nested scope defaults'
		);

		// `await removed` resumes as a microtask of chokidar's own `unlink` dispatch, so the
		// recreate below lands while chokidar is still tearing that watch down and its `add` is not
		// reliably reported — on darwin every run, on Linux CI under load. `should continue to watch
		// if file is removed and recreated` is where that delivery is asserted; what this case is
		// about is the reapplied config, so it drives the read itself rather than racing the watcher.
		const ready = once(options, 'ready');
		writeFileSync(configFilePath, stringify({ graphqlSchema: { files: 'custom.graphql' } }), 'utf-8');
		await options._refreshForTests();
		const [arrived] = await ready;

		assert.equal(arrived.files, 'custom.graphql', 'the recreated source config must arrive as ready');
		assert.equal(options.get(['files']), 'custom.graphql', 'the scope must apply its own config');
		assert.equal(DEFAULT_CONFIG.graphqlSchema.files, '*.graphql', 'the shared defaults must survive it');
		await teardown({ fixture, options });
	});

	// componentLoader awaits `Scope.ready` with no timeout, so a file that is still empty when the
	// ladder is spent has to settle on the defaults rather than strand the component.
	it('becomes ready on the defaults when the config file stays empty', async () => {
		const fixture = mkdtempSync(getFixtureName());
		const configFilePath = join(fixture, 'harper-config.yaml');
		writeFileSync(configFilePath, '', 'utf-8');
		const options = new OptionsWatcher(NAME, configFilePath, undefined, true);

		await options.ready;

		assert.equal(options.get(['str']), undefined, 'an empty config carries no scoped options');
		await teardown({ fixture, options });
	}).timeout(10000);

	// A deletion inside the boot window cancels the ladder that was the only thing left to settle
	// `ready`, so `#handleUnlink` has to settle the barrier itself: `remove` reaches a `Scope` whose
	// own `ready` is still pending, which asks for a restart of a component that never booted.
	it('settles ready when the file is deleted before any read had a config to give', async () => {
		const fixture = mkdtempSync(getFixtureName());
		const configFilePath = join(fixture, 'harper-config.yaml');
		writeFileSync(configFilePath, '', 'utf-8');
		const options = new OptionsWatcher(NAME, configFilePath, undefined, true);

		// Waited out so the arming re-read is not what settles the barrier, and so the ladder — whose
		// rungs back off with the elapsed budget — has a rung far enough away that chokidar's
		// `unlink` (held back by its own atomic-write window) is what observes the deletion first.
		// That ordering is the boot hang: the ladder was the only thing left to settle `ready`, and
		// `#handleUnlink` cancels it.
		for (let waited = 0; waited < 3000 && !options._armedForTests; waited += 50) await delay(50);
		assert.equal(options._armedForTests, true, 'the watcher must arm once chokidar has finished its scan');
		await delay(1200);
		const events = [];
		for (const event of ['ready', 'remove']) options.on(event, () => events.push(event));
		rmSync(configFilePath, { force: true });

		const [value] = await options.ready;
		assert.strictEqual(value, undefined, 'a scope the defaults do not name settles carrying nothing');
		assert.deepEqual(events, ['ready'], 'a deletion in the boot window settles the barrier, it does not remove');
		await teardown({ fixture, options });
	}).timeout(10000);

	// `myPlugin:` with nothing under it is a configured scope whose value happens to be falsy, and
	// `Scope` turns a repeat `ready` into a restart request — so a re-read of it must not look like
	// the unconfigured → configured transition.
	it('does not re-emit ready when a falsy scope value is read again', async () => {
		const fixture = mkdtempSync(getFixtureName());
		const configFilePath = join(fixture, 'harper-config.yaml');
		writeFileSync(configFilePath, `${NAME}:\n`, 'utf-8');
		const options = new OptionsWatcher(NAME, configFilePath, undefined, true);

		const [value] = await options.ready;
		assert.strictEqual(value, null, 'a scope declared with no body is configured as null');

		let readyAgain = 0;
		options.on('ready', () => readyAgain++);
		options._refreshForTests();
		options._refreshForTests();

		assert.equal(readyAgain, 0, 're-reading the same falsy value is not a transition');
		await teardown({ fixture, options });
	});

	// A scope that booted unconfigured is in the same state as one whose config file was deleted:
	// `ready` is how the watcher says it has config again, and `Scope` re-initializes on each one.
	it('delivers a scope that arrives after the boot fallback as a ready', async () => {
		const fixture = mkdtempSync(getFixtureName());
		const configFilePath = join(fixture, 'harper-config.yaml');
		writeFileSync(configFilePath, '', 'utf-8');
		const options = new OptionsWatcher(NAME, configFilePath, undefined, true);

		// A file still empty when the ladder is spent settles `ready` on the defaults, which do
		// not name this scope.
		await options.ready;
		assert.equal(options.get(['str']), undefined, 'the fallback carries no scoped options');

		const readyAgain = once(options, 'ready');
		writeFileSync(configFilePath, stringify(CONFIG), 'utf-8');
		const [value] = await readyAgain;

		assert.equal(value.str, 'foo', 'the second ready must carry the config that arrived');
		assert.equal(options.get(['str']), 'foo', 'the scope must apply the config that arrived');
		await teardown({ fixture, options });
	}).timeout(10000);

	it('does not read a writer truncate window as a removed config on the async read path', async () => {
		const { fixture, configFilePath, options } = await setup();

		let removed = false;
		options.on('remove', () => {
			removed = true;
		});
		writeFileSync(configFilePath, '', 'utf-8');
		options._refreshForTests();
		await delay(50);

		assert.equal(removed, false, 'an empty read must not read as a deleted scope');
		assert.equal(options.get(['str']), 'foo', 'the loaded options must survive a truncate window');
		await teardown({ fixture, options });
	});

	it('does not surface the source lines yaml frames into a parse failure', async () => {
		const fixture = mkdtempSync(getFixtureName());
		const configFilePath = join(fixture, 'harper-config.yaml');
		writeFileSync(configFilePath, stringify(CONFIG), 'utf-8');
		const options = new OptionsWatcher(NAME, configFilePath, undefined, true);
		await options.ready;

		const errored = once(options, 'error');
		writeFileSync(configFilePath, `${NAME}:\n  str: [unclosed\n  password: hunter2\n`, 'utf-8');
		options._refreshForTests();
		const [error] = await errored;

		// The scope logs whatever is emitted here, and a config file holds credentials.
		assert.ok(!error.message.includes('hunter2'), `the emitted parse error framed the config: ${error.message}`);
		assert.ok(/line \d+, column \d+/.test(error.message), 'the emitted parse error must locate the failure');
		assert.equal(options.get(['str']), 'foo', 'a parse failure keeps the last valid options');
		await teardown({ fixture, options });
	});

	it('does not treat an ENOENT from a change listener as a missing config file', async () => {
		const fixture = mkdtempSync(getFixtureName());
		const configFilePath = join(fixture, 'harper-config.yaml');
		writeFileSync(configFilePath, stringify(CONFIG), 'utf-8');
		const options = new OptionsWatcher(NAME, configFilePath, undefined, true);
		await options.ready;

		const listenerError = Object.assign(new Error('listener file missing'), { code: 'ENOENT' });
		let emittedError;
		options.on('error', (error) => {
			emittedError = error;
		});
		let removed = false;
		options.on('remove', () => {
			removed = true;
		});
		options.on('change', () => {
			throw listenerError;
		});

		writeFileSync(configFilePath, stringify({ ...CONFIG, [NAME]: { ...OPTIONS, str: 'updated' } }), 'utf-8');
		options._refreshForTests();

		assert.equal(emittedError, listenerError);
		assert.equal(removed, false, 'listener errors must not reset the scope');
		await teardown({ fixture, options });
	});

	it('does not treat an ENOENT from a change listener as a missing config file on the async read path', async () => {
		const { fixture, configFilePath, options } = await setup();

		const listenerError = Object.assign(new Error('listener file missing'), { code: 'ENOENT' });
		let removed = false;
		options.on('remove', () => {
			removed = true;
		});
		options.on('change', () => {
			throw listenerError;
		});

		const errored = once(options, 'error');
		await writeFile(configFilePath, stringify({ ...CONFIG, [NAME]: { ...OPTIONS, str: 'updated' } }), 'utf-8');
		const [emitted] = await errored;

		assert.equal(emitted, listenerError);
		assert.equal(removed, false, 'listener errors must not reset the scope');
		await teardown({ fixture, options });
	});

	it('should continue to watch if file is removed and recreated', async () => {
		// Detecting file removal and recreation can take some time so increase the timeout
		this.timeout = 3000;

		const { fixture, configFilePath, options } = await setup();

		const expected = cloneDeep(OPTIONS);

		await assertEvent(
			options,
			'remove',
			() => rm(configFilePath, { force: true }),
			(removeSpy) => {
				assert.equal(removeSpy.callCount, 1);
				assert.equal(options.getAll(), undefined, 'should return undefined after file removal');
			}
		);

		await assertEvent(
			options,
			'ready',
			() => writeFile(configFilePath, stringify(CONFIG), 'utf-8'),
			(readySpy) => {
				assert.equal(readySpy.callCount, 1);
				assert.deepEqual(options.getAll(), expected, 'should return the configuration after file recreation');
			}
		);

		await teardown({ fixture, options });
	});

	it('should emit a remove event if the respective name is deleted', async () => {
		const config = {
			foo: { x: 1 },
			bar: { x: 1 },
		};
		const { fixture, configFilePath } = createFixture(config);

		const options = new OptionsWatcher('foo', configFilePath);
		await options.ready;

		const removeSpy = spy();
		options.on('remove', removeSpy);

		const removeEvent = once(options, 'remove');

		// then delete the 'foo' part and write again.
		// if the watcher is working correctly, it should only emit a change event for the 'foo' part
		delete config.foo;
		await writeFile(configFilePath, stringify(config), 'utf-8');

		await removeEvent;

		assert.equal(removeSpy.callCount, 1);

		await teardown({ fixture, options });
	});

	describe('change event from modifying underlying config file', () => {
		beforeEach(async () => {
			const { fixture, configFilePath, options } = await setup();
			this.fixture = fixture;
			this.configFilePath = configFilePath;
			this.options = options;
			this.expected = cloneDeep(OPTIONS);
		});

		afterEach(async () => {
			await teardown({ fixture: this.fixture, options: this.options });
		});

		describe('with top-level primitive (string, number, boolean, null) and array values', () => {
			it('should handle updating', () =>
				assertEvent(
					this.options,
					'change',
					async () => {
						this.expected.nil = 'not null';
						this.expected.str = null;
						this.expected.bool = false;
						this.expected.num = 200;
						this.expected.arr = [1, 2, 3, 4];
						await writeFile(this.configFilePath, stringify({ [NAME]: this.expected }), 'utf-8');
					},
					(changeSpy) => {
						assert.equal(changeSpy.callCount, 5);
						assert.deepEqual(changeSpy.getCall(0).args, [['nil'], this.expected.nil, this.expected]);
						assert.deepEqual(changeSpy.getCall(1).args, [['str'], this.expected.str, this.expected]);
						assert.deepEqual(changeSpy.getCall(2).args, [['bool'], this.expected.bool, this.expected]);
						assert.deepEqual(changeSpy.getCall(3).args, [['num'], this.expected.num, this.expected]);
						assert.deepEqual(changeSpy.getCall(4).args, [['arr'], this.expected.arr, this.expected]);
					}
				));

			it('should handle creating', () =>
				assertEvent(
					this.options,
					'change',
					async () => {
						this.expected.newNil = 'null';
						this.expected.newStr = 'foo';
						this.expected.newBool = true;
						this.expected.newNum = 300;
						this.expected.newArr = [1, 2, 3];
						await writeFile(this.configFilePath, stringify({ [NAME]: this.expected }), 'utf-8');
					},
					(changeSpy) => {
						assert.equal(changeSpy.callCount, 5);
						assert.deepEqual(changeSpy.getCall(0).args, [['newNil'], this.expected.newNil, this.expected]);
						assert.deepEqual(changeSpy.getCall(1).args, [['newStr'], this.expected.newStr, this.expected]);
						assert.deepEqual(changeSpy.getCall(2).args, [['newBool'], this.expected.newBool, this.expected]);
						assert.deepEqual(changeSpy.getCall(3).args, [['newNum'], this.expected.newNum, this.expected]);
						assert.deepEqual(changeSpy.getCall(4).args, [['newArr'], this.expected.newArr, this.expected]);
					}
				));

			it('should handle deleting', () =>
				assertEvent(
					this.options,
					'change',
					async () => {
						this.expected.nil = undefined;
						this.expected.str = undefined;
						this.expected.bool = undefined;
						this.expected.num = undefined;
						this.expected.arr = undefined;

						await writeFile(this.configFilePath, stringify({ [NAME]: this.expected }), 'utf-8');
					},
					(changeSpy) => {
						assert.equal(changeSpy.callCount, 5);
						assert.deepEqual(changeSpy.getCall(0).args, [['nil'], this.expected.nil, this.expected]);
						assert.deepEqual(changeSpy.getCall(1).args, [['str'], this.expected.str, this.expected]);
						assert.deepEqual(changeSpy.getCall(2).args, [['bool'], this.expected.bool, this.expected]);
						assert.deepEqual(changeSpy.getCall(3).args, [['num'], this.expected.num, this.expected]);
						assert.deepEqual(changeSpy.getCall(4).args, [['arr'], this.expected.arr, this.expected]);
					}
				));
		});

		describe('with nested primitives (string, number, boolean, null) and array values', () => {
			it('should handle updating', () =>
				assertEvent(
					this.options,
					'change',
					async () => {
						this.expected.obj.nil = 'not null';
						this.expected.obj.str = null;
						this.expected.obj.bool = true;
						this.expected.obj.num = 400;
						this.expected.obj.arr = [4, 5, 6, 7];
						this.expected.obj.deep.x = 2;
						await writeFile(this.configFilePath, stringify({ [NAME]: this.expected }), 'utf-8');
					},
					(changeSpy) => {
						assert.equal(changeSpy.callCount, 6);
						assert.deepEqual(changeSpy.getCall(0).args, [['obj', 'nil'], this.expected.obj.nil, this.expected]);
						assert.deepEqual(changeSpy.getCall(1).args, [['obj', 'str'], this.expected.obj.str, this.expected]);
						assert.deepEqual(changeSpy.getCall(2).args, [['obj', 'bool'], this.expected.obj.bool, this.expected]);
						assert.deepEqual(changeSpy.getCall(3).args, [['obj', 'num'], this.expected.obj.num, this.expected]);
						assert.deepEqual(changeSpy.getCall(4).args, [['obj', 'arr'], this.expected.obj.arr, this.expected]);
						assert.deepEqual(changeSpy.getCall(5).args, [
							['obj', 'deep', 'x'],
							this.expected.obj.deep.x,
							this.expected,
						]);
					}
				));

			it('should handle creating', () =>
				assertEvent(
					this.options,
					'change',
					async () => {
						this.expected.obj.newNil = null;
						this.expected.obj.newStr = 'foo';
						this.expected.obj.newBool = true;
						this.expected.obj.newNum = 300;
						this.expected.obj.newArr = [1, 2, 3];
						this.expected.obj.deep.newVal = 'newVal';
						await writeFile(this.configFilePath, stringify({ [NAME]: this.expected }), 'utf-8');
					},
					(changeSpy) => {
						assert.equal(changeSpy.callCount, 6);
						assert.deepEqual(changeSpy.getCall(0).args, [
							['obj', 'deep', 'newVal'],
							this.expected.obj.deep.newVal,
							this.expected,
						]);
						assert.deepEqual(changeSpy.getCall(1).args, [['obj', 'newNil'], this.expected.obj.newNil, this.expected]);
						assert.deepEqual(changeSpy.getCall(2).args, [['obj', 'newStr'], this.expected.obj.newStr, this.expected]);
						assert.deepEqual(changeSpy.getCall(3).args, [['obj', 'newBool'], this.expected.obj.newBool, this.expected]);
						assert.deepEqual(changeSpy.getCall(4).args, [['obj', 'newNum'], this.expected.obj.newNum, this.expected]);
						assert.deepEqual(changeSpy.getCall(5).args, [['obj', 'newArr'], this.expected.obj.newArr, this.expected]);
					}
				));

			it('should handle deleting', () =>
				assertEvent(
					this.options,
					'change',
					async () => {
						this.expected.obj.nil = undefined;
						this.expected.obj.str = undefined;
						this.expected.obj.bool = undefined;
						this.expected.obj.num = undefined;
						this.expected.obj.arr = undefined;
						this.expected.obj.deep.x = undefined;

						await writeFile(this.configFilePath, stringify({ [NAME]: this.expected }), 'utf-8');
					},
					(changeSpy) => {
						assert.equal(changeSpy.callCount, 6);
						assert.deepEqual(changeSpy.getCall(0).args, [['obj', 'nil'], this.expected.obj.nil, this.expected]);
						assert.deepEqual(changeSpy.getCall(1).args, [['obj', 'str'], this.expected.obj.str, this.expected]);
						assert.deepEqual(changeSpy.getCall(2).args, [['obj', 'bool'], this.expected.obj.bool, this.expected]);
						assert.deepEqual(changeSpy.getCall(3).args, [['obj', 'num'], this.expected.obj.num, this.expected]);
						assert.deepEqual(changeSpy.getCall(4).args, [['obj', 'arr'], this.expected.obj.arr, this.expected]);
						assert.deepEqual(changeSpy.getCall(5).args, [
							['obj', 'deep', 'x'],
							this.expected.obj.deep.x,
							this.expected,
						]);
					}
				));
		});

		describe('with top-level object values', () => {
			it('should handle updating', () =>
				assertEvent(
					this.options,
					'change',
					async () => {
						this.expected.obj = {
							arr: undefined,
							bool: undefined,
							deep: undefined,
							foo: 'bar',
							nil: undefined,
							num: undefined,
							str: undefined,
						};
						await writeFile(this.configFilePath, stringify({ [NAME]: this.expected }), 'utf-8');
					},
					(changeSpy) => {
						// "Updating" an object is actually the same as updating/removing/creating properties of the existing object
						// So instead of just one change event, we'll get multiple change events for each property
						assert.equal(changeSpy.callCount, 7);
						// these all get "removed"
						assert.deepEqual(changeSpy.getCall(0).args, [['obj', 'nil'], this.expected.obj.nil, this.expected]);
						assert.deepEqual(changeSpy.getCall(1).args, [['obj', 'str'], this.expected.obj.str, this.expected]);
						assert.deepEqual(changeSpy.getCall(2).args, [['obj', 'bool'], this.expected.obj.bool, this.expected]);
						assert.deepEqual(changeSpy.getCall(3).args, [['obj', 'num'], this.expected.obj.num, this.expected]);
						assert.deepEqual(changeSpy.getCall(4).args, [['obj', 'arr'], this.expected.obj.arr, this.expected]);
						assert.deepEqual(changeSpy.getCall(5).args, [['obj', 'deep'], this.expected.obj.deep, this.expected]);
						// this is the "new" property
						assert.deepEqual(changeSpy.getCall(6).args, [['obj', 'foo'], this.expected.obj.foo, this.expected]);
					}
				));

			it('should handle creating', () =>
				assertEvent(
					this.options,
					'change',
					async () => {
						this.expected.newObj = { foo: 'bar' };
						await writeFile(this.configFilePath, stringify({ [NAME]: this.expected }), 'utf-8');
					},
					(changeSpy) => {
						assert.equal(changeSpy.callCount, 1);
						assert.deepEqual(changeSpy.getCall(0).args, [['newObj'], this.expected.newObj, this.expected]);
					}
				));

			it('should handle deleting', () =>
				assertEvent(
					this.options,
					'change',
					async () => {
						this.expected.obj = undefined;
						await writeFile(this.configFilePath, stringify({ [NAME]: this.expected }), 'utf-8');
					},
					(changeSpy) => {
						assert.equal(changeSpy.callCount, 1);
						assert.deepEqual(changeSpy.getCall(0).args, [['obj'], this.expected.obj, this.expected]);
					}
				));
		});

		describe('with nested object values', () => {
			it('should handle updating', () =>
				assertEvent(
					this.options,
					'change',
					async () => {
						this.expected.obj.deep = { foo: 'bar', x: undefined };
						await writeFile(this.configFilePath, stringify({ [NAME]: this.expected }), 'utf-8');
					},
					(changeSpy) => {
						assert.equal(changeSpy.callCount, 2);
						assert.deepEqual(changeSpy.getCall(0).args, [
							['obj', 'deep', 'x'],
							this.expected.obj.deep.x,
							this.expected,
						]);
						assert.deepEqual(changeSpy.getCall(1).args, [
							['obj', 'deep', 'foo'],
							this.expected.obj.deep.foo,
							this.expected,
						]);
					}
				));

			it('should handle creating', () =>
				assertEvent(
					this.options,
					'change',
					async () => {
						this.expected.obj.newObj = { foo: 'bar' };
						await writeFile(this.configFilePath, stringify({ [NAME]: this.expected }), 'utf-8');
					},
					(changeSpy) => {
						assert.equal(changeSpy.callCount, 1);
						assert.deepEqual(changeSpy.getCall(0).args, [['obj', 'newObj'], this.expected.obj.newObj, this.expected]);
					}
				));

			it('should handle deleting', () =>
				assertEvent(
					this.options,
					'change',
					async () => {
						this.expected.obj.deep = undefined;
						await writeFile(this.configFilePath, stringify({ [NAME]: this.expected }), 'utf-8');
					},
					(changeSpy) => {
						assert.equal(changeSpy.callCount, 1);
						assert.deepEqual(changeSpy.getCall(0).args, [['obj', 'deep'], this.expected.obj.deep, this.expected]);
					}
				));
		});

		it('should handle updating an array to an object and vice versa', () =>
			assertEvent(
				this.options,
				'change',
				async () => {
					this.expected.arr = { foo: 'bar' };
					this.expected.obj = [1, 2, 3];
					await writeFile(this.configFilePath, stringify({ [NAME]: this.expected }), 'utf-8');
				},
				(changeSpy) => {
					assert.equal(changeSpy.callCount, 2);
					assert.deepEqual(changeSpy.getCall(0).args, [['arr'], this.expected.arr, this.expected]);
					assert.deepEqual(changeSpy.getCall(1).args, [['obj'], this.expected.obj, this.expected]);
				}
			));
	});

	describe('change event when root config value is a scalar', () => {
		it('should handle updating from scalar to scalar without throwing', async () => {
			const { fixture, configFilePath } = createFixture({ [NAME]: 'initialString' });
			const options = new OptionsWatcher(NAME, configFilePath);
			await options.ready;

			const newValue = 'updatedString';
			await assertEvent(
				options,
				'change',
				() => writeFile(configFilePath, stringify({ [NAME]: newValue }), 'utf-8'),
				(changeSpy) => {
					assert.equal(changeSpy.callCount, 1);
					assert.deepEqual(changeSpy.getCall(0).args, [[], newValue, newValue]);
					assert.equal(options.getAll(), newValue);
				}
			);

			await teardown({ fixture, options });
		});

		it('should handle updating from scalar to object without throwing', async () => {
			const { fixture, configFilePath } = createFixture({ [NAME]: 'initialString' });
			const options = new OptionsWatcher(NAME, configFilePath);
			await options.ready;

			const newValue = { foo: 'bar' };
			await assertEvent(
				options,
				'change',
				() => writeFile(configFilePath, stringify({ [NAME]: newValue }), 'utf-8'),
				(changeSpy) => {
					assert.equal(changeSpy.callCount, 1);
					assert.deepEqual(changeSpy.getCall(0).args, [[], newValue, newValue]);
					assert.deepEqual(options.getAll(), newValue);
				}
			);

			await teardown({ fixture, options });
		});

		it('should handle updating from object to scalar without throwing', async () => {
			const { fixture, configFilePath, options } = await setup();

			const newValue = 'scalar';
			await assertEvent(
				options,
				'change',
				() => writeFile(configFilePath, stringify({ [NAME]: newValue }), 'utf-8'),
				(changeSpy) => {
					assert.equal(changeSpy.callCount, 1);
					assert.deepEqual(changeSpy.getCall(0).args, [[], newValue, newValue]);
					assert.equal(options.getAll(), newValue);
				}
			);

			await teardown({ fixture, options });
		});
	});

	it('should handle default config resolution', async () => {
		this.timeout = 3000;
		const { fixture, configFilePath } = createFixture();
		// Manually remove the config file to test default resolution
		rmSync(configFilePath, { force: true });

		const name = 'jsResource';
		const options = new OptionsWatcher(name, join(fixture, 'config.yaml'));
		await options.ready;

		assert.deepEqual(options.getRoot(), DEFAULT_CONFIG, 'should return the default config if the file does not exist');
		assert.deepEqual(
			options.getAll(),
			DEFAULT_CONFIG[name],
			'should return the default config if the file does not exist'
		);

		const expected = { jsResource: { files: 'foo.js' } };

		// The scope booted on its own truthy default, which leaves it *unconfigured*, so the file
		// arriving is the unconfigured → configured transition `#applyScopedConfig` reports as a
		// second `ready` — not the merge a scope with a prior source value would take.
		let changed = 0;
		const countChanges = () => changed++;
		options.on('change', countChanges);
		await assertEvent(
			options,
			'ready',
			() => writeFile(configFilePath, stringify(expected), 'utf-8'),
			(readySpy) => {
				assert.equal(readySpy.callCount, 1);
				assert.deepEqual(
					readySpy.getCall(0).args,
					[expected[name]],
					'the arrival must carry the config that was written'
				);
				assert.equal(changed, 0, 'a truthy boot fallback is not a prior source value to merge against');
				assert.deepEqual(options.getRoot(), expected, 'should return the updated config after writing a new file');
				assert.deepEqual(options.getAll(), expected[name], 'should return the configuration after file recreation');
			}
		);
		options.removeListener('change', countChanges);

		await assertEvent(
			options,
			'remove',
			() => rm(configFilePath, { force: true }),
			(removeSpy) => {
				assert.equal(removeSpy.callCount, 1);
				assert.deepEqual(options.getRoot(), DEFAULT_CONFIG, 'should return the default config after file removal');
				assert.deepEqual(options.getAll(), DEFAULT_CONFIG[name], 'should return the default config after file removal');
			}
		);

		await teardown({ fixture, options });
	});

	describe('polling fallback on watcher exhaustion', () => {
		// harper#488: when ENOSPC/EMFILE fires on the underlying chokidar watcher,
		// the OptionsWatcher should swap to a polling watcher rather than surfacing
		// the error to consumers.

		it('falls back to polling on ENOSPC and continues to receive change events', async () => {
			const { fixture, configFilePath, options } = await setup();

			const errorSpy = spy();
			options.on('error', errorSpy);

			assert.equal(options._usingPollingForTests, false, 'should not be polling initially');

			// Simulate the underlying watcher emitting ENOSPC.
			options._simulateWatcherErrorForTests(Object.assign(new Error('boom'), { code: 'ENOSPC' }));

			// Wait a tick for the close + reopen to settle.
			await new Promise((resolve) => setTimeout(resolve, 50));

			assert.equal(options._usingPollingForTests, true, 'should have flipped to polling');
			assert.equal(errorSpy.callCount, 0, 'ENOSPC should be swallowed, not propagated');

			// Verify the polling watcher actually fires change events. The poll
			// interval is 1s, so allow up to ~3s for a change event to land.
			const updated = { ...CONFIG, [NAME]: { ...OPTIONS, str: 'after-fallback' } };
			await assertEvent(
				options,
				'change',
				() => writeFile(configFilePath, stringify(updated), 'utf-8'),
				(changeSpy) => {
					assert.ok(changeSpy.callCount >= 1, 'change event should fire after polling fallback');
				}
			);

			await teardown({ fixture, options });
		}).timeout(5000);

		it('propagates non-exhaustion errors and does not fall back', async () => {
			const { fixture, options } = await setup();

			const errorSpy = spy();
			options.on('error', errorSpy);

			options._simulateWatcherErrorForTests(Object.assign(new Error('boom'), { code: 'EACCES' }));

			await new Promise((resolve) => setTimeout(resolve, 20));

			assert.equal(options._usingPollingForTests, false, 'should not fall back for unrelated errors');
			assert.equal(errorSpy.callCount, 1, 'non-exhaustion error should propagate');

			await teardown({ fixture, options });
		});

		it('swallows additional exhaustion errors during recovery', async () => {
			// chokidar can fire several ENOSPC/EMFILE errors before the failed
			// native watcher finishes closing. Only the first should trigger the
			// fallback; subsequent ones must not be re-emitted to consumers.
			const { fixture, options } = await setup();

			const errorSpy = spy();
			options.on('error', errorSpy);

			const enospc = () => Object.assign(new Error('boom'), { code: 'ENOSPC' });
			options._simulateWatcherErrorForTests(enospc());
			options._simulateWatcherErrorForTests(enospc());
			options._simulateWatcherErrorForTests(Object.assign(new Error('boom'), { code: 'EMFILE' }));

			await new Promise((resolve) => setTimeout(resolve, 50));

			assert.equal(options._usingPollingForTests, true);
			assert.equal(errorSpy.callCount, 0, 'all exhaustion errors should be swallowed');

			await teardown({ fixture, options });
		});

		it('a synchronous throw from close() stays inside the reopen chain', async () => {
			// The reopen used to be spelled `Promise.resolve(this.#watcher.close())`, whose argument
			// is evaluated eagerly: a close() that throws synchronously threw out of the 'error'
			// listener itself, past the chained .catch(), and Node reported it as an uncaught
			// exception instead of reopening on polling.
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

			let options;
			let fixture;
			try {
				const created = createFixture();
				fixture = created.fixture;
				options = new OptionsWatcher(NAME, created.configFilePath);
				handlers.ready?.();
				await options.ready;

				assert.doesNotThrow(() => handlers.error(Object.assign(new Error('boom'), { code: 'ENOSPC' })));
				await new Promise((resolve) => setImmediate(resolve));

				assert.equal(options._usingPollingForTests, true, 'should have flipped to polling');
				assert.equal(options._openCountForTests, 2, 'should have reopened after the failed close()');
			} finally {
				chokidar.default.watch = realWatch;
				// The fake watcher's close() always throws; swap it for a real no-op before
				// teardown so options.close() (unrelated to this test) doesn't also throw.
				fakeWatcher.close = () => {};
				await options?.close();
				if (fixture) rmSync(fixture, { recursive: true, force: true });
			}
		});

		it('does not reopen watcher if close() is called during recovery', async () => {
			// Race condition: close() lands while the failed-watcher .close() promise
			// is still pending. The reopen-with-polling must not fire after the
			// OptionsWatcher has been closed, otherwise the new watcher leaks.
			const { fixture, configFilePath } = createFixture();
			const options = new OptionsWatcher(NAME, configFilePath);
			await options.ready;

			assert.equal(options._openCountForTests, 1, 'one initial open');

			// Trigger the fallback path, then immediately close before the inner
			// `await this.#watcher.close()` resolves.
			options._simulateWatcherErrorForTests(Object.assign(new Error('boom'), { code: 'ENOSPC' }));
			options.close();

			// Wait long enough for the failed-watcher close promise to resolve and
			// the `finally` callback to run (which should NOT reopen).
			await new Promise((resolve) => setTimeout(resolve, 100));

			assert.equal(options._openCountForTests, 1, 'reopen must be suppressed by the close-during-fallback guard');

			try {
				rmSync(fixture, { recursive: true, force: true });
				// eslint-disable-next-line sonarjs/no-ignored-exceptions
			} catch {
				// best-effort cleanup
			}
		});
	});
});
