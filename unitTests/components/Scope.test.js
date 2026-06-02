const { Scope, MissingDefaultFilesOptionError } = require('#src/components/Scope');
const { Models } = require('#src/resources/models/Models');
const { EventEmitter } = require('node:events');
const assert = require('node:assert/strict');
const { join, basename } = require('node:path');
const { tmpdir } = require('node:os');
const { mkdtempSync, writeFileSync, rmSync } = require('node:fs');
const { stringify } = require('yaml');
const { spy } = require('sinon');
const { OptionsWatcher } = require('#src/components/OptionsWatcher');
const { Resources } = require('#src/resources/Resources');
const { EntryHandler } = require('#src/components/EntryHandler');
const { restartNeeded, resetRestartNeeded } = require('#src/components/requestRestart');
const { writeFile } = require('node:fs/promises');
const { waitFor } = require('./waitFor.js');
const { ApplicationScope } = require('#src/components/ApplicationScope');
const { deployLifecycle, _resetForTests: resetDeployLifecycle } = require('#src/components/deployLifecycle');

describe('Scope', () => {
	beforeEach(() => {
		this.resources = new Resources();
		this.server = {};
		this.directory = mkdtempSync(join(tmpdir(), 'harper.unit-test.scope-'));
		this.appName = basename(this.directory);
		this.pluginName = 'plugin';
		this.configFilePath = join(this.directory, 'config.yaml');
		this.testFilePath = join(this.directory, 'test.js');
		writeFileSync(this.testFilePath, '"foo";');
		resetRestartNeeded();
	});

	afterEach(async () => {
		resetRestartNeeded();
		// Yield to the event loop so any in-flight chokidar watcher teardown
		// (from scope.close() in the test body) and any pending readFile
		// promises inside EntryHandler can settle before we remove the
		// temp directory. Otherwise, deleting test.js while a watcher event
		// is in flight surfaces a benign ENOENT through the watcher's error
		// path after the EntryHandler/OptionsWatcher have already removed
		// their listeners, which mocha sees as a duplicate done() with an
		// error. Observed flake on Node v24/v26 (tighter watcher timing).
		await new Promise((resolve) => setImmediate(resolve));
		try {
			rmSync(this.directory, { recursive: true, force: true });
			// eslint-disable-next-line sonarjs/no-ignored-exceptions
		} catch {
			// best effort to clean up - but doesn't matter too much since this is a temp directory
		}
	});

	it('should create a default entry handler', async () => {
		writeFileSync(this.configFilePath, stringify({ [this.pluginName]: { files: 'test.js' } }));

		const scope = new Scope(
			this.appName,
			this.pluginName,
			this.directory,
			this.configFilePath,
			new ApplicationScope('test', this.resources, this.server)
		);

		const readySpy = spy();
		scope.on('ready', readySpy);

		await scope.ready;

		assert.ok(readySpy.calledOnce, 'ready event should be emitted once');

		assert.ok(scope instanceof EventEmitter, 'Scope should be an instance of EventEmitter');
		assert.ok(scope.options instanceof OptionsWatcher, 'Scope should have an OptionsWatcher instance');
		assert.ok(scope.resources instanceof Resources, 'Scope should have a resources property of type Map');
		assert.ok(scope.server !== undefined, 'Scope should have a server property');
		assert.ok(scope.models instanceof Models, 'Scope should expose a Models facade as scope.models');
		assert.strictEqual(typeof scope.models.embed, 'function', 'scope.models.embed should be callable');
		assert.strictEqual(typeof scope.models.generate, 'function', 'scope.models.generate should be callable');
		assert.strictEqual(
			typeof scope.models.generateStream,
			'function',
			'scope.models.generateStream should be callable'
		);

		// Even though scope is ready, we haven't provided an entry handler yet so modifying a file matched by files option should not request a restart
		await writeFile(this.testFilePath, '"bar";');
		assert.equal(restartNeeded(), false, 'requestRestart should not be called');

		const entryHandlerNoArgs = scope.handleEntry();
		assert.ok(entryHandlerNoArgs instanceof EntryHandler, 'Entry handler should be created');

		// Now, since there is not entry handler function, modifying the file should request a restart
		await writeFile(this.testFilePath, '"baz";');
		await waitFor(() => restartNeeded());
		assert.equal(restartNeeded(), true, 'requestRestart should be called');

		// even though it doesn't do anything this counts as an all handler
		const entryHandlerFunctionArg = scope.handleEntry(() => {});
		assert.ok(entryHandlerFunctionArg instanceof EntryHandler, 'Entry handler should be created');

		assert.deepEqual(entryHandlerNoArgs, entryHandlerFunctionArg, 'Entry handlers should be the same');

		const scopeCloseSpy = spy();
		scope.on('close', scopeCloseSpy);

		const scopeOptionsCloseSpy = spy();
		scope.options.on('close', scopeOptionsCloseSpy);

		const entryHandlerCloseSpy = spy();
		entryHandlerNoArgs.on('close', entryHandlerCloseSpy);

		scope.close();
		assert.equal(scopeCloseSpy.callCount, 1, 'close event should be emitted once');
		assert.equal(scopeOptionsCloseSpy.callCount, 1, 'close event for options should be emitted once');
		assert.equal(entryHandlerCloseSpy.callCount, 1, 'close event for entry handler should be emitted once');
	});

	it('should create a default entry handler with urlPath', async () => {
		writeFileSync(this.configFilePath, stringify({ [this.pluginName]: { files: 'test.js', urlPath: 'abc' } }));

		const scope = new Scope(
			this.appName,
			this.pluginName,
			this.directory,
			this.configFilePath,
			new ApplicationScope('test', this.resources, this.server)
		);

		const readySpy = spy();
		scope.on('ready', readySpy);

		await scope.ready;

		assert.ok(readySpy.calledOnce, 'ready event should be emitted once');

		assert.ok(scope instanceof EventEmitter, 'Scope should be an instance of EventEmitter');
		assert.ok(scope.options instanceof OptionsWatcher, 'Scope should have an OptionsWatcher instance');
		assert.ok(scope.resources instanceof Resources, 'Scope should have a resources property of type Map');
		assert.ok(scope.server !== undefined, 'Scope should have a server property');

		const handleEntrySpy = spy();
		const entryHandler = scope.handleEntry(handleEntrySpy);
		assert.ok(entryHandler instanceof EntryHandler, 'Entry handler should be created');

		await writeFile(this.testFilePath, '"foo";');

		await waitFor(() => handleEntrySpy.callCount > 0);
		const callArgs = handleEntrySpy.getCall(0).args[0];
		assert.equal(callArgs.eventType, 'add', 'handleEntry argument `eventType` should be `add`');
		assert.equal(callArgs.entryType, 'file', 'handleEntry argument `entryType` should be `file`');
		assert.equal(
			callArgs.absolutePath,
			this.testFilePath,
			'handleEntry argument `absolutePath` should be the test file path'
		);
		assert.equal(callArgs.urlPath, '/abc/test.js', 'handleEntry argument `urlPath` should be `abc/test.js`');
		assert.ok(callArgs.stats !== undefined, 'add event argument `stats` should be defined');
		assert.ok(callArgs.stats.isFile(), 'add event argument `stats` should be a file');

		const scopeCloseSpy = spy();
		scope.on('close', scopeCloseSpy);

		const scopeOptionsCloseSpy = spy();
		scope.options.on('close', scopeOptionsCloseSpy);

		const entryHandlerCloseSpy = spy();
		entryHandler.on('close', entryHandlerCloseSpy);

		scope.close();
		assert.equal(scopeCloseSpy.callCount, 1, 'close event should be emitted once');
		assert.equal(scopeOptionsCloseSpy.callCount, 1, 'close event for options should be emitted once');
		assert.equal(entryHandlerCloseSpy.callCount, 1, 'close event for entry handler should be emitted once');
	});

	it('should call requestRestart if no entry handler is provided', async () => {
		writeFileSync(this.configFilePath, stringify({ [this.pluginName]: { files: '.' } }));

		const scope = new Scope(
			this.appName,
			this.pluginName,
			this.directory,
			this.configFilePath,
			this.resources,
			this.server
		);

		await scope.ready;

		const entryHandler = scope.handleEntry();

		// Wait for initial load to complete - the default behavior will trigger restart
		await entryHandler.ready;

		assert.equal(restartNeeded(), true, 'requestRestart was called');

		scope.close();
	});

	it('should call requestRestart if no options handler is provided', async () => {
		writeFileSync(this.configFilePath, stringify({ [this.pluginName]: { files: '.' } }));

		const scope = new Scope(
			this.appName,
			this.pluginName,
			this.directory,
			this.configFilePath,
			this.resources,
			this.server
		);

		await scope.ready;

		scope.handleEntry(() => {});

		assert.equal(restartNeeded(), false, 'requestRestart was not called');

		await writeFile(this.configFilePath, stringify({ [this.pluginName]: { files: '.', foo: 'bar' } }));

		await waitFor(() => restartNeeded());

		assert.equal(restartNeeded(), true, 'requestRestart was called');

		scope.close();
	});

	it('should emit error for missing default entry handler', async () => {
		writeFileSync(this.configFilePath, stringify({ [this.pluginName]: { foo: 'bar' } }));

		const scope = new Scope(
			this.appName,
			this.pluginName,
			this.directory,
			this.configFilePath,
			this.resources,
			this.server
		);

		await scope.ready;

		const errorSpy = spy();
		scope.on('error', errorSpy);

		const entryHandler = scope.handleEntry();
		assert.equal(entryHandler, undefined, 'Entry handler should be undefined');

		assert.equal(errorSpy.callCount, 1, 'error event should be emitted once');
		assert.deepEqual(
			errorSpy.getCall(0).args,
			[new MissingDefaultFilesOptionError()],
			'error event should be a missing default files option error'
		);

		scope.handleEntry(() => {});

		assert.equal(errorSpy.callCount, 2, 'error event should be emitted once');
		assert.deepEqual(
			errorSpy.getCall(1).args,
			[new MissingDefaultFilesOptionError()],
			'error event should be a missing default files option error'
		);

		assert.equal(restartNeeded(), false, 'requestRestart should not be called');

		scope.close();
	});

	it('should support custom entry handlers', async () => {
		writeFileSync(this.configFilePath, stringify({ [this.pluginName]: { foo: 'bar' } }));

		const scope = new Scope(
			this.appName,
			this.pluginName,
			this.directory,
			this.configFilePath,
			this.resources,
			this.server
		);

		await scope.ready;

		const customEntryHandlerPathOnlyArg = scope.handleEntry('.');
		assert.ok(customEntryHandlerPathOnlyArg instanceof EntryHandler, 'Custom entry handler should be created');

		// Reset restart flag - the first handler without a function triggers restart when it encounters files
		resetRestartNeeded();

		const customEntryHandlerPathAndFunctionArgs = scope.handleEntry('.', () => {});
		assert.ok(customEntryHandlerPathAndFunctionArgs instanceof EntryHandler, 'Custom entry handler should be created');

		assert.equal(restartNeeded(), false, 'requestRestart should not be called');

		const entryHandleCloseSpy1 = spy();
		const entryHandleCloseSpy2 = spy();

		customEntryHandlerPathOnlyArg.on('close', entryHandleCloseSpy1);
		customEntryHandlerPathAndFunctionArgs.on('close', entryHandleCloseSpy2);

		scope.close();

		assert.equal(entryHandleCloseSpy1.callCount, 1, 'close event for custom entry handler should be emitted once');
		assert.equal(entryHandleCloseSpy2.callCount, 1, 'close event for custom entry handler should be emitted once');
	});

	it('should support synchronous handleEntry with event-based initial load tracking', async () => {
		writeFileSync(this.configFilePath, stringify({ [this.pluginName]: { files: 'test.js' } }));

		const scope = new Scope(
			this.appName,
			this.pluginName,
			this.directory,
			this.configFilePath,
			this.resources,
			this.server
		);

		await scope.ready;

		const handleEntrySpy = spy();

		// Call handleEntry - returns EntryHandler immediately
		const entryHandler = scope.handleEntry(handleEntrySpy);

		// Should return an EntryHandler immediately (not a Promise)
		assert.ok(entryHandler instanceof EntryHandler, 'handleEntry should return EntryHandler synchronously');

		// Can listen for the ready event if needed
		const readySpy = spy();
		entryHandler.on('ready', readySpy);

		// Wait for initial load to complete
		await entryHandler.ready;
		assert.ok(readySpy.calledOnce, 'ready event should be emitted once');

		// Handler should be called for initial files
		await waitFor(() => handleEntrySpy.callCount > 0);
		assert.ok(handleEntrySpy.callCount > 0, 'Entry handler should be called');

		scope.close();
	});

	describe('deploy lifecycle integration', () => {
		// These cases ensure that when a deploy is in flight for the parent
		// component, file changes from the deploy itself (extract + npm install)
		// don't drive restart-request storms — see harper#488 and
		// components/deployLifecycle.ts.

		afterEach(() => {
			resetDeployLifecycle();
		});

		it('suppresses requestRestart while a deploy is in flight for the same component', async () => {
			writeFileSync(this.configFilePath, stringify({ [this.pluginName]: { files: 'test.js' } }));

			const scope = new Scope(
				this.appName,
				this.pluginName,
				this.directory,
				this.configFilePath,
				new ApplicationScope('test', this.resources, this.server)
			);
			await scope.ready;
			scope.handleEntry();

			// Sanity: outside a deploy, file change drives restart
			await writeFile(this.testFilePath, '"baz";');
			await waitFor(() => restartNeeded());
			assert.equal(restartNeeded(), true);
			resetRestartNeeded();

			// Enter a deploy
			deployLifecycle._handle({ name: this.appName, phase: 'start' });

			// File changes during the deploy must NOT request restart
			scope.requestRestart();
			assert.equal(restartNeeded(), false, 'requestRestart was suppressed during deploy');

			// Exit the deploy — restarts should be enabled again
			deployLifecycle._handle({ name: this.appName, phase: 'end' });
			scope.requestRestart();
			assert.equal(restartNeeded(), true, 'requestRestart works again after deploy:end');

			scope.close();
		});

		it('does not suppress requestRestart for an unrelated component', async () => {
			writeFileSync(this.configFilePath, stringify({ [this.pluginName]: { files: 'test.js' } }));

			const scope = new Scope(
				this.appName,
				this.pluginName,
				this.directory,
				this.configFilePath,
				new ApplicationScope('test', this.resources, this.server)
			);
			await scope.ready;

			deployLifecycle._handle({ name: 'some-other-component', phase: 'start' });

			scope.requestRestart();
			assert.equal(
				restartNeeded(),
				true,
				'requestRestart for this component must not be suppressed by an unrelated deploy'
			);

			scope.close();
		});

		it('pauses entry handlers on deploy:start and resumes them on deploy:end without losing plugin listeners', async () => {
			writeFileSync(this.configFilePath, stringify({ [this.pluginName]: { files: 'test.js' } }));

			const scope = new Scope(
				this.appName,
				this.pluginName,
				this.directory,
				this.configFilePath,
				new ApplicationScope('test', this.resources, this.server)
			);
			await scope.ready;

			// Register a plugin-style entry handler with a callback. Codex caught
			// the original close+recreate design dropping these callbacks; this
			// case guards against that regression.
			const handlerSpy = spy();
			const entryHandler = scope.handleEntry(handlerSpy);
			await entryHandler.ready;
			const callsBeforeDeploy = handlerSpy.callCount;
			assert.ok(callsBeforeDeploy > 0, 'plugin handler fires for initial files');

			// Enter and exit a deploy without touching the EntryHandler instance.
			deployLifecycle._handle({ name: this.appName, phase: 'start' });
			// Settle the pause's pending watcher.close() promise before resuming.
			await new Promise((r) => setTimeout(r, 50));
			deployLifecycle._handle({ name: this.appName, phase: 'end' });

			// The same EntryHandler instance keeps the plugin's callback; the
			// post-deploy re-scan should fire it again for the same file(s).
			await waitFor(() => handlerSpy.callCount > callsBeforeDeploy, 3000);

			// And the EntryHandler instance is unchanged — listener attachment is
			// preserved, not re-issued through a fresh wrapper.
			assert.strictEqual(scope.handleEntry(), entryHandler, 'same EntryHandler instance after pause/resume');

			// Subsequent post-deploy file changes still fire the plugin handler
			// (the wired listener is still attached).
			const callsAfterResume = handlerSpy.callCount;
			await writeFile(this.testFilePath, '"after-deploy";');
			await waitFor(() => handlerSpy.callCount > callsAfterResume);
			assert.ok(handlerSpy.callCount > callsAfterResume, 'post-deploy change fires the plugin handler');

			scope.close();
		});

		it('re-emits deploy:start and deploy:end on the scope for plugins to observe', async () => {
			writeFileSync(this.configFilePath, stringify({ [this.pluginName]: {} }));

			const scope = new Scope(
				this.appName,
				this.pluginName,
				this.directory,
				this.configFilePath,
				new ApplicationScope('test', this.resources, this.server)
			);
			await scope.ready;

			const startSpy = spy();
			const endSpy = spy();
			scope.on('deploy:start', startSpy);
			scope.on('deploy:end', endSpy);

			deployLifecycle._handle({ name: this.appName, phase: 'start' });
			deployLifecycle._handle({ name: this.appName, phase: 'end' });

			assert.equal(startSpy.callCount, 1);
			assert.deepEqual(startSpy.getCall(0).args, [this.appName]);
			assert.equal(endSpy.callCount, 1);
			assert.deepEqual(endSpy.getCall(0).args, [this.appName]);

			scope.close();
		});

		it('detaches deploy lifecycle listeners on scope.close()', async () => {
			writeFileSync(this.configFilePath, stringify({ [this.pluginName]: {} }));

			const scope = new Scope(
				this.appName,
				this.pluginName,
				this.directory,
				this.configFilePath,
				new ApplicationScope('test', this.resources, this.server)
			);
			await scope.ready;

			const beforeClose = deployLifecycle.listenerCount('deploy:start');
			scope.close();
			const afterClose = deployLifecycle.listenerCount('deploy:start');

			assert.equal(
				afterClose,
				beforeClose - 1,
				'scope.close() should remove its deploy:start listener from the module emitter'
			);
		});
	});
});
