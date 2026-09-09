// A later same-key write's explicit save() must not run ahead of an earlier staged write (harper#2553).
require('../testUtils');
const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { transaction } = require('#src/resources/transaction');

// LMDB applies staged writes only in the commit batch, so a read inside the transaction cannot see them
const readsOwnWrites = process.env.HARPER_STORAGE_ENGINE !== 'lmdb';

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

	async function isIndexedUnder(status, id) {
		const rows = await collect(Inst.search({ conditions: [{ attribute: 'status', value: status }] }));
		return rows.some((row) => row.id === id);
	}

	it('commits the created record with the patch applied', async () => {
		const context = {};
		await transaction(context, async () => {
			await Inst.create({ id: 'a', status: 'queued' }, context);
			await Inst.patch('a', { metadata: 'required-value' }, context);
			if (readsOwnWrites)
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
		assert.strictEqual(await isIndexedUnder('queued', 'a'), true);
	});

	it('composes repeated patches and an indexed-field change in program order', async () => {
		const context = {};
		await transaction(context, async () => {
			await Inst.create({ id: 'b', status: 'queued', count: 1 }, context);
			await Inst.patch('b', { status: 'running' }, context);
			await Inst.patch('b', { metadata: 'first' }, context);
			await Inst.patch('b', { metadata: 'second', status: 'done' }, context);
			if (readsOwnWrites)
				assert.deepStrictEqual(fields(await Inst.get('b', context)), {
					id: 'b',
					status: 'done',
					metadata: 'second',
					count: 1,
				});
		});
		assert.deepStrictEqual(fields(await Inst.get('b')), { id: 'b', status: 'done', metadata: 'second', count: 1 });
		assert.strictEqual(await isIndexedUnder('queued', 'b'), false);
		assert.strictEqual(await isIndexedUnder('running', 'b'), false);
		assert.strictEqual(await isIndexedUnder('done', 'b'), true);
	});

	it('rolls back the create and the patch together', async () => {
		const context = {};
		await assert.rejects(
			transaction(context, async () => {
				await Inst.create({ id: 'c', status: 'queued' }, context);
				await Inst.patch('c', { metadata: 'required-value' }, context);
				if (readsOwnWrites)
					assert.deepStrictEqual(fields(await Inst.get('c', context)), {
						id: 'c',
						status: 'queued',
						metadata: 'required-value',
						count: undefined,
					});
				throw new Error('abort');
			}),
			/abort/
		);
		assert.equal(await Inst.get('c'), null);
		assert.strictEqual(await isIndexedUnder('queued', 'c'), false);
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

	it('a delete between the create and the patch keeps program order', async () => {
		const context = {};
		await transaction(context, async () => {
			await Inst.create({ id: 'e', status: 'queued', count: 1 }, context);
			await Inst.delete('e', context);
			await Inst.patch('e', { metadata: 'required-value' }, context);
		});
		const record = await Inst.get('e');
		assert.strictEqual(record.metadata, 'required-value');
		assert.strictEqual(record.status, undefined, 'the delete ran after the create');
		assert.strictEqual(await isIndexedUnder('queued', 'e'), false);
	});

	it('put after create replaces the created record', async () => {
		const context = {};
		await transaction(context, async () => {
			await Inst.create({ id: 'f', status: 'queued', count: 1 }, context);
			await Inst.put({ id: 'f', status: 'done' }, context);
		});
		assert.deepStrictEqual(fields(await Inst.get('f')), {
			id: 'f',
			status: 'done',
			metadata: undefined,
			count: undefined,
		});
		assert.strictEqual(await isIndexedUnder('queued', 'f'), false);
		assert.strictEqual(await isIndexedUnder('done', 'f'), true);
	});
});
