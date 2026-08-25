'use strict';

const assert = require('node:assert');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { _symlinkHarperModuleForTests } = require('#src/components/componentLoader');
const { Status } = require('#src/server/status/index');

// The lock-wait branch must hold a ref'd timer while parked: the unlock wake arrives via an
// unref'd threadsafe function (see the invariant comment in threadServer.startServers,
// harper#2312).
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

	const liveRefdLockWaitTimer = () => createdTimers.some(({ timer, ms }) => ms === 10_000 && timer.hasRef());

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
			assert.ok(liveRefdLockWaitTimer(), 'waiter must hold a ref-holding timer while parked on the lock');
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
