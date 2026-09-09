// create() stages its write and leaves it for the commit loop; patch() stages and saves explicitly.
// The explicit save ran the patch's commit handler before the create's, so the patch composed onto
// the pre-transaction record (nothing), and the commit loop then ran the create's full put over it:
// the awaited patch returned success and the committed record lacked its fields (harper#2553).
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

function fields(record) {
	if (!record) return record;
	const { id, status, metadata, count } = record;
	return { id, status, metadata, count };
}

describe('create followed by patch on the same key in one transaction', () => {
	let Inst;

	before(async () => {
		setupTestDBPath();
		setMainIsWorker(true);
		Inst = table({
			table: 'CreatePatchProbe',
			database: 'test',
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'status', indexed: true },
				{ name: 'metadata' },
				{ name: 'count' },
			],
			audit: true,
		});
		if (Inst.indexingOperation) await Inst.indexingOperation;
	});

	async function idsIndexedUnder(status) {
		const rows = await collect(Inst.search({ conditions: [{ attribute: 'status', value: status }] }));
		return rows.map((row) => row.id).sort();
	}

	it('commits the created record with the patch applied', async () => {
		const context = {};
		await transaction(context, async () => {
			await Inst.create({ id: 'a', status: 'queued' }, context);
			await Inst.patch('a', { metadata: 'required-value' }, context);
			assert.deepStrictEqual(
				fields(await Inst.get('a', context)),
				{ id: 'a', status: 'queued', metadata: 'required-value', count: undefined },
				'read-your-writes inside the transaction'
			);
		});
		assert.deepStrictEqual(
			fields(await Inst.get('a')),
			{ id: 'a', status: 'queued', metadata: 'required-value', count: undefined },
			'committed record'
		);
	});

	it('composes repeated patches and an indexed-field change in program order', async () => {
		const context = {};
		await transaction(context, async () => {
			await Inst.create({ id: 'b', status: 'queued', count: 1 }, context);
			await Inst.patch('b', { status: 'running' }, context);
			await Inst.patch('b', { metadata: 'first' }, context);
			await Inst.patch('b', { metadata: 'second', status: 'done' }, context);
			assert.deepStrictEqual(fields(await Inst.get('b', context)), {
				id: 'b',
				status: 'done',
				metadata: 'second',
				count: 1,
			});
		});
		assert.deepStrictEqual(fields(await Inst.get('b')), { id: 'b', status: 'done', metadata: 'second', count: 1 });
		assert.deepStrictEqual(await idsIndexedUnder('queued'), []);
		assert.deepStrictEqual(await idsIndexedUnder('running'), []);
		assert.deepStrictEqual(await idsIndexedUnder('done'), ['b']);
	});

	it('rolls back the create and the patch together', async () => {
		const context = {};
		await assert.rejects(
			transaction(context, async () => {
				await Inst.create({ id: 'c', status: 'queued' }, context);
				await Inst.patch('c', { metadata: 'required-value' }, context);
				throw new Error('abort');
			}),
			/abort/
		);
		assert.equal(await Inst.get('c'), null);
		assert.deepStrictEqual(await idsIndexedUnder('queued'), []);
	});

	it('an instance update staged before a patch to the same key still lands its changes', async () => {
		await Inst.put({ id: 'd', status: 'queued', count: 1 });
		const context = {};
		await transaction(context, async () => {
			const instance = await Inst.update('d', context);
			instance.count = 2;
			await Inst.patch('d', { metadata: 'required-value' }, context);
			await instance.save();
		});
		assert.deepStrictEqual(fields(await Inst.get('d')), {
			id: 'd',
			status: 'queued',
			metadata: 'required-value',
			count: 2,
		});
	});
});
