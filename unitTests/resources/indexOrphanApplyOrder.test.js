// A replicated transaction must be applied per key in the order the leader wrote it. writeUpdate()
// suspends on an async record load and the apply loop does not await it, so a warm record can overtake
// a cold one; the leader's `delete K; put K` then stages as `put K; delete K`, both writes diff against
// the pre-transaction record, and K is left live with none of its index entries (harper#2211).
//
// The race is forced by delaying one getResource(); without that the ordering happens to hold and the
// test proves nothing.
require('../testUtils');
const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { IterableEventQueue } = require('#src/resources/IterableEventQueue');
const { waitFor } = require('../waitFor');

async function collect(iter) {
	const out = [];
	for await (const x of iter) out.push(x);
	return out;
}

const TABLE = 'IndexApplyOrder';

describe('replicated replace-all: per-key apply order', () => {
	let Inst, sub;

	before(async () => {
		setupTestDBPath();
		setMainIsWorker(true);
		Inst = table({
			table: TABLE,
			database: 'test',
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'line', indexed: true },
				{ name: 'user', indexed: true },
			],
			audit: true,
		});
		if (Inst.indexingOperation) await Inst.indexingOperation;
		Inst.sourcedFrom({
			subscribe() {
				return (sub = new IterableEventQueue());
			},
		});
		await waitFor(() => sub, { message: 'source subscription was never established' });
	});

	async function indexedUnder(attribute, value, id) {
		const rows = await collect(Inst.search({ conditions: [{ attribute, value }] }));
		return rows.some((row) => row.id === id);
	}

	// Make the next `delayed` resource resolutions take an extra macrotask, so the writes that follow
	// them stage first. Restores the real getResource once the budget is spent.
	function delayResourceLoad(delayed) {
		const original = Inst.getResource.bind(Inst);
		let remaining = delayed;
		Inst.getResource = function (...args) {
			if (remaining-- <= 0) {
				Inst.getResource = original;
				return original(...args);
			}
			return new Promise((resolve) => setTimeout(resolve, 5)).then(() => original(...args));
		};
		return () => {
			Inst.getResource = original;
		};
	}

	// Which internal write each event actually staged, in order — without it the delay test passes
	// green whenever dispatch order shifts the delay onto the put, proving nothing.
	function recordStagingOrder() {
		const target = Inst.prototype;
		const originalUpdate = target._writeUpdate;
		const originalDelete = target._writeDelete;
		const order = [];
		target._writeUpdate = function (...args) {
			order.push('put');
			return originalUpdate.apply(this, args);
		};
		target._writeDelete = function (...args) {
			order.push('delete');
			return originalDelete.apply(this, args);
		};
		return {
			order,
			restore() {
				target._writeUpdate = originalUpdate;
				target._writeDelete = originalDelete;
			},
		};
	}

	it('a delete+put pair for one key applies in arrival order even when the delete loads slowly', async () => {
		const id = 'replace-all';
		await Inst.put({ id, line: 'L', user: 'U', n: 1 });
		assert.ok(await indexedUnder('line', 'L', id), 'precondition: the record starts indexed');

		const ts = Date.now() + 1000;
		const restore = delayResourceLoad(1); // only the delete's resource load is slow
		const staging = recordStagingOrder();
		try {
			await new Promise((resolve) => {
				sub.send({ type: 'delete', id, table: TABLE, timestamp: ts, beginTxn: true });
				sub.send({ type: 'put', id, table: TABLE, timestamp: ts, value: { id, line: 'L', user: 'U', n: 2 } });
				sub.send({ type: 'end_txn', localTime: ts, onCommit: resolve });
			});
		} finally {
			restore();
			staging.restore();
		}
		// the delay has to have landed on the delete, or the race was never set up and the rest proves nothing
		assert.deepStrictEqual(staging.order, ['delete', 'put'], 'the leader order was not preserved at staging');

		// The leader ran `delete; put`, so the record exists — and a record that exists must be findable
		// through every one of its indexed attributes.
		const record = await Inst.get(id);
		assert.ok(record, 'the put must win: it is the last write of the leader transaction');
		assert.strictEqual(record.n, 2);
		assert.ok(await indexedUnder('line', 'L', id), 'record is present but missing from the line index');
		assert.ok(await indexedUnder('user', 'U', id), 'record is present but missing from the user index');
	});

	// A chained successor must not stage after its predecessor failed: the failure aborts the whole
	// transaction, and addWrite() on the by-then-closed transaction would commit the successor on its own.
	it('a failed write does not let the rest of its key chain escape the aborted transaction', async () => {
		const id = 'chain-abort';
		await Inst.put({ id, line: 'L', user: 'U', n: 1 });
		const other = 'chain-abort-after';
		const original = Inst.getResource.bind(Inst);
		// the predecessor fails at once and the successor's own load is slow, so the transaction has time
		// to abort before the successor would reach addWrite(). Loads are counted per id, so the probe
		// transaction below can't inflate the count and no timing guess is needed.
		const loads = new Map();
		let call = 0;
		Inst.getResource = function (loadId, ...rest) {
			loads.set(loadId, (loads.get(loadId) ?? 0) + 1);
			if (++call === 1) return Promise.reject(new Error('induced resource load failure'));
			if (call === 2) return new Promise((resolve) => setTimeout(resolve, 50)).then(() => original(loadId, ...rest));
			return original(loadId, ...rest);
		};
		try {
			const ts = Date.now() + 3000;
			// the failing transaction never commits, so its onCommit never fires — don't await it
			sub.send({ type: 'delete', id, table: TABLE, timestamp: ts, beginTxn: true });
			sub.send({ type: 'put', id, table: TABLE, timestamp: ts, value: { id, line: 'L', user: 'U', n: 99 } });
			sub.send({ type: 'end_txn', localTime: ts });

			// a later transaction proves the apply loop survived, and its real commit gives any late successor
			// continuation more than enough time to have run before the per-id count is read
			const later = Date.now() + 4000;
			await new Promise((resolve) => {
				sub.send({
					type: 'put',
					id: other,
					table: TABLE,
					timestamp: later,
					value: { id: other, line: 'L', user: 'U', n: 5 },
					beginTxn: true,
				});
				sub.send({ type: 'end_txn', localTime: later, onCommit: resolve });
			});
		} finally {
			Inst.getResource = original;
		}
		assert.strictEqual(
			loads.get(id),
			1,
			'the successor staged anyway after its predecessor failed (it must be short-circuited)'
		);

		assert.strictEqual((await Inst.get(other))?.n, 5, 'the subscription loop stopped applying after the failure');
		const record = await Inst.get(id);
		assert.strictEqual(record?.n, 1, 'a write from the aborted transaction became durable');
		assert.ok(await indexedUnder('line', 'L', id), 'the untouched record lost its index entry');
	});

	it('control: the same pair with no induced delay', async () => {
		const id = 'replace-all-control';
		await Inst.put({ id, line: 'L', user: 'U', n: 1 });
		const ts = Date.now() + 2000;
		await new Promise((resolve) => {
			sub.send({ type: 'delete', id, table: TABLE, timestamp: ts, beginTxn: true });
			sub.send({ type: 'put', id, table: TABLE, timestamp: ts, value: { id, line: 'L', user: 'U', n: 2 } });
			sub.send({ type: 'end_txn', localTime: ts, onCommit: resolve });
		});
		const record = await Inst.get(id);
		assert.ok(record, 'the put must win');
		assert.ok(await indexedUnder('line', 'L', id), 'record is present but missing from the line index');
		assert.ok(await indexedUnder('user', 'U', id), 'record is present but missing from the user index');
	});
});
