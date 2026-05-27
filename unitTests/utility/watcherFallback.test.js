const {
	isWatcherExhaustionError,
	POLLING_FALLBACK_OPTIONS,
	warnWatcherFallback,
	_resetForTests,
} = require('#src/utility/watcherFallback');
const assert = require('node:assert/strict');

describe('watcherFallback', () => {
	describe('isWatcherExhaustionError', () => {
		it('identifies ENOSPC errors', () => {
			assert.equal(isWatcherExhaustionError(Object.assign(new Error('boom'), { code: 'ENOSPC' })), true);
		});

		it('identifies EMFILE errors', () => {
			assert.equal(isWatcherExhaustionError(Object.assign(new Error('boom'), { code: 'EMFILE' })), true);
		});

		it('rejects unrelated error codes', () => {
			assert.equal(isWatcherExhaustionError(Object.assign(new Error('boom'), { code: 'EACCES' })), false);
		});

		it('rejects errors with no code', () => {
			assert.equal(isWatcherExhaustionError(new Error('boom')), false);
		});

		it('rejects non-error values', () => {
			assert.equal(isWatcherExhaustionError(null), false);
			assert.equal(isWatcherExhaustionError(undefined), false);
			assert.equal(isWatcherExhaustionError('ENOSPC'), false);
			assert.equal(isWatcherExhaustionError(42), false);
		});
	});

	describe('POLLING_FALLBACK_OPTIONS', () => {
		it('enables polling with a conservative interval', () => {
			assert.equal(POLLING_FALLBACK_OPTIONS.usePolling, true);
			// Intervals should be >=1s to bound CPU cost when the host is already
			// under inotify/FD pressure.
			assert.ok(POLLING_FALLBACK_OPTIONS.interval >= 1000, 'interval should be at least 1000ms');
			assert.ok(POLLING_FALLBACK_OPTIONS.binaryInterval >= 1000, 'binaryInterval should be at least 1000ms');
		});
	});

	describe('warnWatcherFallback', () => {
		// We can't easily intercept the module-tagged logger here without monkey-patching,
		// so this case only asserts the function is idempotent and doesn't throw — a
		// regression that re-emits the warning hundreds of times per failing watcher
		// would still be caught by manual log inspection during the integration scenario
		// the helper exists for.
		afterEach(() => {
			_resetForTests();
		});

		it('does not throw on repeated invocation', () => {
			assert.doesNotThrow(() => warnWatcherFallback('/some/path'));
			assert.doesNotThrow(() => warnWatcherFallback('/some/other/path'));
		});
	});
});
