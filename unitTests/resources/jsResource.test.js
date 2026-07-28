const { handleApplication } = require('#src/resources/jsResource');
const assert = require('node:assert');
const { spy } = require('sinon');
const { writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { mkdtempSync, rmSync } = require('node:fs');
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

	it('requests a restart and re-registers when a loaded file is replaced in place', async () => {
		// An editor/atomic-rename save of an already-loaded resource reaches this plugin as
		// `unlink` then `add` for the same path. The unlink must request the restart (the old
		// module cannot be unloaded), and the re-add must still re-register so the resource stays
		// reachable during the restart debounce. Replaces the redeploy-specific coverage that the
		// EntryHandler-level fix made obsolete.
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

		const absolutePath = join(testDir, 'replaced.js');
		await capturedHandler({ entryType: 'file', eventType: 'add', absolutePath, urlPath: '/replaced.js' });
		assert.equal(mockScope.requestRestart.callCount, 0, 'the first load of a path does not restart');
		const registeredPaths = [...mockScope.resources.keys()].sort();
		assert.ok(registeredPaths.length > 0, 'the resource is registered on first load');

		await capturedHandler({ entryType: 'file', eventType: 'unlink', absolutePath, urlPath: '/replaced.js' });
		assert.equal(mockScope.requestRestart.callCount, 1, 'removing a loaded file requests the restart');
		assert.equal(importSpy.callCount, 1, 'unlink must not import');

		await capturedHandler({ entryType: 'file', eventType: 'add', absolutePath, urlPath: '/replaced.js' });
		assert.equal(mockScope.requestRestart.callCount, 1, 'the re-add rides the restart already requested');
		assert.deepEqual(
			[...mockScope.resources.keys()].sort(),
			registeredPaths,
			're-registering the same path stays idempotent — no stale duplicate endpoint'
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
