// Two writes to the same key in one transaction: the second write applies on top of the first, so
// the secondary index ends up holding exactly the record's final value and an incremental update
// keeps the earlier write's changes. Before harper#1968 both writes diffed against the
// pre-transaction record: the intermediate value was orphaned in the index (permanently — nothing
// reconciles an index against the records), and on LMDB the first write's changes were dropped.
require('../testUtils');
const assert = require('node:assert');
const { existsSync } = require('node:fs');
const { randomBytes } = require('node:crypto');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { transaction } = require('#src/resources/transaction');
const { getFilePathForBlob, setDeletionDelay } = require('#src/resources/blob');
const { waitFor } = require('../waitFor');

async function collect(iter) {
	const out = [];
	for await (const x of iter) out.push(x);
	return out;
}

describe('secondary index vs. two writes to the same key in one transaction', () => {
	let Inst;

	before(async () => {
		setupTestDBPath();
		setMainIsWorker(true);
		Inst = table({
			table: 'IndexOrphanProbe',
			database: 'test',
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'status', indexed: true },
			],
			audit: true,
		});
		if (Inst.indexingOperation) await Inst.indexingOperation;
	});

	// the statuses whose index currently holds `id`
	async function indexedStatuses(id) {
		const found = [];
		for (const status of ['RUNNING', 'STARTING', 'STOPPING', 'STOPPED']) {
			const rows = await collect(Inst.search({ conditions: [{ attribute: 'status', value: status }] }));
			if (rows.some((row) => row.id === id)) found.push(status);
		}
		return found;
	}

	it('does not leave the intermediate status in the index', async () => {
		await Inst.put({ id: 'a', status: 'RUNNING' });
		const context = {};
		await transaction(context, async () => {
			await Inst.patch({ id: 'a', status: 'STOPPING' }, context);
			await Inst.patch({ id: 'a', status: 'STOPPED' }, context);
		});
		const record = await Inst.get('a');
		assert.strictEqual(record.status, 'STOPPED');
		assert.strictEqual(
			(await collect(Inst.search({ conditions: [{ attribute: 'status', value: 'RUNNING' }] }))).length,
			0
		);
		assert.strictEqual(
			(await collect(Inst.search({ conditions: [{ attribute: 'status', value: 'STOPPING' }] }))).length,
			0,
			`orphaned STOPPING index entry (record is ${record.status})`
		);
		assert.strictEqual(
			(await collect(Inst.search({ conditions: [{ attribute: 'status', value: 'STOPPED' }] }))).length,
			1
		);
	});

	it('separate transactions per write stay consistent (control)', async () => {
		await Inst.put({ id: 'b', status: 'RUNNING' });
		await Inst.patch({ id: 'b', status: 'STOPPING' });
		await Inst.patch({ id: 'b', status: 'STOPPED' });
		const stopping = await collect(Inst.search({ conditions: [{ attribute: 'status', value: 'STOPPING' }] }));
		assert.strictEqual(stopping.filter((r) => r.id === 'b').length, 0);
	});

	it('an incremental update applies on top of the earlier one, not the pre-transaction record', async () => {
		await Inst.put({ id: 'merge', status: 'RUNNING', keep: 'yes' });
		const context = {};
		await transaction(context, async () => {
			await Inst.patch({ id: 'merge', first: 1 }, context);
			await Inst.patch({ id: 'merge', second: 2 }, context);
		});
		const record = await Inst.get('merge');
		assert.strictEqual(record.first, 1, 'the first update in the transaction was dropped');
		assert.strictEqual(record.second, 2);
		assert.strictEqual(record.keep, 'yes');
	});

	it('a delete after a write in the same transaction removes the staged index values', async () => {
		await Inst.put({ id: 'deleted', status: 'RUNNING' });
		const context = {};
		await transaction(context, async () => {
			await Inst.patch({ id: 'deleted', status: 'STOPPING' }, context);
			await Inst.delete('deleted', context);
		});
		assert.ok((await Inst.get('deleted')) == null, 'the deleted record must be gone');
		assert.deepStrictEqual(await indexedStatuses('deleted'), [], 'the deleted record is still indexed');
	});

	it('an update after a delete in the same transaction applies to a deleted record', async () => {
		await Inst.put({ id: 'recreated', status: 'RUNNING', gone: 'yes' });
		const context = {};
		await transaction(context, async () => {
			await Inst.delete('recreated', context);
			await Inst.patch({ id: 'recreated', status: 'STARTING' }, context);
		});
		const record = await Inst.get('recreated');
		assert.strictEqual(record?.status, 'STARTING');
		assert.strictEqual(record.gone, undefined, 'the deleted record was merged back in');
		assert.deepStrictEqual(await indexedStatuses('recreated'), ['STARTING']);
	});

	// The per-key write chain must not conflate distinct ids whose encodings collide: the scalar
	// string '["x"]' vs the composite ['x'], and [1n] vs ['1'], are different records.
	it('writes to colliding scalar/composite ids in one transaction stay independent', async () => {
		const scalarId = '["x"]';
		const compositeId = ['x'];
		await Inst.put({ id: scalarId, status: 'RUNNING', owner: 'scalar' });
		await Inst.put({ id: compositeId, status: 'STOPPED', owner: 'composite' });
		const context = {};
		await transaction(context, async () => {
			await Inst.patch({ id: scalarId, status: 'STOPPING' }, context);
			await Inst.patch({ id: compositeId, status: 'STARTING' }, context);
		});
		const scalarRecord = await Inst.get(scalarId);
		const compositeRecord = await Inst.get(compositeId);
		assert.strictEqual(scalarRecord.status, 'STOPPING');
		assert.strictEqual(scalarRecord.owner, 'scalar', 'the composite id write bled into the scalar id record');
		assert.strictEqual(compositeRecord.status, 'STARTING');
		assert.strictEqual(compositeRecord.owner, 'composite', 'the scalar id write bled into the composite id record');
		// neither record's old status may remain indexed (a chained-basis mixup orphans it);
		// match by stringified id so both the scalar and the composite forms are caught
		const isOurs = (row) => String(row.id) === scalarId || String(row.id) === String(compositeId);
		const running = await collect(Inst.search({ conditions: [{ attribute: 'status', value: 'RUNNING' }] }));
		const stopped = await collect(Inst.search({ conditions: [{ attribute: 'status', value: 'STOPPED' }] }));
		assert.strictEqual(running.filter(isOurs).length, 0, 'stale RUNNING index entry');
		assert.strictEqual(stopped.filter(isOurs).length, 0, 'stale STOPPED index entry');
	});

	// A blob stored by an earlier write in the transaction and replaced by a later one is reachable
	// from nothing once the transaction commits (no audit entry references it on an audit-off table),
	// so it must be cleaned up like a skipped write's blobs.
	it('a blob replaced by a later write in the same transaction is cleaned up (audit off)', async () => {
		setDeletionDelay(0);
		const BlobTbl = table({
			table: 'IndexOrphanBlob',
			database: 'test',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'blob' }],
			audit: false,
		});
		if (BlobTbl.indexingOperation) await BlobTbl.indexingOperation;
		const blobB = await createBlob(randomBytes(25000));
		const blobC = await createBlob(randomBytes(25000));
		await BlobTbl.put({ id: 'b1' });
		const context = {};
		await transaction(context, async () => {
			await BlobTbl.patch({ id: 'b1', blob: blobB }, context);
			await BlobTbl.patch({ id: 'b1', blob: blobC }, context);
		});
		const record = await BlobTbl.get('b1');
		assert.strictEqual(record.blob.size, blobC.size, 'the final record must hold the last written blob');
		const pathB = getFilePathForBlob(blobB);
		const pathC = getFilePathForBlob(blobC);
		await waitFor(() => !existsSync(pathB), {
			timeout: 5000,
			message: 'superseded blob file was never cleaned up',
		});
		assert.ok(existsSync(pathC), 'the retained blob must survive the superseded-write cleanup');
	});
});
