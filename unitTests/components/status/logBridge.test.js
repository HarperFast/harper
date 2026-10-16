'use strict';

const assert = require('node:assert');
const { handleStatusLog, initLogBridge } = require('#src/components/status/logBridge');
const { componentStatusRegistry } = require('#src/components/status/registry');
const { COMPONENT_STATUS_LEVELS } = require('#src/components/status/types');
const { waitFor } = require('../../waitFor.js');
const { setTimeout: delay } = require('node:timers/promises');
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

	for (const chained of [true, false]) {
		it(`expires a ${chained ? 'chained' : 'bare'} report back to healthy`, async function () {
			const logger = createLogger({ level: 'error', writeToLog: () => {} });
			const key = `test.expiry-${chained}`;
			const status = logger.status({ problem: key, expires: 0.03 });
			if (chained) status.error('temporary failure');
			await Promise.resolve();
			assert.equal(componentStatusRegistry.getStatus(key).status, COMPONENT_STATUS_LEVELS.ERROR);
			await waitFor(() => componentStatusRegistry.getStatus(key)?.status === COMPONENT_STATUS_LEVELS.HEALTHY, 2000);
			assert.equal(componentStatusRegistry.getStatus(key).message, 'Auto-expired');
		});
	}

	it('renews a repeated expiry and supports a changed duration', async function () {
		const logger = createLogger({ level: 'error', writeToLog: () => {} });
		const key = 'test.renew-expiry';
		try {
			const originalWindow = new Promise((resolve) =>
				setTimeout(() => resolve(componentStatusRegistry.getStatus(key)?.status), 60)
			);
			logger.status({ problem: key, expires: 0.03 }).error('first');
			logger.status({ problem: key, expires: 0.2 }).error('renewed');
			logger.status({ problem: key, expires: 0.2 }).error('renewed again');
			assert.equal(await originalWindow, COMPONENT_STATUS_LEVELS.ERROR);
			await waitFor(() => componentStatusRegistry.getStatus(key)?.status === COMPONENT_STATUS_LEVELS.HEALTHY, 2000);
		} finally {
			handleStatusLog({ resolves: key }, null, undefined, []);
		}
	});

	it('extends the original expiry when the same duration is reported again', async function () {
		const logger = createLogger({ level: 'error', writeToLog: () => {} });
		const key = 'test.refresh-expiry';
		try {
			logger.status({ problem: key, expires: 0.06 }).error('first');
			const originalWindow = new Promise((resolve) =>
				setTimeout(() => resolve(componentStatusRegistry.getStatus(key)?.status), 65)
			);
			await delay(10);
			logger.status({ problem: key, expires: 0.06 }).error('still failing');
			assert.equal(await originalWindow, COMPONENT_STATUS_LEVELS.ERROR);
			await waitFor(() => componentStatusRegistry.getStatus(key)?.status === COMPONENT_STATUS_LEVELS.HEALTHY, 2000);
		} finally {
			handleStatusLog({ resolves: key }, null, undefined, []);
		}
	});

	it('cancels old expiry for a bare persistent overwrite and for explicit resolution', async function () {
		const logger = createLogger({ level: 'error', writeToLog: () => {} });
		const key = 'test.persistent-overwrite';
		const resolved = 'test.explicit-resolution';
		try {
			logger.status({ problem: key, expires: 0.02 }).error('temporary');
			logger.status({ problem: key });
			logger.status({ problem: resolved, expires: 0.02 }).error('temporary');
			logger.status({ resolves: resolved }).info('fixed');
			await delay(60);
			assert.equal(componentStatusRegistry.getStatus(key).status, COMPONENT_STATUS_LEVELS.ERROR);
			assert.equal(componentStatusRegistry.getStatus(resolved).message, 'fixed');
		} finally {
			handleStatusLog({ resolves: key }, null, undefined, []);
			handleStatusLog({ resolves: resolved }, null, undefined, []);
		}
	});

	it('preserves tagged status logs and still reports status at filtered log levels', async function () {
		const output = [];
		const logger = createLogger({ level: 'error', writeToLog: (line) => output.push(line) }).withTag('test tagged');
		logger.status({ problem: 'test.harper-372-tagged' }).error('boom');
		await Promise.resolve();
		assert.equal(output.length, 1);
		assert.ok(output[0].includes('[test-tagged]'), 'status logs should preserve their logger tag');
		assert.ok(output[0].includes('boom'));
		assert.equal(componentStatusRegistry.getStatus('test.harper-372-tagged').status, COMPONENT_STATUS_LEVELS.ERROR);
		assert.equal(componentStatusRegistry.getStatus('test.harper-372-tagged').occurrenceCount, 1);

		logger.status({ problem: 'test.harper-372-filtered' }).debug('not logged');
		await Promise.resolve();
		assert.equal(output.length, 1);
		assert.equal(componentStatusRegistry.getStatus('test.harper-372-filtered').status, COMPONENT_STATUS_LEVELS.WARNING);
		assert.equal(componentStatusRegistry.getStatus('test.harper-372-filtered').occurrenceCount, 1);
	});

	it('reports status even when log formatting throws', async function () {
		const failure = new Error('Log formatting failed');
		const value = {
			[Symbol.for('nodejs.util.inspect.custom')]() {
				throw failure;
			},
		};
		const logger = createLogger({ level: 'error', writeToLog: () => {} }).withTag('failed-formatter');
		try {
			assert.throws(
				() => logger.status({ problem: 'test.harper-372-format-failure' }).error('boom', value),
				(error) => error === failure
			);
			await Promise.resolve();
			const status = componentStatusRegistry.getStatus('test.harper-372-format-failure');
			assert.ok(status, 'a failed log call should still report status');
			assert.equal(status.status, COMPONENT_STATUS_LEVELS.ERROR);
			assert.ok(status.message.startsWith('boom'));
			assert.equal(status.occurrenceCount, 1);
		} finally {
			// Formatting failed before the logger could restore its shared level.
			createLogger({ level: 'error', writeToLog: () => {} }).info('');
		}
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
