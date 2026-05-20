'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sinon = require('sinon');
const rewire = require('rewire');

const { preTestPrep } = require('../testUtils.js');
const env = require('#src/utility/environment/environmentManager');

const STORAGE_RECLAMATION_PATH = '#js/server/storageReclamation';

describe('storageReclamation module', function () {
	let sandbox;
	let storageReclamation;
	let getWorkerIndexStub;
	let getWorkerCountStub;

	before(() => {
		env.initTestEnvironment();
		preTestPrep();
	});

	beforeEach(function () {
		sandbox = sinon.createSandbox();

		// Clear module cache to get fresh state
		delete require.cache[require.resolve(STORAGE_RECLAMATION_PATH)];

		// Stub thread functions before requiring the module
		const manageThreads = require('#js/server/threads/manageThreads');
		getWorkerIndexStub = sandbox.stub(manageThreads, 'getWorkerIndex').returns(0);
		getWorkerCountStub = sandbox.stub(manageThreads, 'getWorkerCount').returns(1);

		storageReclamation = rewire(STORAGE_RECLAMATION_PATH);
	});

	afterEach(function () {
		// Reset the space ratio getter
		if (storageReclamation) {
			storageReclamation.setAvailableSpaceRatioGetter(null);
		}

		// Clear any timers
		const timer = storageReclamation.__get__('reclamationTimer');
		if (timer) {
			clearTimeout(timer);
		}

		// Clear the handlers map
		const handlers = storageReclamation.__get__('reclamationHandlers');
		handlers.clear();

		sandbox.restore();
	});

	describe('onStorageReclamation', function () {
		it('should register handler when skipThreadCheck is true', function () {
			const handler = sandbox.stub();
			storageReclamation.onStorageReclamation('/test/path', handler, true);

			const handlers = storageReclamation.__get__('reclamationHandlers');
			assert.equal(handlers.size, 1);
			assert.ok(handlers.has('/test/path'));
			assert.equal(handlers.get('/test/path').length, 1);
		});

		it('should register handler on last worker thread', function () {
			// Worker index 0, worker count 1 means this is the last worker (0 === 1-1)
			getWorkerIndexStub.returns(0);
			getWorkerCountStub.returns(1);

			const handler = sandbox.stub();
			storageReclamation.onStorageReclamation('/test/path', handler);

			const handlers = storageReclamation.__get__('reclamationHandlers');
			assert.equal(handlers.size, 1);
		});

		it('should not register handler on non-last worker thread', function () {
			// Worker index 0, worker count 2 means this is NOT the last worker
			getWorkerIndexStub.returns(0);
			getWorkerCountStub.returns(2);

			// Need to reload module with new stub values
			delete require.cache[require.resolve(STORAGE_RECLAMATION_PATH)];
			storageReclamation = rewire(STORAGE_RECLAMATION_PATH);

			const handler = sandbox.stub();
			storageReclamation.onStorageReclamation('/test/path', handler);

			const handlers = storageReclamation.__get__('reclamationHandlers');
			assert.equal(handlers.size, 0);
		});

		it('should register multiple handlers for the same path', function () {
			const handler1 = sandbox.stub();
			const handler2 = sandbox.stub();

			storageReclamation.onStorageReclamation('/test/path', handler1, true);
			storageReclamation.onStorageReclamation('/test/path', handler2, true);

			const handlers = storageReclamation.__get__('reclamationHandlers');
			assert.equal(handlers.get('/test/path').length, 2);
		});

		it('should register handlers for different paths', function () {
			const handler1 = sandbox.stub();
			const handler2 = sandbox.stub();

			storageReclamation.onStorageReclamation('/path/one', handler1, true);
			storageReclamation.onStorageReclamation('/path/two', handler2, true);

			const handlers = storageReclamation.__get__('reclamationHandlers');
			assert.equal(handlers.size, 2);
			assert.ok(handlers.has('/path/one'));
			assert.ok(handlers.has('/path/two'));
		});

		it('should set reclamation timer after first handler registration', function () {
			const handler = sandbox.stub();
			storageReclamation.onStorageReclamation('/test/path', handler, true);

			const timer = storageReclamation.__get__('reclamationTimer');
			assert.ok(timer, 'Timer should be set');
		});

		it('should not create duplicate timers on subsequent registrations', function () {
			const handler1 = sandbox.stub();
			const handler2 = sandbox.stub();

			storageReclamation.onStorageReclamation('/test/path1', handler1, true);
			const firstTimer = storageReclamation.__get__('reclamationTimer');

			storageReclamation.onStorageReclamation('/test/path2', handler2, true);
			const secondTimer = storageReclamation.__get__('reclamationTimer');

			// Timer reference should be the same (not replaced)
			assert.strictEqual(firstTimer, secondTimer);
		});

		it('should initialize handler entry with priority 0', function () {
			const handler = sandbox.stub();
			storageReclamation.onStorageReclamation('/test/path', handler, true);

			const handlers = storageReclamation.__get__('reclamationHandlers');
			const entry = handlers.get('/test/path')[0];
			assert.equal(entry.priority, 0);
			assert.equal(entry.handler, handler);
		});
	});

	describe('setAvailableSpaceRatioGetter', function () {
		it('should allow setting custom space ratio getter', async function () {
			const customGetter = sandbox.stub().resolves(0.5);
			storageReclamation.setAvailableSpaceRatioGetter(customGetter);

			const handler = sandbox.stub();
			storageReclamation.onStorageReclamation('/test/path', handler, true);

			await storageReclamation.runReclamationHandlers();

			assert.ok(customGetter.calledOnce);
			assert.equal(customGetter.firstCall.args[0], '/test/path');
		});

		it('should reset to default getter when passed null', function () {
			const customGetter = sandbox.stub().resolves(0.5);
			storageReclamation.setAvailableSpaceRatioGetter(customGetter);
			storageReclamation.setAvailableSpaceRatioGetter(null);

			// The getter should be reset to default (we can't easily verify this without
			// calling runReclamationHandlers, which would hit the real filesystem)
			// This test mainly verifies no error is thrown
		});
	});

	describe('runReclamationHandlers', function () {
		it('should not call handler when space is above threshold', async function () {
			// 80% available space, well above 40% threshold
			const customGetter = sandbox.stub().resolves(0.8);
			storageReclamation.setAvailableSpaceRatioGetter(customGetter);

			const handler = sandbox.stub();
			storageReclamation.onStorageReclamation('/test/path', handler, true);

			await storageReclamation.runReclamationHandlers();

			// Handler should not be called because priority (0.4/0.8 = 0.5) is < 1
			assert.ok(handler.notCalled);
		});

		it('should call handler when space is below threshold', async function () {
			// 20% available space, below 40% threshold
			const customGetter = sandbox.stub().resolves(0.2);
			storageReclamation.setAvailableSpaceRatioGetter(customGetter);

			const handler = sandbox.stub().returns(Promise.resolve());
			storageReclamation.onStorageReclamation('/test/path', handler, true);

			await storageReclamation.runReclamationHandlers();

			// Handler should be called because priority (0.4/0.2 = 2) is > 1
			assert.ok(handler.calledOnce);
			// Priority should be 0.4/0.2 = 2
			assert.equal(handler.firstCall.args[0], 2);
		});

		it('should call handler with priority 0 after space is reclaimed', async function () {
			// First call: space is low (20%)
			// Second call: space is back to normal (80%)
			const customGetter = sandbox.stub();
			customGetter.onFirstCall().resolves(0.2);
			customGetter.onSecondCall().resolves(0.8);
			storageReclamation.setAvailableSpaceRatioGetter(customGetter);

			const handler = sandbox.stub().returns(Promise.resolve());
			storageReclamation.onStorageReclamation('/test/path', handler, true);

			// First run - space is low
			await storageReclamation.runReclamationHandlers();
			assert.equal(handler.callCount, 1);
			assert.equal(handler.firstCall.args[0], 2); // priority > 1

			// Second run - space is back to normal, but previousPriority was > 1
			await storageReclamation.runReclamationHandlers();
			assert.equal(handler.callCount, 2);
			assert.equal(handler.secondCall.args[0], 0); // priority 0 signals reclamation complete
		});

		it('should handle multiple paths independently', async function () {
			const customGetter = sandbox.stub();
			customGetter.withArgs('/path/low').resolves(0.2); // Low space
			customGetter.withArgs('/path/high').resolves(0.8); // High space
			storageReclamation.setAvailableSpaceRatioGetter(customGetter);

			const lowSpaceHandler = sandbox.stub().returns(Promise.resolve());
			const highSpaceHandler = sandbox.stub();

			storageReclamation.onStorageReclamation('/path/low', lowSpaceHandler, true);
			storageReclamation.onStorageReclamation('/path/high', highSpaceHandler, true);

			await storageReclamation.runReclamationHandlers();

			assert.ok(lowSpaceHandler.calledOnce);
			assert.ok(highSpaceHandler.notCalled);
		});

		it('should handle errors in space ratio getter gracefully', async function () {
			const customGetter = sandbox.stub().rejects(new Error('Disk error'));
			storageReclamation.setAvailableSpaceRatioGetter(customGetter);

			const handler = sandbox.stub();
			storageReclamation.onStorageReclamation('/test/path', handler, true);

			// Should not throw
			await storageReclamation.runReclamationHandlers();

			// Handler should not be called due to error
			assert.ok(handler.notCalled);
		});

		it('should handle errors in handler gracefully', async function () {
			const customGetter = sandbox.stub().resolves(0.2);
			storageReclamation.setAvailableSpaceRatioGetter(customGetter);

			const failingHandler = sandbox.stub().returns(Promise.reject(new Error('Handler error')));
			storageReclamation.onStorageReclamation('/test/path', failingHandler, true);

			// Should not throw
			await storageReclamation.runReclamationHandlers();

			assert.ok(failingHandler.calledOnce);
		});

		it('should call multiple handlers for the same path', async function () {
			const customGetter = sandbox.stub().resolves(0.2);
			storageReclamation.setAvailableSpaceRatioGetter(customGetter);

			const handler1 = sandbox.stub().returns(Promise.resolve());
			const handler2 = sandbox.stub().returns(Promise.resolve());

			storageReclamation.onStorageReclamation('/test/path', handler1, true);
			storageReclamation.onStorageReclamation('/test/path', handler2, true);

			await storageReclamation.runReclamationHandlers();

			assert.ok(handler1.calledOnce);
			assert.ok(handler2.calledOnce);
		});

		it('should not log when handler returns undefined', async function () {
			const customGetter = sandbox.stub().resolves(0.2);
			storageReclamation.setAvailableSpaceRatioGetter(customGetter);

			// Handler returns undefined (not a promise)
			const handler = sandbox.stub().returns(undefined);
			storageReclamation.onStorageReclamation('/test/path', handler, true);

			await storageReclamation.runReclamationHandlers();

			assert.ok(handler.calledOnce);
		});

		it('should not call handler when space is exactly at threshold', async function () {
			// 40% available space, exactly at 40% threshold
			// priority = 0.4 / 0.4 = 1.0, which is NOT > 1
			const customGetter = sandbox.stub().resolves(0.4);
			storageReclamation.setAvailableSpaceRatioGetter(customGetter);

			const handler = sandbox.stub();
			storageReclamation.onStorageReclamation('/test/path', handler, true);

			await storageReclamation.runReclamationHandlers();

			// Handler should not be called because priority (1.0) is not > 1
			assert.ok(handler.notCalled);
		});

		it('should reschedule timer after running handlers', async function () {
			const customGetter = sandbox.stub().resolves(0.8);
			storageReclamation.setAvailableSpaceRatioGetter(customGetter);

			const handler = sandbox.stub();
			storageReclamation.onStorageReclamation('/test/path', handler, true);

			const timerBefore = storageReclamation.__get__('reclamationTimer');
			await storageReclamation.runReclamationHandlers();
			const timerAfter = storageReclamation.__get__('reclamationTimer');

			// Timer should be rescheduled (new timer object)
			assert.ok(timerAfter);
			assert.notStrictEqual(timerBefore, timerAfter);
		});

		it('should update entry priority after each run', async function () {
			const customGetter = sandbox.stub().resolves(0.2);
			storageReclamation.setAvailableSpaceRatioGetter(customGetter);

			const handler = sandbox.stub().returns(Promise.resolve());
			storageReclamation.onStorageReclamation('/test/path', handler, true);

			const handlers = storageReclamation.__get__('reclamationHandlers');
			const entry = handlers.get('/test/path')[0];

			assert.equal(entry.priority, 0); // Initial priority

			await storageReclamation.runReclamationHandlers();

			// Priority should be updated to 0.4/0.2 = 2
			assert.equal(entry.priority, 2);
		});

		it('should not call handler on third run when space stays normal', async function () {
			// Scenario: low -> normal -> normal
			// First run: priority > 1, handler called
			// Second run: priority < 1, previousPriority > 1, handler called with 0
			// Third run: priority < 1, previousPriority < 1, handler NOT called
			const customGetter = sandbox.stub();
			customGetter.onFirstCall().resolves(0.2); // Low space
			customGetter.onSecondCall().resolves(0.8); // Normal space
			customGetter.onThirdCall().resolves(0.8); // Still normal
			storageReclamation.setAvailableSpaceRatioGetter(customGetter);

			const handler = sandbox.stub().returns(Promise.resolve());
			storageReclamation.onStorageReclamation('/test/path', handler, true);

			await storageReclamation.runReclamationHandlers();
			assert.equal(handler.callCount, 1); // Called due to low space

			await storageReclamation.runReclamationHandlers();
			assert.equal(handler.callCount, 2); // Called with 0 to signal reclamation complete

			await storageReclamation.runReclamationHandlers();
			assert.equal(handler.callCount, 2); // NOT called - space is normal and was normal before
		});

		it('should continue processing other paths after one path errors', async function () {
			const customGetter = sandbox.stub();
			customGetter.withArgs('/path/error').rejects(new Error('Disk error'));
			customGetter.withArgs('/path/ok').resolves(0.2);
			storageReclamation.setAvailableSpaceRatioGetter(customGetter);

			const errorPathHandler = sandbox.stub();
			const okPathHandler = sandbox.stub().returns(Promise.resolve());

			storageReclamation.onStorageReclamation('/path/error', errorPathHandler, true);
			storageReclamation.onStorageReclamation('/path/ok', okPathHandler, true);

			await storageReclamation.runReclamationHandlers();

			// First path should error, but second path should still be processed
			assert.ok(errorPathHandler.notCalled);
			assert.ok(okPathHandler.calledOnce);
		});
	});

	describe('quota mode', function () {
		const QUOTA_100GB = 100 * 1024 * 1024 * 1024;
		let tmpDir;
		let quotaStatusPath;
		let originalRootPath;

		beforeEach(function () {
			tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harper-quota-test-'));
			quotaStatusPath = path.join(tmpDir, 'quota-status.json');
			originalRootPath = env.get('rootPath');
			env.setProperty('rootPath', tmpDir);
		});

		afterEach(function () {
			env.setProperty('rootPath', originalRootPath);
			try {
				fs.rmSync(tmpDir, { recursive: true });
			} catch {}
		});

		describe('getQuotaStatus', function () {
			it('returns parsed object when file is present and valid', async function () {
				const data = { usedBytes: 50_000_000_000, quotaBytes: QUOTA_100GB, updatedAt: Date.now() };
				fs.writeFileSync(quotaStatusPath, JSON.stringify(data));
				assert.deepEqual(await storageReclamation.getQuotaStatus(), data);
			});

			it('returns undefined when file is absent', async function () {
				assert.equal(await storageReclamation.getQuotaStatus(), undefined);
			});

			it('returns undefined when file contains malformed JSON', async function () {
				fs.writeFileSync(quotaStatusPath, 'not-valid-json{');
				assert.equal(await storageReclamation.getQuotaStatus(), undefined);
			});
		});

		describe('defaultGetAvailableSpaceRatio', function () {
			beforeEach(function () {
				storageReclamation.setAvailableSpaceRatioGetter(undefined); // use real default
			});

			it('uses fresh quota-status file and triggers reclamation when headroom is low', async function () {
				const usedBytes = 65 * 1024 * 1024 * 1024; // 65 GB → 35% remaining → below 40% threshold
				fs.writeFileSync(
					quotaStatusPath,
					JSON.stringify({ usedBytes, quotaBytes: QUOTA_100GB, updatedAt: Date.now() })
				);

				const handler = sandbox.stub().returns(Promise.resolve());
				storageReclamation.onStorageReclamation(tmpDir, handler, true);
				await storageReclamation.runReclamationHandlers();

				assert.ok(handler.calledOnce);
				assert.ok(handler.firstCall.args[0] > 1); // priority = 0.4 / 0.35 ≈ 1.14
			});

			it('uses fresh quota-status file and does not trigger when headroom is sufficient', async function () {
				const usedBytes = 50 * 1024 * 1024 * 1024; // 50% used → 50% remaining → above threshold
				fs.writeFileSync(
					quotaStatusPath,
					JSON.stringify({ usedBytes, quotaBytes: QUOTA_100GB, updatedAt: Date.now() })
				);

				const handler = sandbox.stub();
				storageReclamation.onStorageReclamation(tmpDir, handler, true);
				await storageReclamation.runReclamationHandlers();

				assert.ok(handler.notCalled);
			});

			it('clamps ratio to 0 and triggers reclamation when usage exceeds quota', async function () {
				const usedBytes = 110 * 1024 * 1024 * 1024; // 10 GB over quota
				fs.writeFileSync(
					quotaStatusPath,
					JSON.stringify({ usedBytes, quotaBytes: QUOTA_100GB, updatedAt: Date.now() })
				);

				const handler = sandbox.stub().returns(Promise.resolve());
				storageReclamation.onStorageReclamation(tmpDir, handler, true);
				await storageReclamation.runReclamationHandlers();

				// Ratio clamped to 0 → priority = Infinity → handler called
				assert.ok(handler.calledOnce);
			});

			it('falls back to statfs when quota-status file is absent', async function () {
				const handler = sandbox.stub();
				storageReclamation.onStorageReclamation(tmpDir, handler, true);
				await assert.doesNotReject(storageReclamation.runReclamationHandlers());
			});

			it('falls back to statfs when quota-status file is stale', async function () {
				const staleTimestamp = Date.now() - 10 * 60 * 1000; // 10 minutes old
				fs.writeFileSync(
					quotaStatusPath,
					JSON.stringify({ usedBytes: 65 * 1024 * 1024 * 1024, quotaBytes: QUOTA_100GB, updatedAt: staleTimestamp })
				);

				const handler = sandbox.stub();
				storageReclamation.onStorageReclamation(tmpDir, handler, true);
				await assert.doesNotReject(storageReclamation.runReclamationHandlers());
			});
		});
	});
});
