'use strict';

const assert = require('node:assert');
const { handleStatusLog, initLogBridge } = require('#src/components/status/logBridge');
const { componentStatusRegistry } = require('#src/components/status/registry');
const { COMPONENT_STATUS_LEVELS } = require('#src/components/status/types');
const { setStatusHandler, createLogger } = require('#src/utility/logging/harper_logger');

describe('logBridge', function () {
	beforeEach(function () {
		componentStatusRegistry.reset();
		initLogBridge();
	});

	afterEach(function () {
		setStatusHandler(undefined);
		componentStatusRegistry.reset();
	});

	// Regression for #372: statusLogger() used to fire the level===null (status-only) dispatch
	// immediately and unconditionally, so a chained call like .status({problem}).error(msg) always
	// dispatched twice, doubling occurrenceCount for nearly every problem key this feature reports.
	it('logger.status({problem}).error(msg) registers exactly one occurrence', async function () {
		const logger = createLogger({ level: 'trace', writeToLog: () => {} });
		logger.status({ problem: 'test.harper-372-chained' }).error('boom');

		// the options-only dispatch (if any) is deferred to a microtask; let it flush
		await new Promise((resolve) => setImmediate(resolve));

		const status = componentStatusRegistry.getStatus('test.harper-372-chained');
		assert.ok(status, 'status should be registered');
		assert.equal(status.status, COMPONENT_STATUS_LEVELS.ERROR);
		assert.equal(status.message, 'boom');
		assert.equal(status.occurrenceCount, 1, 'occurrenceCount must not be inflated by a double dispatch');
	});

	it('a status-only call with no chained method still registers once', async function () {
		const logger = createLogger({ level: 'trace', writeToLog: () => {} });
		logger.status({ problem: 'test.harper-372-status-only' });

		await new Promise((resolve) => setImmediate(resolve));

		const status = componentStatusRegistry.getStatus('test.harper-372-status-only');
		assert.ok(status, 'status should be registered');
		assert.equal(status.status, COMPONENT_STATUS_LEVELS.ERROR);
		assert.equal(status.occurrenceCount, 1);
	});

	it('handleStatusLog(level=null) registers a problem directly against the registry', function () {
		handleStatusLog({ problem: 'test.status-only-direct' }, null, undefined, []);

		const status = componentStatusRegistry.getStatus('test.status-only-direct');
		assert.ok(status);
		assert.equal(status.status, COMPONENT_STATUS_LEVELS.ERROR);
	});

	it('handleStatusLog(level=null) with resolves clears the target status to healthy', function () {
		componentStatusRegistry.setStatus('test.to-resolve', COMPONENT_STATUS_LEVELS.ERROR, 'broken');

		handleStatusLog({ resolves: 'test.to-resolve' }, null, undefined, []);

		const status = componentStatusRegistry.getStatus('test.to-resolve');
		assert.equal(status.status, COMPONENT_STATUS_LEVELS.HEALTHY);
	});
});
