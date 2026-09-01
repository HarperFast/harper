const { Scope, MissingDefaultFilesOptionError } = require('#src/components/Scope');
const { Models } = require('#src/resources/models/Models');
const { EventEmitter } = require('node:events');
const assert = require('node:assert');
const { join, basename } = require('node:path');
const { tmpdir } = require('node:os');
const { pathToFileURL } = require('node:url');
const { mkdtempSync, writeFileSync, rmSync } = require('node:fs');
const { stringify } = require('yaml');
const { spy } = require('sinon');
const { OptionsWatcher } = require('#src/components/OptionsWatcher');
const { Resources } = require('#src/resources/Resources');
const { EntryHandler } = require('#src/components/EntryHandler');
const { restartNeeded, resetRestartNeeded } = require('#src/components/requestRestart');
const { writeFile } = require('node:fs/promises');
const { waitFor } = require('../waitFor.js');
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

		await scope.close();
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

		await scope.close();
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

		await scope.close();
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

		await scope.close();
	});

	it('should call requestRestart when the plugin config block is deleted', async () => {
		// Deleting a component's block emits `remove`, not `change`. Absence is the
		// canonical disabled state for opt-in built-ins (e.g. the /v1 models gateway),
		// so removal must restart just like a change would — otherwise the component
		// keeps serving until some unrelated restart.
		writeFileSync(this.configFilePath, stringify({ [this.pluginName]: { enabled: true } }));

		const scope = new Scope(
			this.appName,
			this.pluginName,
			this.directory,
			this.configFilePath,
			this.resources,
			this.server
		);

		await scope.ready;

		assert.equal(restartNeeded(), false, 'requestRestart should not be called yet');

		// Rewrite the config with the plugin's block deleted entirely
		await writeFile(this.configFilePath, stringify({ otherPlugin: { enabled: true } }));

		await waitFor(() => restartNeeded());

		assert.equal(restartNeeded(), true, 'requestRestart should be called on block removal');

		await scope.close();
	});

	it('should NOT call requestRestart on block removal when the plugin handles remove itself', async () => {
		writeFileSync(this.configFilePath, stringify({ [this.pluginName]: { enabled: true } }));

		const scope = new Scope(
			this.appName,
			this.pluginName,
			this.directory,
			this.configFilePath,
			this.resources,
			this.server
		);

		await scope.ready;

		const removeSpy = spy();
		scope.options.on('remove', removeSpy);

		await writeFile(this.configFilePath, stringify({ otherPlugin: { enabled: true } }));

		await waitFor(() => removeSpy.callCount > 0);

		assert.equal(removeSpy.callCount, 1, 'plugin remove handler should be invoked');
		assert.equal(restartNeeded(), false, 'plugin owns removal handling; no restart requested');

		await scope.close();
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

		await scope.close();
	});

	it('logs a forwarded child error when no scope error listener remains', async () => {
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

		assert.doesNotThrow(() => scope.options.emit('error', new Error('child listener failed')));
		await scope.close();
	});

	it('invalidates a runtime first loaded by a scope created during deploy', async () => {
		deployLifecycle._handle({ name: this.appName, phase: 'start' });
		try {
			const applicationScope = new ApplicationScope(this.appName, this.resources, this.server);
			applicationScope.runtimeRoot = this.directory;
			applicationScope.recordLoadedModule(pathToFileURL(this.testFilePath).href, Buffer.from('"foo";'));

			assert.equal(await applicationScope.finishDeploy(), true);
		} finally {
			deployLifecycle._handle({ name: this.appName, phase: 'end' });
		}
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

		await scope.close();

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

		await scope.close();
	});

	it('should not create entry handler from options change before handleEntry is called (RE-8)', async () => {
		// Reproduce the race in RE-8: OptionsWatcher fires a `change` event for the
		// `files` key BEFORE handleApplication (and thus handleEntry) runs. In the
		// broken code, #optionsWatcherChangeListener would create an entry handler
		// without any plugin callback attached. Chokidar's initial scan would then
		// emit `add` events with no consumer. When handleEntry was later called it
		// reused the existing handler — but the initial `add` events were already gone.
		writeFileSync(this.configFilePath, stringify({ [this.pluginName]: { files: 'test.js' } }));

		const scope = new Scope(
			this.appName,
			this.pluginName,
			this.directory,
			this.configFilePath,
			new ApplicationScope('test', this.resources, this.server)
		);

		await scope.ready;

		// Simulate the race: emit a `change` event on scope.options for the `files`
		// key, as if OptionsWatcher's second config read (triggered by chokidar's own
		// `ready` event) completed before handleApplication called handleEntry. In the
		// broken code this created an entry handler immediately, starting a chokidar
		// scan with no plugin callback attached.
		scope.options.emit('change', ['files'], 'test.js', { files: 'test.js' });

		// Yield to the event loop long enough for any spuriously-created entry handler
		// to start its chokidar watcher and complete its initial scan. In the broken
		// code the scan would fire `add` events here with no listener; in the fixed
		// code no entry handler is created at all during the change event.
		await new Promise((resolve) => setTimeout(resolve, 100));

		// Now call handleEntry — this is what jsResource.handleApplication does.
		// If the bug is present, the entry handler already exists (from the change
		// listener) and its initial scan has already fired and is gone. The callback
		// would never receive the initial `add` event and the test would time out.
		const handleEntrySpy = spy();
		const entryHandler = scope.handleEntry(handleEntrySpy);
		assert.ok(entryHandler instanceof EntryHandler, 'Entry handler should be created');

		// The callback must receive the initial `add` event for test.js.
		// In the buggy code this would time out because initial scan events are lost.
		await waitFor(() => handleEntrySpy.callCount > 0, {
			timeout: 2000,
			message: 'handleEntry callback must be called with initial add event (RE-8 regression)',
		});

		const firstCall = handleEntrySpy.getCall(0).args[0];
		assert.equal(firstCall.eventType, 'add', 'initial event should be `add`');
		assert.equal(firstCall.absolutePath, this.testFilePath, 'initial event should be for the test file');

		await scope.close();
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

			// Exit the deploy — the suppressed request is replayed once, after the gate is lowered.
			deployLifecycle._handle({ name: this.appName, phase: 'end' });
			assert.equal(restartNeeded(), true, 'a lasting restart request is replayed after deploy:end');

			await scope.close();
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

			await scope.close();
		});

		it('keeps entry handlers created during deploy paused until deploy:end', async () => {
			deployLifecycle._handle({ name: this.appName, phase: 'start' });
			const scope = new Scope(
				this.appName,
				this.pluginName,
				this.directory,
				this.configFilePath,
				new ApplicationScope(this.appName, this.resources, this.server)
			);
			try {
				const entries = [];
				const entryHandler = scope.handleEntry({ files: 'test.js' }, (entry) => entries.push(entry));
				let deployWaitResolved = false;
				const deployWait = scope.waitForDeployCompletion().then(() => {
					deployWaitResolved = true;
				});
				await waitFor(() => entryHandler._liveWatcherCountForTests === 0);
				assert.equal(entries.length, 0, 'a handler created mid-deploy must not scan the intermediate tree');
				assert.equal(deployWaitResolved, false, 'component loading remains gated by the active deploy');

				deployLifecycle._handle({ name: this.appName, phase: 'end' });
				await deployWait;
				await entryHandler.ready;
				assert.ok(entries.length > 0, 'the handler scans after deploy:end resumes it');
			} finally {
				if (deployLifecycle.isDeployInFlight(this.appName)) {
					deployLifecycle._handle({ name: this.appName, phase: 'end' });
				}
				await scope.close();
			}
		});

		it('resumes a mid-deploy scope when the deploy owner exits', async () => {
			const ownerThreadId = 41;
			deployLifecycle._handle({
				name: this.appName,
				phase: 'start',
				deploymentId: 'orphaned-deploy',
				ownerThreadId,
			});
			const scope = new Scope(
				this.appName,
				this.pluginName,
				this.directory,
				this.configFilePath,
				new ApplicationScope(this.appName, this.resources, this.server)
			);
			try {
				const entries = [];
				const entryHandler = scope.handleEntry({ files: 'test.js' }, (entry) => entries.push(entry));
				const deployWait = scope.waitForDeployCompletion();
				await waitFor(() => entryHandler._liveWatcherCountForTests === 0);

				deployLifecycle._reclaimOwner(ownerThreadId);
				await deployWait;
				await entryHandler.ready;

				assert.equal(deployLifecycle.isDeployInFlight(this.appName), false);
				assert.ok(entries.length > 0, 'reclaiming the dead owner resumes the paused handler');
			} finally {
				await scope.close();
			}
		});

		it('pauses entry handlers and emits the changed-file diff on deploy:end without losing plugin listeners', async () => {
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
			const entries = [];
			const entryHandler = scope.handleEntry((entry) => entries.push(entry));
			await entryHandler.ready;
			const callsBeforeDeploy = entries.length;
			assert.ok(callsBeforeDeploy > 0, 'plugin handler fires for initial files');

			// Enter and exit a deploy without touching the EntryHandler instance.
			deployLifecycle._handle({ name: this.appName, phase: 'start' });
			// Settle the pause's pending watcher.close() promise before resuming.
			await new Promise((r) => setTimeout(r, 50));
			await writeFile(this.testFilePath, '"deployed";');
			deployLifecycle._handle({ name: this.appName, phase: 'end' });

			// The same EntryHandler instance keeps the plugin's callback and translates the resumed
			// watcher's fresh add into the logical change relative to the pre-deploy generation.
			await waitFor(() => entries.length > callsBeforeDeploy, 3000);
			assert.equal(entries.at(-1).eventType, 'change');

			// And the EntryHandler instance is unchanged — listener attachment is
			// preserved, not re-issued through a fresh wrapper.
			assert.strictEqual(scope.handleEntry(), entryHandler, 'same EntryHandler instance after pause/resume');

			// Subsequent post-deploy file changes still fire the plugin handler
			// (the wired listener is still attached).
			const callsAfterResume = entries.length;
			await writeFile(this.testFilePath, '"after-deploy";');
			await waitFor(() => entries.length > callsAfterResume);
			assert.ok(entries.length > callsAfterResume, 'post-deploy change fires the plugin handler');

			await scope.close();
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

			await scope.close();
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
			await scope.close();
			const afterClose = deployLifecycle.listenerCount('deploy:start');

			assert.equal(
				afterClose,
				beforeClose - 1,
				'scope.close() should remove its deploy:start listener from the module emitter'
			);
		});
	});

	// The `server` proxy is what turns config into routing: it names every middleware entry after
	// the plugin and resolves the plugin's `urlPath`/`host` into the route the dispatcher matches.
	describe('server proxy routing injection', () => {
		const registerAndCapture = async (config, options, mount) => {
			writeFileSync(this.configFilePath, stringify({ [this.pluginName]: config }));
			const http = spy();
			const scope = new Scope(
				this.appName,
				this.pluginName,
				this.directory,
				this.configFilePath,
				new ApplicationScope('test', this.resources, { http }),
				undefined,
				undefined,
				mount
			);
			await scope.ready;
			scope.server.http(() => {}, options);
			await scope.close();
			return http.getCall(0).args[1];
		};

		it('names the entry after the plugin and resolves the configured urlPath', async () => {
			const injected = await registerAndCapture({ urlPath: 'assets' });
			assert.equal(injected.name, this.pluginName);
			assert.equal(injected.urlPath, '/assets/');
		});

		it('resolves a plugin-name-relative urlPath rather than passing it through raw', async () => {
			// A plugin that spreads its whole config section into these options (REST does) used to
			// hand the router the literal './', which normalized to the unmatchable route '/.'
			const injected = await registerAndCapture({ urlPath: './' }, { urlPath: './' });
			assert.equal(injected.urlPath, `/${this.pluginName}/`);
		});

		it('lets an explicit call option override the configured urlPath, still resolved', async () => {
			const injected = await registerAndCapture({ urlPath: 'assets' }, { urlPath: 'other' });
			assert.equal(injected.urlPath, '/other/');
		});

		it('carries the configured host', async () => {
			const injected = await registerAndCapture({ host: 'api.example.com' });
			assert.equal(injected.host, 'api.example.com');
		});

		it('leaves routing undefined when nothing configures it', async () => {
			const injected = await registerAndCapture({ files: 'test.js' });
			assert.equal(injected.urlPath, undefined);
			assert.equal(injected.host, undefined);
		});

		it('routes by the application mount declared in the root config', async () => {
			const injected = await registerAndCapture({ urlPath: 'assets' }, undefined, {
				host: 'api.example.com',
				urlPath: '/v1',
			});
			assert.equal(injected.host, 'api.example.com');
			assert.equal(injected.urlPath, '/v1/assets/');
		});

		it('mount host wins over a host the application shipped', async () => {
			const injected = await registerAndCapture({ host: 'www.shipped.example' }, undefined, {
				host: 'api.example.com',
			});
			assert.equal(injected.host, 'api.example.com');
		});

		// The mount is applied ONLY at the routing boundary. The router strips it before a handler
		// runs, so entry URL paths — and the resource paths graphqlSchema/jsResource derive from
		// them — must stay mount-relative or REST would look up a path nothing registered.
		it('does not leak the mount into the config the entry pipeline reads', async () => {
			writeFileSync(this.configFilePath, stringify({ [this.pluginName]: { files: 'test.js', urlPath: 'assets' } }));
			const scope = new Scope(
				this.appName,
				this.pluginName,
				this.directory,
				this.configFilePath,
				new ApplicationScope('test', this.resources, { http: spy() }),
				undefined,
				undefined,
				{ urlPath: '/v1' }
			);
			await scope.ready;
			assert.equal(scope.options.getAll().urlPath, 'assets', 'plugin config stays as authored');
			await scope.close();
		});
	});

	// REST deduplicates its registration per route, so the route identity must be injective: two
	// configurations that resolve to different routes must not produce the same one. Composing the
	// mount with the plugin's *raw* urlPath collided (mount '/a' + 'bc' and mount '/ab' + 'c' both
	// gave '/abc'), which would silently skip the second application's REST registration.
	describe('routeFor', () => {
		const routeFor = async (config, mount, options) => {
			writeFileSync(this.configFilePath, stringify({ [this.pluginName]: config }));
			const scope = new Scope(
				this.appName,
				this.pluginName,
				this.directory,
				this.configFilePath,
				new ApplicationScope('test', this.resources, { http: spy() }),
				undefined,
				undefined,
				mount
			);
			await scope.ready;
			const route = scope.routeFor(options);
			await scope.close();
			return route;
		};

		it('distinguishes routes that a raw concatenation would collide', async () => {
			const a = await routeFor({ urlPath: 'bc' }, { urlPath: '/a' });
			const b = await routeFor({ urlPath: 'c' }, { urlPath: '/ab' });
			assert.equal(a.urlPath, '/a/bc/');
			assert.equal(b.urlPath, '/ab/c/');
			assert.notEqual(a.urlPath, b.urlPath);
		});

		it('resolves the same route for configurations that are genuinely the same mount', async () => {
			// A mount of '/api' with no plugin path and a plugin path of '/api' with no mount both
			// answer on '/api' — the same chain, so REST should register once.
			const mounted = await routeFor({}, { urlPath: '/api' });
			const pluginOnly = await routeFor({ urlPath: '/api' }, undefined);
			assert.equal(mounted.urlPath, pluginOnly.urlPath);
		});

		it('keeps host and path separable', async () => {
			const route = await routeFor({}, { host: 'api.example.com', urlPath: '/v1' });
			assert.deepEqual(route, { host: 'api.example.com', urlPath: '/v1/' });
		});

		it('matches what the server proxy injects', async () => {
			writeFileSync(this.configFilePath, stringify({ [this.pluginName]: { urlPath: 'assets' } }));
			const http = spy();
			const scope = new Scope(
				this.appName,
				this.pluginName,
				this.directory,
				this.configFilePath,
				new ApplicationScope('test', this.resources, { http }),
				undefined,
				undefined,
				{ host: 'api.example.com', urlPath: '/v1' }
			);
			await scope.ready;
			const expected = scope.routeFor(undefined);
			scope.server.http(() => {});
			const injected = http.getCall(0).args[1];
			assert.equal(injected.urlPath, expected.urlPath);
			assert.equal(injected.host, expected.host);
			await scope.close();
		});
	});

	describe('externalBasePath', () => {
		const scopeWithMount = async (mount) => {
			writeFileSync(this.configFilePath, stringify({ [this.pluginName]: { files: 'test.js' } }));
			const scope = new Scope(
				this.appName,
				this.pluginName,
				this.directory,
				this.configFilePath,
				new ApplicationScope('test', this.resources, { http: spy() }),
				undefined,
				undefined,
				mount
			);
			await scope.ready;
			return scope;
		};

		it('prefixes the mount so a client-facing path points inside the mount', async () => {
			const scope = await scopeWithMount({ urlPath: '/v1' });
			assert.equal(scope.externalBasePath('/assets/'), '/v1/assets/');
			assert.equal(scope.externalBasePath('/'), '/v1/');
			await scope.close();
		});

		it('is identity when the application has no path mount', async () => {
			const scope = await scopeWithMount(undefined);
			assert.equal(scope.externalBasePath('/assets/'), '/assets/');
			await scope.close();

			const hostOnly = await scopeWithMount({ host: 'api.example.com' });
			assert.equal(hostOnly.externalBasePath('/assets/'), '/assets/');
			await hostOnly.close();
		});
	});

	describe('initial load failure (#1917)', () => {
		let openScopes;

		beforeEach(() => {
			openScopes = [];
		});

		// Closed here rather than at the end of each test so a failed assertion cannot leave a chokidar
		// watcher running over the directory afterEach is about to delete.
		afterEach(async () => {
			await Promise.allSettled(openScopes.map((scope) => scope.close()));
		});

		const scopeForFiles = async (files) => {
			writeFileSync(this.configFilePath, stringify({ [this.pluginName]: { files } }));
			const scope = new Scope(
				this.appName,
				this.pluginName,
				this.directory,
				this.configFilePath,
				new ApplicationScope('test', this.resources, this.server)
			);
			openScopes.push(scope);
			await scope.ready;
			return scope;
		};

		it("settles waitForInitialLoads with the entry handler's own error", async () => {
			const scope = await scopeForFiles('test.js');
			const failure = new Error('invalid schema');
			scope.handleEntry(async () => {
				throw failure;
			});

			const initialLoad = scope.waitForInitialLoads();
			await assert.rejects(initialLoad, (error) => error === failure);

			// The settled load is dropped from the pending set, so a later wait has nothing to await.
			await new Promise((resolve) => setImmediate(resolve));
			await scope.waitForInitialLoads();
		});

		it('raises no unhandled rejection when the initial load fails', async () => {
			const unhandled = [];
			const onUnhandled = (reason) => unhandled.push(reason);
			process.on('unhandledRejection', onUnhandled);
			let scope;
			try {
				scope = await scopeForFiles('test.js');
				scope.handleEntry(async () => {
					throw new Error('invalid schema');
				});
				await assert.rejects(scope.waitForInitialLoads());
				// Node reports an unhandled rejection at the end of a macrotask, so give it two.
				await new Promise((resolve) => setImmediate(resolve));
				await new Promise((resolve) => setImmediate(resolve));
			} finally {
				process.off('unhandledRejection', onUnhandled);
			}
			assert.deepEqual(unhandled, [], 'a failed initial load must not leak an unhandled rejection');
		});

		it('reports a handler rejection after the initial load without leaking an unhandled rejection', async () => {
			const scope = await scopeForFiles('test.js');
			let calls = 0;
			scope.handleEntry(async () => {
				if (++calls > 1) throw new Error('reload failed');
			});
			await scope.waitForInitialLoads();

			const unhandled = [];
			const onUnhandled = (reason) => unhandled.push(reason);
			process.on('unhandledRejection', onUnhandled);
			try {
				await writeFile(this.testFilePath, '"changed";');
				await waitFor(() => calls > 1, { timeout: 5000, message: 'the change must reach the entry handler' });
				for (let turn = 0; turn < 10; turn++) await new Promise((resolve) => setImmediate(resolve));
			} finally {
				process.off('unhandledRejection', onUnhandled);
			}
			assert.deepEqual(unhandled, [], 'a post-initial-load handler rejection must not leak');
		});

		it('drains sibling initial-load operations before surfacing the failure', async () => {
			writeFileSync(join(this.directory, 'broken.js'), '"broken";');
			writeFileSync(join(this.directory, 'slow.js'), '"slow";');
			const scope = await scopeForFiles('*.js');

			let releaseSlow;
			const slow = new Promise((resolve) => {
				releaseSlow = resolve;
			});
			let slowFinished = false;
			const entryHandler = scope.handleEntry(async (entry) => {
				if (entry.absolutePath.endsWith('broken.js')) throw new Error('broken.js is invalid');
				if (!entry.absolutePath.endsWith('slow.js')) return;
				await slow;
				slowFinished = true;
			});

			const initialLoad = scope.waitForInitialLoads();
			let settled = false;
			const markSettled = () => {
				settled = true;
			};
			initialLoad.then(markSettled, markSettled);

			// Draining only begins once the initial scan reports ready; before that a fail-fast
			// implementation and a draining one are indistinguishable. A fail-fast drain settles within
			// microtasks of `ready`, so turns of the event loop separate the two without a wall clock.
			await entryHandler.ready;
			for (let turn = 0; turn < 10; turn++) await new Promise((resolve) => setImmediate(resolve));
			assert.strictEqual(
				settled,
				false,
				'the load must not report the failure while a sibling operation still holds the load lock'
			);

			releaseSlow();
			await assert.rejects(initialLoad, /broken\.js is invalid/);
			assert.strictEqual(slowFinished, true, 'the sibling operation must have run to completion');
		});
	});
});
