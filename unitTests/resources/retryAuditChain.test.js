// A RocksDB transaction writes its transaction-log entry once, at its first commit attempt, and a retry
// after a conflict appends nothing. The out-of-order walk has to keep finding every committed write while
// such an entry is still uncommitted, and after the retry commits over a newer head than the entry names.
require('../testUtils');
const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { transaction } = require('#src/resources/transaction');
const { getIdOfRemoteNode } = require('#src/resources/nodeIdMapping');
const { Transaction } = require('@harperfast/rocksdb-js');

const isLMDB = process.env.HARPER_STORAGE_ENGINE === 'lmdb';

describe('Audit chain across a conflict retry', function () {
	this.timeout(10000);
	let T, origin;

	before(async function () {
		if (isLMDB) return;
		setupTestDBPath();
		setMainIsWorker(true);
		T = table({
			table: 'RetryAuditChain',
			database: 'retryAuditChain',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'title' }, { name: 'meta' }, { name: 'other' }],
			audit: true,
		});
		origin = getIdOfRemoteNode('retry-audit-chain-origin', T.auditStore);
	});

	beforeEach(function () {
		if (isLMDB) this.skip();
	});

	// Each write is its own transaction from one named origin, so its version is its log key and every
	// entry lands in that origin's log. Future clocks: a write below the audit floor skips the walk.
	function applyFromOrigin(id, record, version, fullUpdate = false) {
		const context = { source: {}, sourceApply: true, timestamp: version };
		return transaction(context, async () => {
			const resource = await T.getResource(id, context);
			await resource._writeUpdate(id, record, fullUpdate, { isNotification: true, nodeId: origin, version });
		});
	}

	// Runs `around` in place of the next native commit on the table's database; it gets the real commit.
	function interceptNextCommit(around) {
		const db = T.primaryStore.store.db;
		const originalCommit = Transaction.prototype.commit;
		let armed = true;
		Transaction.prototype.commit = function (...args) {
			if (!armed || this.store?.db !== db) return originalCommit.apply(this, args);
			armed = false;
			return around(() => originalCommit.apply(this, args));
		};
		return () => {
			Transaction.prototype.commit = originalCommit;
		};
	}

	it('walks a newer committed entry while its own uncommitted entry holds the log watermark', async () => {
		const id = 'watermark';
		const base = Date.now() + 86_400_000;
		await applyFromOrigin(id, { id, title: 'seed', meta: 'seed' }, base, true);
		const restore = interceptNextCommit(async (commit) => {
			// lands after this transaction's snapshot, so its first commit conflicts after appending its entry
			await applyFromOrigin(id, { other: 'conflict' }, base + 100);
			try {
				return await commit();
			} finally {
				// commits while the entry above is appended but not committed
				await applyFromOrigin(id, { title: 'newer' }, base + 300);
			}
		});
		try {
			await applyFromOrigin(id, { title: 'older', meta: 'older' }, base + 200);
		} finally {
			restore();
		}
		const { title, meta, other } = await T.get(id);
		assert.deepStrictEqual({ title, meta, other }, { title: 'newer', meta: 'older', other: 'conflict' });
	});

	it('keeps the head an in-order retry committed over reachable from the record', async () => {
		const id = 'intermediate';
		const base = Date.now() + 2 * 86_400_000;
		await applyFromOrigin(id, { id, title: 'seed', meta: 'seed' }, base, true);
		const restore = interceptNextCommit(async (commit) => {
			// older than the retrying write, so the retry stays in order, over a head its entry does not name
			await applyFromOrigin(id, { title: 'intermediate' }, base + 200);
			return commit();
		});
		try {
			await applyFromOrigin(id, { meta: 'retried' }, base + 300);
		} finally {
			restore();
		}
		// older than the intermediate head, so its title has to lose to it
		await applyFromOrigin(id, { title: 'older' }, base + 100);
		const { title, meta } = await T.get(id);
		assert.deepStrictEqual({ title, meta }, { title: 'intermediate', meta: 'retried' });
	});
});
