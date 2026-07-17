const { handleApplication } = require('#src/resources/jsResource');
const assert = require('node:assert');
const { spy } = require('sinon');
const { writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { mkdtempSync, rmSync } = require('node:fs');
const { EventEmitter } = require('node:events');
const { setupTestDBPath } = require('../testUtils');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { defineTable, types } = require('#src/resources/defineTable');

describe('jsResource', () => {
	let testDir;

	beforeEach(() => {
		testDir = mkdtempSync(join(tmpdir(), 'jsresource-test-'));
	});

	afterEach(() => {
		try {
			rmSync(testDir, { recursive: true, force: true });
		} catch {
			// best effort cleanup
		}
	});

	// Note: Tests for successful resource loading are covered by integration tests
	// (see integrationTests/apiTests/tests/17a_addComponents.mjs)
	// since they require scopedImport and the full Harper runtime environment.
	// These unit tests focus on error handling and edge cases that don't require actual imports.

	it('should warn on non-file entry type', async () => {
		const loggerSpy = {
			warn: spy(),
			debug: spy(),
			error: spy(),
		};

		const mockScope = {
			handleEntry: spy(async (handler) => {
				await handler({
					entryType: 'directory',
					eventType: 'addDir',
					absolutePath: testDir,
					urlPath: '/some-dir',
				});
			}),
			resources: new Map(),
			logger: loggerSpy,
			configFilePath: '/test/config.yaml',
			requestRestart: spy(),
		};

		await handleApplication(mockScope);

		assert.equal(loggerSpy.warn.callCount, 1, 'Should log warning');
		assert.ok(
			loggerSpy.warn.firstCall.args[0].includes('cannot handle entry type directory'),
			'Warning should mention entry type'
		);
	});

	it('should request restart on non-add event', async () => {
		const resourceFile = join(testDir, 'resource.js');
		writeFileSync(resourceFile, 'export default { get() {} };');

		const mockScope = {
			handleEntry: spy(async (handler) => {
				await handler({
					entryType: 'file',
					eventType: 'change',
					absolutePath: resourceFile,
					urlPath: '/resource.js',
				});
			}),
			resources: new Map(),
			logger: { warn: spy(), debug: spy(), error: spy() },
			requestRestart: spy(),
		};

		await handleApplication(mockScope);

		assert.equal(mockScope.requestRestart.callCount, 1, 'Should request restart');
	});

	it('should rethrow errors with file path context', async () => {
		const testFile = join(testDir, 'bad-resource.js');
		const testError = new Error('Import failed');

		let capturedHandler;
		const mockScope = {
			handleEntry: spy((handler) => {
				// Capture the handler so we can invoke it and catch its error
				capturedHandler = handler;
			}),
			resources: new Map(),
			logger: { warn: spy(), debug: spy(), error: spy() },
			requestRestart: spy(),
			import() {
				throw testError;
			},
		};

		// Mock scopedImport to throw an error
		const _jsLoader = require('#src/security/jsLoader');

		// handleApplication registers the handler
		await handleApplication(mockScope);

		// Now invoke the handler and expect it to throw
		await assert.rejects(
			async () =>
				await capturedHandler({
					entryType: 'file',
					eventType: 'add',
					absolutePath: testFile,
					urlPath: '/bad-resource.js',
				}),
			(error) => {
				// Should rethrow with context
				assert.equal(error.name, 'ResourceLoadError', 'Error should be ResourceLoadError');
				assert.ok(error.message.includes('Failed to load resource module'), 'Error should include context message');
				assert.ok(error.message.includes(testFile), 'Error should include file path');
				assert.ok(error.message.includes('Import failed'), 'Error should include original error');
				assert.equal(error.filePath, testFile, 'Error should have filePath property');
				assert.equal(error.cause, testError, 'Error should preserve original error as cause');
				return true;
			}
		);
	});

	it('requests a restart when an already-loaded file is re-added (redeploy re-scan)', async () => {
		// A redeploy pauses/resumes the watcher; the fresh chokidar scan re-emits every existing
		// file as `add`, including one whose contents just changed. The first add loads the module;
		// the second add for the same path must be treated like a change — flag a restart and NOT
		// re-import stale cached code (harper#1817).
		setupTestDBPath();
		setMainIsWorker(true);
		const resourceFile = join(testDir, 'resources.js');
		writeFileSync(resourceFile, 'export default { get() {} };');

		let capturedHandler;
		const importSpy = spy(async () => ({ default: { get() {} } }));
		const mockScope = {
			handleEntry: spy((handler) => {
				capturedHandler = handler;
			}),
			resources: new Map(),
			logger: { warn: spy(), debug: spy(), error: spy() },
			requestRestart: spy(),
			import: importSpy,
		};

		await handleApplication(mockScope);

		const addEvent = {
			entryType: 'file',
			eventType: 'add',
			absolutePath: resourceFile,
			urlPath: '/resources.js',
		};

		// Initial load: registers, no restart.
		await capturedHandler(addEvent);
		assert.equal(mockScope.requestRestart.callCount, 0, 'initial add should not request a restart');
		assert.equal(importSpy.callCount, 1, 'initial add should import the module once');

		// Redeploy re-scan: same file re-emitted as `add` → treat like a change.
		await capturedHandler(addEvent);
		assert.equal(mockScope.requestRestart.callCount, 1, 're-add of a loaded file should request a restart');
		assert.equal(importSpy.callCount, 1, 're-add should NOT re-import (avoids serving stale cached code)');
	});

	it('loads a genuinely new file added at runtime without requesting a restart', async () => {
		// A first-time `add` for a path never seen before (e.g. a new resource file dropped in at
		// runtime) must still hot-load without forcing a restart — only re-adds of known files do.
		setupTestDBPath();
		setMainIsWorker(true);

		let capturedHandler;
		const importSpy = spy(async () => ({ default: { get() {} } }));
		const mockScope = {
			handleEntry: spy((handler) => {
				capturedHandler = handler;
			}),
			resources: new Map(),
			logger: { warn: spy(), debug: spy(), error: spy() },
			requestRestart: spy(),
			import: importSpy,
		};

		await handleApplication(mockScope);

		await capturedHandler({
			entryType: 'file',
			eventType: 'add',
			absolutePath: join(testDir, 'first.js'),
			urlPath: '/first.js',
		});
		await capturedHandler({
			entryType: 'file',
			eventType: 'add',
			absolutePath: join(testDir, 'second.js'),
			urlPath: '/second.js',
		});

		assert.equal(mockScope.requestRestart.callCount, 0, 'distinct new files should not request a restart');
		assert.equal(importSpy.callCount, 2, 'each distinct new file should be imported');
	});

	it('requests a restart when a loaded file is missing from a redeploy re-scan (deletion)', async () => {
		// A redeploy's fresh chokidar scan only reports files that still exist on disk — a file
		// deleted during the redeploy produces no event at all (no re-`add`, no `unlink`), so the
		// re-`add` handling above never sees it. jsResource must diff the loaded-files set against
		// what the scan actually reported once its `ready` fires, and flag a restart for anything
		// missing (harper#1817 follow-up: deletion gap).
		setupTestDBPath();
		setMainIsWorker(true);
		const resourceFile = join(testDir, 'resources.js');
		writeFileSync(resourceFile, 'export default { get() {} };');

		let capturedHandler;
		// A real EventEmitter stands in for the EntryHandler scope.handleEntry() returns in
		// production — jsResource listens for its 'ready' event to know when a scan pass completed.
		const entryHandlerStub = new EventEmitter();
		const importSpy = spy(async () => ({ default: { get() {} } }));
		// The scope itself is an EventEmitter in production (deploy:start/deploy:end); mirror that
		// so jsResource can arm the post-redeploy diff window the same way it does against a real Scope.
		const mockScope = Object.assign(new EventEmitter(), {
			handleEntry: spy((handler) => {
				capturedHandler = handler;
				return entryHandlerStub;
			}),
			resources: new Map(),
			logger: { warn: spy(), debug: spy(), error: spy() },
			requestRestart: spy(),
			import: importSpy,
		});

		await handleApplication(mockScope);

		// Initial scan: the file loads, then the entry handler's scan completes.
		await capturedHandler({
			entryType: 'file',
			eventType: 'add',
			absolutePath: resourceFile,
			urlPath: '/resources.js',
		});
		entryHandlerStub.emit('ready');
		assert.equal(mockScope.requestRestart.callCount, 0, 'initial scan should not request a restart');

		// Redeploy: Scope pauses the watcher (deploy:start) then resumes it; resourceFile was deleted,
		// so the fresh scan's re-`add` pass reports nothing for it at all — no event fires. Only the
		// scan-complete diff, armed by deploy:start, can catch this.
		mockScope.emit('deploy:start', 'test-app');
		entryHandlerStub.emit('ready');
		assert.equal(
			mockScope.requestRestart.callCount,
			1,
			'a file missing from the redeploy re-scan should request a restart'
		);
	});

	it('does not treat other loaded files as deleted when `ready` refires after an ordinary runtime add', async () => {
		// EntryHandler's `ready` isn't scoped to full rescans: it also refires after every ordinary
		// add/change once that file's read settles, because its initial-scan-complete latch never
		// resets outside a full rescan (see EntryHandler#checkIfAllComplete). A naive deletion diff
		// keyed off every `ready` would see only the just-added file in view and treat every other
		// already-loaded file as deleted, breaking hot-load-without-restart for multi-file components.
		// The diff must only run inside a genuine redeploy window (deploy:start -> next ready).
		setupTestDBPath();
		setMainIsWorker(true);
		const fileA = join(testDir, 'a.js');
		const fileB = join(testDir, 'b.js');
		writeFileSync(fileA, 'export default { get() {} };');
		writeFileSync(fileB, 'export default { get() {} };');

		let capturedHandler;
		const entryHandlerStub = new EventEmitter();
		const importSpy = spy(async () => ({ default: { get() {} } }));
		const mockScope = Object.assign(new EventEmitter(), {
			handleEntry: spy((handler) => {
				capturedHandler = handler;
				return entryHandlerStub;
			}),
			resources: new Map(),
			logger: { warn: spy(), debug: spy(), error: spy() },
			requestRestart: spy(),
			import: importSpy,
		});

		await handleApplication(mockScope);

		// Initial scan loads fileA only, then settles.
		await capturedHandler({ entryType: 'file', eventType: 'add', absolutePath: fileA, urlPath: '/a.js' });
		entryHandlerStub.emit('ready');
		assert.equal(mockScope.requestRestart.callCount, 0, 'initial scan should not request a restart');

		// Genuinely new file dropped in at runtime (no redeploy in progress): loads without a restart,
		// then EntryHandler's `ready` refires (its steady-state behavior, not a rescan boundary).
		await capturedHandler({ entryType: 'file', eventType: 'add', absolutePath: fileB, urlPath: '/b.js' });
		entryHandlerStub.emit('ready');

		assert.equal(
			mockScope.requestRestart.callCount,
			0,
			'a ready refire outside a redeploy window must not treat fileA as deleted'
		);

		// Confirm neither file's loaded-tracking was corrupted by the earlier spurious `ready`: a
		// later genuine redeploy re-scan (both files still present, as a real fresh scan would report)
		// still recognizes them as known — restart requested, neither re-imported — rather than
		// mistakenly re-importing a file the bug had wrongly forgotten.
		const restartCountBeforeRedeploy = mockScope.requestRestart.callCount;
		mockScope.emit('deploy:start', 'test-app');
		await capturedHandler({ entryType: 'file', eventType: 'add', absolutePath: fileA, urlPath: '/a.js' });
		await capturedHandler({ entryType: 'file', eventType: 'add', absolutePath: fileB, urlPath: '/b.js' });
		entryHandlerStub.emit('ready');

		assert.ok(
			mockScope.requestRestart.callCount > restartCountBeforeRedeploy,
			'a real redeploy re-scan of known files should still request a restart'
		);
		assert.equal(
			importSpy.callCount,
			2,
			'neither fileA nor fileB should be re-imported (both still tracked as loaded)'
		);
	});

	it('exposes an exported defineTable handle as an endpoint', async () => {
		// `defineTable` registers eagerly at import time; the handle is a real table class, so the
		// existing export walk exposes it — the code-first analog of GraphQL's @export, and the same
		// semantics `export class X extends tables.X {}` has today. No loader special-casing.
		setupTestDBPath();
		setMainIsWorker(true);
		const Widget = defineTable(
			'Widget',
			{ id: types.id.primaryKey, name: types.string },
			{ database: 'jsresource_codefirst' }
		);
		const resourceModule = { Widget };

		let capturedHandler;
		const mockScope = {
			handleEntry: spy((handler) => {
				capturedHandler = handler;
			}),
			resources: new Map(),
			logger: { warn: spy(), debug: spy(), error: spy() },
			requestRestart: spy(),
			import: async () => resourceModule,
		};

		await handleApplication(mockScope);
		await capturedHandler({
			entryType: 'file',
			eventType: 'add',
			absolutePath: join(testDir, 'resources.js'),
			urlPath: '/resources.js',
		});

		assert.equal(mockScope.resources.get('/Widget'), Widget, 'exported handle registered at its export name');
	});
});
