'use strict';

const assert = require('node:assert');
const { handleStatusLog, initLogBridge } = require('#src/components/status/logBridge');
const { componentStatusRegistry } = require('#src/components/status/registry');
const { COMPONENT_STATUS_LEVELS } = require('#src/components/status/types');
const { waitFor } = require('../../waitFor.js');
const { setTimeout: delay } = require('node:timers/promises');
const { setStatusHandler, createLogger, updateLogger } = require('#src/utility/logging/harper_logger');
const { runInNewContext } = require('node:vm');

describe('logBridge', function () {
	beforeEach(function () {
		componentStatusRegistry.reset();
		initLogBridge();
	});

	afterEach(function () {
		initLogBridge();
		componentStatusRegistry.reset();
	});

	it('redacts complete URL credentials before bounding the status message', function () {
		const logger = createLogger({ level: 'error', writeToLog: () => {} });
		logger
			.status({ problem: 'test.long-url' })
			.debug('https://qa-user:synthetic-password-' + 'x'.repeat(600) + '@example.invalid/status');
		const message = componentStatusRegistry.getStatus('test.long-url').message;
		assert.ok(!message.includes('qa-user'));
		assert.ok(!message.includes('synthetic-password'));
		assert.ok(message.includes('[REDACTED]'));
		assert.ok(message.length <= 500);
	});

	it('recognizes a native error created in a VM context', function () {
		const logger = createLogger({ level: 'error', writeToLog: () => {} });
		const error = runInNewContext('new TypeError("VM failure")');
		logger.status({ problem: 'test.vm-error' }).debug('Failed', error);
		assert.strictEqual(componentStatusRegistry.getStatus('test.vm-error').error, error);
	});

	it('does not invoke Proxy traps or object coercions for a filtered log', function () {
		const logger = createLogger({ level: 'error', writeToLog: () => {} });
		let calls = 0;
		const proxy = new Proxy(
			{},
			{
				getPrototypeOf() {
					calls++;
					return null;
				},
				get() {
					calls++;
					return undefined;
				},
			}
		);
		const object = {
			[Symbol.toPrimitive]() {
				calls++;
				return 'coerced';
			},
		};
		logger.status({ problem: 'test.passive-summary' }).debug(proxy, Object.create(proxy), object);
		assert.strictEqual(calls, 0);
		assert.strictEqual(componentStatusRegistry.getStatus('test.passive-summary').occurrenceCount, 1);
	});

	it('keeps a long expiry active instead of overflowing the native timer', async function () {
		const key = 'test.long-expiry';
		const logger = createLogger({ level: 'error', writeToLog: () => {} });
		try {
			logger.status({ problem: key, expires: 30 * 86400 }).error('Still failing');
			await delay(25);
			assert.strictEqual(componentStatusRegistry.getStatus(key).status, COMPONENT_STATUS_LEVELS.ERROR);
		} finally {
			handleStatusLog({ resolves: key }, null, undefined, []);
		}
	});

	it('leaves invalid expiry durations persistent', async function () {
		const logger = createLogger({ level: 'error', writeToLog: () => {} });
		const values = [0, -1, NaN, Infinity, 'abc'];
		const keys = values.map((_, index) => 'test.invalid-expiry-' + index);
		try {
			for (let i = 0; i < values.length; i++) {
				logger.status({ problem: keys[i], expires: values[i] }).error('Still failing');
			}
			await delay(25);
			for (const key of keys) {
				assert.strictEqual(componentStatusRegistry.getStatus(key).status, COMPONENT_STATUS_LEVELS.ERROR);
			}
		} finally {
			for (const key of keys) handleStatusLog({ resolves: key }, null, undefined, []);
		}
	});

	it('preserves numeric-string expiry compatibility', async function () {
		const key = 'test.numeric-string-expiry';
		const logger = createLogger({ level: 'error', writeToLog: () => {} });
		logger.status({ problem: key, expires: '0.03' }).error('Transient');
		await waitFor(() => componentStatusRegistry.getStatus(key)?.status === COMPONENT_STATUS_LEVELS.HEALTHY);
	});

	it('keeps captured conditional and tagged status loggers working after a level update', function () {
		const output = [];
		const logger = createLogger({ level: 'error', writeToLog: (line) => output.push(line) });
		const conditional = logger.conditional;
		const tagged = logger.withTag('rebase-status');
		const child = logger.forComponent('rebase-child');
		const childConditional = child.conditional;
		conditional.status({ problem: 'test.rebase-before' }).debug('filtered');
		assert.equal(output.length, 0);
		assert.equal(componentStatusRegistry.getStatus('test.rebase-before').status, COMPONENT_STATUS_LEVELS.WARNING);
		updateLogger(logger, { level: 'info' }, 'rebase-status');
		updateLogger(logger, { level: 'debug' }, 'rebase-status');
		updateLogger(child, { level: 'debug' }, 'rebase-child', logger);
		assert.deepEqual(Object.keys(conditional).sort(), ['debug', 'error', 'fatal', 'info', 'notify', 'trace', 'warn']);
		assert.strictEqual(child.conditional, childConditional);
		assert.strictEqual(logger.conditional, conditional);
		conditional.status({ problem: 'test.rebase-after' }).debug('conditional after update');
		tagged.status({ problem: 'test.rebase-tagged' }).debug('tagged after update');
		childConditional.status({ problem: 'test.rebase-child' }).debug('child after update');
		assert.ok(output.some((line) => line.includes('conditional after update')));
		assert.ok(output.some((line) => line.includes('[rebase-status]') && line.includes('tagged after update')));
		assert.ok(output.some((line) => line.includes('child after update')));
		assert.equal(componentStatusRegistry.getStatus('test.rebase-child').occurrenceCount, 1);
		assert.equal(componentStatusRegistry.getStatus('test.rebase-after').occurrenceCount, 1);
		assert.equal(componentStatusRegistry.getStatus('test.rebase-tagged').occurrenceCount, 1);
	});

	it('rebinds status when a replacement logger reuses the captured conditional object', function () {
		const originalOutput = [];
		const replacementOutput = [];
		const original = createLogger({ level: 'error', writeToLog: (line) => originalOutput.push(line) });
		const conditional = original.conditional;
		const replacement = createLogger({
			level: 'debug',
			conditional,
			writeToLog: (line) => replacementOutput.push(line),
		});
		assert.strictEqual(replacement.conditional, conditional);
		conditional.status({ problem: 'test.rebase-replacement' }).debug('replacement logger');
		assert.equal(originalOutput.length, 0);
		assert.ok(replacementOutput.some((line) => line.includes('replacement logger')));
		assert.equal(componentStatusRegistry.getStatus('test.rebase-replacement').occurrenceCount, 1);
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

	it('does not let an old expiry clear an explicit registry overwrite or recreate a reset entry', async function () {
		const overwritten = 'test.expiry-overwritten';
		const removed = 'test.expiry-removed';
		handleStatusLog({ problem: overwritten, expires: 0.02 }, 'error', undefined, ['temporary']);
		handleStatusLog({ problem: removed, expires: 0.02 }, 'error', undefined, ['temporary']);
		componentStatusRegistry.reset();
		componentStatusRegistry.reportError(overwritten, 'persistent', 'new report');
		await delay(60);
		assert.equal(componentStatusRegistry.getStatus(overwritten).status, COMPONENT_STATUS_LEVELS.ERROR);
		assert.equal(componentStatusRegistry.getStatus(overwritten).message, 'new report');
		assert.equal(componentStatusRegistry.getStatus(removed), undefined);
	});

	it('isolates failing status handlers in chained and bare calls', async function () {
		const output = [];
		const logger = createLogger({ level: 'error', writeToLog: (line) => output.push(line) });
		setStatusHandler(() => {
			throw new Error('Status handler failed');
		});
		assert.doesNotThrow(() => logger.status({ problem: 'test.bad-handler' }).error('cleanup continues'));
		logger.status({ problem: 'test.bad-bare-handler' });
		await new Promise((resolve) => setImmediate(resolve));
		assert.ok(output.some((line) => line.includes('cleanup continues')));
		const failure = new Error('Original formatting error');
		const value = {
			[Symbol.for('nodejs.util.inspect.custom')]() {
				throw failure;
			},
		};
		try {
			assert.throws(
				() => logger.status({ problem: 'test.two-failures' }).error(value),
				(error) => error === failure
			);
		} finally {
			logger.info('');
		}
	});

	it('reports filtered calls with uninspectable arguments without losing the status', function () {
		const { proxy, revoke } = Proxy.revocable({}, {});
		revoke();
		const logger = createLogger({ level: 'error', writeToLog: () => {} });
		assert.doesNotThrow(() => logger.status({ problem: 'test.revoked-proxy' }).debug(proxy));
		assert.equal(componentStatusRegistry.getStatus('test.revoked-proxy').occurrenceCount, 1);
		assert.equal(componentStatusRegistry.getStatus('test.revoked-proxy').message, '[Proxy]');
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

	it('logger.status({problem}).error(msg) registers exactly one occurrence', async function () {
		const logger = createLogger({ level: 'trace', writeToLog: () => {} });
		logger.status({ problem: 'test.harper-372-chained' }).error('boom');

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
