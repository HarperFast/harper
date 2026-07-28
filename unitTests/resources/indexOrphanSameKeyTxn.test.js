// Two writes to the same key in one transaction: the second write applies on top of the first, so
// the secondary index ends up holding exactly the record's final value and an incremental update
// keeps the earlier write's changes. Before harper#1968 both writes diffed against the
// pre-transaction record: the intermediate value was orphaned in the index (permanently — nothing
// reconciles an index against the records), and on LMDB the first write's changes were dropped.
require('../testUtils');
const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { transaction } = require('#src/resources/transaction');

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
		assert.equal(record.status, 'STOPPED');
		assert.equal((await collect(Inst.search({ conditions: [{ attribute: 'status', value: 'RUNNING' }] }))).length, 0);
		assert.equal(
			(await collect(Inst.search({ conditions: [{ attribute: 'status', value: 'STOPPING' }] }))).length,
			0,
			`orphaned STOPPING index entry (record is ${record.status})`
		);
		assert.equal((await collect(Inst.search({ conditions: [{ attribute: 'status', value: 'STOPPED' }] }))).length, 1);
	});

	it('separate transactions per write stay consistent (control)', async () => {
		await Inst.put({ id: 'b', status: 'RUNNING' });
		await Inst.patch({ id: 'b', status: 'STOPPING' });
		await Inst.patch({ id: 'b', status: 'STOPPED' });
		const stopping = await collect(Inst.search({ conditions: [{ attribute: 'status', value: 'STOPPING' }] }));
		assert.equal(stopping.filter((r) => r.id === 'b').length, 0);
	});

	it('an incremental update applies on top of the earlier one, not the pre-transaction record', async () => {
		await Inst.put({ id: 'merge', status: 'RUNNING', keep: 'yes' });
		const context = {};
		await transaction(context, async () => {
			await Inst.patch({ id: 'merge', first: 1 }, context);
			await Inst.patch({ id: 'merge', second: 2 }, context);
		});
		const record = await Inst.get('merge');
		assert.equal(record.first, 1, 'the first update in the transaction was dropped');
		assert.equal(record.second, 2);
		assert.equal(record.keep, 'yes');
	});

	it('a delete after a write in the same transaction removes the staged index values', async () => {
		await Inst.put({ id: 'deleted', status: 'RUNNING' });
		const context = {};
		await transaction(context, async () => {
			await Inst.patch({ id: 'deleted', status: 'STOPPING' }, context);
			await Inst.delete('deleted', context);
		});
		assert.equal(await Inst.get('deleted'), undefined);
		assert.deepEqual(await indexedStatuses('deleted'), [], 'the deleted record is still indexed');
	});

	it('an update after a delete in the same transaction applies to a deleted record', async () => {
		await Inst.put({ id: 'recreated', status: 'RUNNING', gone: 'yes' });
		const context = {};
		await transaction(context, async () => {
			await Inst.delete('recreated', context);
			await Inst.patch({ id: 'recreated', status: 'STARTING' }, context);
		});
		const record = await Inst.get('recreated');
		assert.equal(record?.status, 'STARTING');
		assert.equal(record.gone, undefined, 'the deleted record was merged back in');
		assert.deepEqual(await indexedStatuses('recreated'), ['STARTING']);
	});
});
