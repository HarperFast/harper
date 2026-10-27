// An out-of-order patch whose every field a newer write already overwrote changes nothing on the record,
// but it did set those fields at its own version: history at or after that version must not claim them
// absent.
require('../testUtils');
const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { getRecordAtTime } = require('#src/resources/crdt');
const { getIdOfRemoteNode } = require('#src/resources/nodeIdMapping');
const { transaction } = require('#src/resources/transaction');

const isLMDB = process.env.HARPER_STORAGE_ENGINE === 'lmdb';

describe('History across a fully superseded out-of-order patch', function () {
	let T, newer, older;

	before(async () => {
		setupTestDBPath();
		setMainIsWorker(true);
		T = table({
			table: 'HistorySupersededOutOfOrder',
			database: 'test',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'name' }, { name: 'n1' }, { name: 'n2' }],
			audit: true,
		});
		if (T.indexingOperation) await T.indexingOperation;
		newer = getIdOfRemoteNode('history-superseded-newer', T.auditStore);
		older = getIdOfRemoteNode('history-superseded-older', T.auditStore);
	});

	function applyFromOrigin(id, value, { version, nodeId, fullUpdate = false }) {
		const context = { source: {}, sourceApply: true, timestamp: version };
		return transaction(context, async () => {
			const resource = await T.getResource(id, context);
			await resource._writeUpdate(id, value, fullUpdate, { isNotification: true, nodeId, version });
		});
	}

	/** `n1` first appears at t3; a remote patch at t2 also set it and arrives after t3, fully superseded. Future
	 * clocks: RocksDB stamps an audit floor at open, and a write below it skips the walk. */
	async function seed(id, { late = true } = {}) {
		const base = Date.now() + 86400000;
		const clocks = { t0: base, t1: base + 1000, t2: base + 2000, t3: base + 3000, t4: base + 4000 };
		await applyFromOrigin(id, { id, name: 'v0' }, { version: clocks.t0, nodeId: newer, fullUpdate: true });
		await applyFromOrigin(id, { n1: 'newest', n2: 'only-newest' }, { version: clocks.t3, nodeId: newer });
		if (late) await applyFromOrigin(id, { n1: 'late' }, { version: clocks.t2, nodeId: older });
		assert.deepStrictEqual({ ...(await T.get(id)) }, { id, name: 'v0', n1: 'newest', n2: 'only-newest' });
		return clocks;
	}

	const at = (id, timestamp) =>
		getRecordAtTime(T.primaryStore.getEntry(id), timestamp, T.primaryStore, T.tableId, id) ?? {};

	it('keeps a field the superseded patch set in a snapshot at its version', async function () {
		if (isLMDB) return this.skip(); // LMDB history reads by local arrival time, when the newer value already held
		const id = 'superseded-at';
		const { t2 } = await seed(id);
		assert.ok(Object.hasOwn(at(id, t2), 'n1'), 'the superseded patch wrote n1 at t2');
	});

	it('keeps the field after a later in-order write moves the record head past the superseded patch', async function () {
		if (isLMDB) return this.skip();
		const id = 'superseded-then-write';
		const { t2, t4 } = await seed(id);
		await applyFromOrigin(id, { name: 'v4' }, { version: t4, nodeId: newer });
		assert.ok(Object.hasOwn(at(id, t2), 'n1'), 'the superseded patch wrote n1 at t2');
	});

	it('still drops a field no write had set by the requested time', async function () {
		if (isLMDB) return this.skip();
		const id = 'superseded-control';
		const { t1 } = await seed(id);
		const snapshot = at(id, t1);
		assert.strictEqual(snapshot.name, 'v0');
		assert.strictEqual(Object.hasOwn(snapshot, 'n1'), false, 'n1 did not exist before t2');
		assert.strictEqual(Object.hasOwn(snapshot, 'n2'), false);
	});

	it('still drops a field first written later on a record with no out-of-order write', async function () {
		if (isLMDB) return this.skip();
		const id = 'no-superseded-control';
		const { t2 } = await seed(id, { late: false });
		const snapshot = at(id, t2);
		assert.strictEqual(Object.hasOwn(snapshot, 'n1'), false);
		assert.strictEqual(Object.hasOwn(snapshot, 'n2'), false);
	});

	it("keeps the field in the superseded patch's own snapshot", async () => {
		const id = 'superseded-own-snapshot';
		const { t2 } = await seed(id);
		let superseded;
		for (const entry of T.auditStore.getRange({ start: 1, log: older }))
			if (entry.recordId === id && entry.version === t2) superseded = entry;
		assert.ok(superseded, 'the superseded patch keeps its audit entry');
		assert.ok(Object.hasOwn(at(id, superseded.txnLogKey), 'n1'), 'the snapshot of the patch that wrote n1 lacks it');
	});
});
