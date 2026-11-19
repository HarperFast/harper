require('../testUtils');
const assert = require('node:assert');
const { DatabaseTransaction } = require('#src/resources/DatabaseTransaction');

// harper#3913: a chain link's record locks pass to the chain root when it leaves the chain, and to the link
// that replaces it; in-flight lock() acquisitions coalesce on the root
describe('Record-lock registry handover between chain links', function () {
	const store = { name: 'store' };
	const handle = (label) => ({ label });

	function chain() {
		const root = new DatabaseTransaction();
		const link = new DatabaseTransaction();
		root.next = link;
		link.root = root;
		link.db = { path: 'db-b' };
		return { root, link };
	}

	it('merges a removed link into what the root already parked for its database, the removed link winning', function () {
		const { root, link } = chain();
		const older = handle('older');
		const parkedOnly = handle('parked only');
		const newer = handle('newer');
		const linkOnly = handle('link only');
		root.detachedRecordLocks = new Map([
			[
				'db-b',
				new Map([
					[
						store,
						new Map([
							['k', older],
							['p', parkedOnly],
						]),
					],
				]),
			],
		]);
		link.recordLocks = new Map([
			[
				store,
				new Map([
					['k', newer],
					['l', linkOnly],
				]),
			],
		]);
		root.detachNext();
		assert.equal(root.next, undefined);
		assert.equal(link.leftChain, true);
		assert.equal(link.recordLocks, undefined);
		const parked = root.detachedRecordLocks.get('db-b').get(store);
		assert.deepEqual([...parked.keys()].sort(), ['k', 'l', 'p']);
		assert.strictEqual(parked.get('k'), newer);
	});

	it('marks a lock-free removed link as having left the chain', function () {
		const { root, link } = chain();
		root.detachNext();
		assert.equal(link.leftChain, true);
		assert.equal(root.detachedRecordLocks, undefined);
	});

	it("merges what the root parked into the replacing link's own locks, the replacing link winning", function () {
		const { root } = chain();
		const parkedHandle = handle('parked');
		const ownHandle = handle('own');
		const parkedOnly = handle('parked only');
		root.detachedRecordLocks = new Map([
			[
				'db-b',
				new Map([
					[
						store,
						new Map([
							['k', parkedHandle],
							['p', parkedOnly],
						]),
					],
				]),
			],
		]);
		const replacement = new DatabaseTransaction();
		replacement.db = { path: 'db-b' };
		replacement.recordLocks = new Map([[store, new Map([['k', ownHandle]])]]);
		root.adoptDetachedRecordLocks(replacement);
		const adopted = replacement.recordLocks.get(store);
		assert.strictEqual(adopted.get('k'), ownHandle);
		assert.strictEqual(adopted.get('p'), parkedOnly);
		assert.equal(root.detachedRecordLocks, undefined);
	});

	it('keeps pending acquisitions on the chain root and removes only the one being settled', function () {
		const { root, link } = chain();
		const first = Promise.resolve(handle('first'));
		const second = Promise.resolve(handle('second'));
		link.registerPendingLock(store, 'k', first);
		assert.equal(link.pendingLocks, undefined, 'not on the link');
		assert.strictEqual(root.pendingLockFor(store, 'k'), first);
		root.detachNext();
		assert.strictEqual(link.pendingLockFor(store, 'k'), first, 'a link that left the chain still finds it');
		link.registerPendingLock(store, 'k', second);
		link.unregisterPendingLock(store, 'k', first);
		assert.strictEqual(root.pendingLockFor(store, 'k'), second, 'a settling acquisition leaves a later one in place');
		link.unregisterPendingLock(store, 'k', second);
		assert.equal(root.pendingLocks, undefined);
	});

	it('answers a commit-settle wait at once when nothing is in flight, and unsubscribes one that times out', async function () {
		const root = new DatabaseTransaction();
		assert.strictEqual(root.whenCommitSettles(1000), true);
		root.scopeCommitsInFlight = 1;
		assert.strictEqual(root.whenCommitSettles(0), false);
		assert.strictEqual(await root.whenCommitSettles(5), false);
		assert.equal(root.commitSettleWaiters, undefined);
		root.scopeCommitsInFlight = 0;
	});
});
