'use strict';

const assert = require('node:assert');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { _symlinkHarperModuleForTests } = require('#src/components/componentLoader');
const { Status } = require('#src/server/status/index');

// The lock-wait branch of symlinkHarperModule must hold a ref'd timer while it waits for the
// lock holder's unlock wake: that wake is delivered through an unref'd threadsafe function,
// which does not keep the event loop alive, so a pre-ready worker parked here without the
// timer has zero ref-holding handles, drains its loop, and exits cleanly with code 0 before
// the ready handshake (harper#2312).
describe('componentLoader symlinkHarperModule lock wait', () => {
	let componentDirectory;
	let createdTimers;
	const realSetTimeout = global.setTimeout;

	before(() => {
		componentDirectory = mkdtempSync(join(tmpdir(), 'harper-symlink-lock-wait-'));
	});

	beforeEach(() => {
		createdTimers = [];
		const trackingSetTimeout = (callback, ms, ...args) => {
			const timer = realSetTimeout(callback, ms, ...args);
			createdTimers.push({ timer, ms });
			return timer;
		};
		Object.assign(trackingSetTimeout, realSetTimeout); // keep setTimeout.__promisify__ etc.
		global.setTimeout = trackingSetTimeout;
	});

	afterEach(() => {
		global.setTimeout = realSetTimeout;
	});

	after(() => {
		rmSync(componentDirectory, { recursive: true, force: true });
	});

	const liveRefdLockWaitTimer = () =>
		createdTimers.some(({ timer, ms }) => ms === 10_000 && timer._destroyed !== true && timer.hasRef());

	it('a waiter behind a held lock keeps a ref-holding timer until the unlock wake arrives', async () => {
		const store = Status.primaryStore;
		assert.strictEqual(store.tryLock(componentDirectory), true, 'test could not take the lock');
		try {
			let resolved = false;
			const waiting = _symlinkHarperModuleForTests(componentDirectory).then(() => {
				resolved = true;
			});
			await new Promise((resolve) => realSetTimeout(resolve, 50));
			assert.strictEqual(resolved, false, 'waiter should still be pending while the lock is held');
			assert.ok(
				liveRefdLockWaitTimer(),
				'waiter must hold a ref-holding timer while parked on the lock — without it a pre-ready ' +
					'worker has no ref-holding handle and its event loop can drain (clean exit 0 before ready)'
			);
			store.unlock(componentDirectory);
			await waiting;
		} finally {
			// unlock is idempotent; make sure a failing assertion above cannot leak the lock
			store.unlock(componentDirectory);
		}
	});

	it('the winner completes without leaving a timer armed', async () => {
		await _symlinkHarperModuleForTests(componentDirectory);
		assert.strictEqual(
			liveRefdLockWaitTimer(),
			false,
			'winner path must not leave a stale timer that could later unlock a re-acquired lock'
		);
	});
});
