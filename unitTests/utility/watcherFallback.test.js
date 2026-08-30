const {
	claimLostNativeWatchError,
	isLostNativeWatchError,
	isWatcherExhaustionError,
	POLLING_FALLBACK_OPTIONS,
	warnWatcherFallback,
	_resetForTests,
} = require('#src/utility/watcherFallback');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

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

	describe('isLostNativeWatchError', () => {
		// The async shape Node delivers to the watch handle's 'error' event: no `path`, and a
		// `filename` that is null.
		const watchError = (code) =>
			Object.assign(new Error(`${code}: watch`), { code, syscall: 'watch', errno: -4048, filename: null });

		it('identifies the Windows EPERM raised when a watched path is deleted', () => {
			assert.equal(isLostNativeWatchError(watchError('EPERM')), true);
		});

		// Whatever this claims is swallowed process-wide, so the shapes it must NOT claim matter
		// as much as the one it must. A synchronous fs.watch() throw carries a `path`; an async
		// ENOENT from a watch handle has never been observed, while a synchronous one is the
		// ordinary "watch a path that isn't there" misconfiguration and has to stay fatal.
		it('rejects a synchronous fs.watch throw, which carries a path', () => {
			assert.equal(
				isLostNativeWatchError(
					Object.assign(new Error('EPERM: watch'), { code: 'EPERM', syscall: 'watch', path: '/some/dir' })
				),
				false
			);
		});

		it('rejects an ENOENT watch failure', () => {
			assert.equal(isLostNativeWatchError(watchError('ENOENT')), false);
		});

		// The guard swallows whatever this claims, process-wide, so the two neighbouring
		// error shapes it must never claim are worth pinning: an EPERM from a config
		// rename is a real failure the caller has to see, and exhaustion belongs to the
		// polling-fallback route above, not here.
		it('rejects an EPERM from a syscall other than watch', () => {
			assert.equal(
				isLostNativeWatchError(Object.assign(new Error('EPERM: rename'), { code: 'EPERM', syscall: 'rename' })),
				false
			);
		});

		it('rejects watcher exhaustion errors', () => {
			assert.equal(isLostNativeWatchError(watchError('ENOSPC')), false);
			assert.equal(isLostNativeWatchError(watchError('EMFILE')), false);
		});

		it('rejects an EPERM with no syscall', () => {
			assert.equal(isLostNativeWatchError(Object.assign(new Error('boom'), { code: 'EPERM' })), false);
		});

		it('rejects non-error values', () => {
			assert.equal(isLostNativeWatchError(null), false);
			assert.equal(isLostNativeWatchError(undefined), false);
			assert.equal(isLostNativeWatchError('EPERM'), false);
		});
	});

	describe('claimLostNativeWatchError', () => {
		afterEach(() => {
			_resetForTests();
		});

		it('claims a lost watch and marks it handled so the thread-level handler stays quiet', () => {
			const error = Object.assign(new Error('EPERM: watch'), { code: 'EPERM', syscall: 'watch' });
			assert.equal(claimLostNativeWatchError(error), true);
			assert.equal(error.isHandled, true);
		});

		it('leaves an unrelated error alone', () => {
			const error = Object.assign(new Error('boom'), { code: 'EACCES' });
			assert.equal(claimLostNativeWatchError(error), false);
			assert.equal(error.isHandled, undefined);
		});
	});

	// chokidar never attaches an 'error' listener to the underlying Node
	// FSWatcher when `persistent: false` (which every Harper watcher uses), so an async
	// watch failure is an uncaughtException rather than something the watcher can route.
	// These run in a child process because the harness must be the only thing standing
	// between the error and process death — mocha's own uncaughtException listener would
	// otherwise absorb it and the test would pass regardless.
	describe('lost native watch guard', () => {
		const runHarness = async (mode) => {
			const harness = spawn(process.execPath, [require.resolve('./fixtures/lostWatchHarness.cjs'), mode], {
				stdio: ['ignore', 'pipe', 'pipe'],
			});
			let stdout = '';
			let stderr = '';
			harness.stdout.on('data', (chunk) => (stdout += chunk));
			harness.stderr.on('data', (chunk) => (stderr += chunk));
			const [code] = await once(harness, 'close');
			return { code, stdout, stderr };
		};

		it('survives deletion of a watched directory', async function () {
			this.timeout(30000);
			const { code, stdout, stderr } = await runHarness('delete-watched-dir');
			assert.equal(code, 0, `harness exited ${code}: ${stderr}`);
			assert.match(stdout, /survived lostWatchCount=(\d+)/);
			if (process.platform === 'win32') {
				// Only Windows actually raises the error; elsewhere this case is a smoke
				// test that the guard doesn't disturb ordinary watching.
				const claimed = Number(stdout.match(/lostWatchCount=(\d+)/)[1]);
				assert.ok(claimed > 0, 'expected the guard to have claimed at least one lost watch on Windows');
			}
		});

		it('leaves an unrelated uncaught exception fatal', async function () {
			this.timeout(30000);
			const { code, stderr } = await runHarness('unrelated-throw');
			assert.equal(code, 1);
			assert.match(stderr, /unrelated harness failure/);
		});

		// The guard sees every uncaught exception in the process, so the bound that keeps it from
		// masking real failures is the error shape. A misconfigured raw fs.watch() shares its
		// syscall and would be swallowed if the shape check were any looser.
		it('leaves a synchronous fs.watch failure on a missing path fatal', async function () {
			this.timeout(30000);
			const { code, stderr } = await runHarness('sync-watch-failure');
			assert.equal(code, 1);
			assert.match(stderr, /ENOENT/);
		});
	});
});
