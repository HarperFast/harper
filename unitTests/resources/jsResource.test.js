const { handleApplication } = require('#src/resources/jsResource');
const assert = require('node:assert/strict');
const { spy } = require('sinon');
const { writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { mkdtempSync, rmSync } = require('node:fs');

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
	// since they require secureImport and the full Harper runtime environment.
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
		};

		// Mock secureImport to throw an error
		const jsLoader = require('#src/security/jsLoader');
		const originalImport = jsLoader.secureImport;
		jsLoader.secureImport = async () => {
			throw testError;
		};

		try {
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
		} finally {
			// Restore original import
			jsLoader.secureImport = originalImport;
		}
	});
});
