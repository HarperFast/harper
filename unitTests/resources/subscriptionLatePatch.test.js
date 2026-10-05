// A patch from a transaction that commits after a newer write to the same record is merged into that
// record under the newer version (out-of-order resequencing, marked VERSION_REUSED). The newer write's
// event can already have been delivered by then, so the late patch's event is the only delivery of the
// merged field (harper#3024).
require('../testUtils');
const assert = require('assert');
const { setupTestDBPath } = require('../testUtils');
const { waitFor } = require('../waitFor.js');
const { table } = require('#src/resources/databases');
const { transaction } = require('#src/resources/transaction');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');

function stageHeldTransaction(write) {
	let release;
	const mayCommit = new Promise((resolve) => (release = resolve));
	let staged;
	const isStaged = new Promise((resolve) => (staged = resolve));
	const context = {};
	const committed = transaction(context, async () => {
		await write(context);
		staged();
		await mayCommit;
	});
	return { isStaged, release, committed };
}

describe('Subscription delivery of a patch that commits after a newer write', () => {
	const attributes = [{ name: 'id', isPrimaryKey: true }, { name: 'name' }, { name: 'other' }];
	let PatchTable;
	before(() => {
		setupTestDBPath();
		setMainIsWorker(true);
		PatchTable = table({ table: 'SubLatePatch', database: 'test', attributes, audit: true });
	});

	async function assertLastEventMerged(Table, id, events) {
		assert.deepEqual({ ...(await Table.get(id)) }, { id, name: 'newer', other: 'older' }, 'the patch is merged');
		await waitFor(() => events.at(-1)?.value?.other === 'older', { timeout: 2000 }).catch(() => {});
		assert.deepEqual(
			{ ...events.at(-1)?.value },
			{ id, name: 'newer', other: 'older' },
			`the subscriber never received the merged record: ${JSON.stringify(events.map((e) => e.value))}`
		);
	}

	for (const crossThreads of [false, undefined]) {
		it(`delivers the merged record to a live subscriber (crossThreads: ${crossThreads})`, async () => {
			const id = `late-patch-${crossThreads}`;
			await PatchTable.put(id, { name: 'v0' });
			const subscription = await PatchTable.subscribe({ id, omitCurrent: true, crossThreads });
			const older = stageHeldTransaction((context) => PatchTable.patch(id, { other: 'older' }, context));
			try {
				const events = [];
				subscription.on('data', (event) => events.push(event));
				await older.isStaged;
				await PatchTable.patch(id, { name: 'newer' });
				await waitFor(() => events.some((event) => event.value?.name === 'newer'));
				older.release();
				await older.committed;
				await assertLastEventMerged(PatchTable, id, events);
			} finally {
				older.release();
				subscription.end();
			}
		});
	}

	it('delivers the merged record when the current-state scan saw the newer write', async () => {
		const FreshTable = table({ table: 'SubLatePatchFresh', database: 'subLatePatchFresh', attributes, audit: true });
		const id = 'late-patch-scan';
		await FreshTable.put(id, { name: 'v0' });
		const older = stageHeldTransaction((context) => FreshTable.patch(id, { other: 'older' }, context));
		let subscription;
		try {
			await older.isStaged;
			await FreshTable.patch(id, { name: 'newer' });
			subscription = await FreshTable.subscribe({ isCollection: true });
			const events = [];
			subscription.on('data', (event) => events.push(event));
			await waitFor(() => events.some((event) => event.value?.name === 'newer'));
			older.release();
			await older.committed;
			await assertLastEventMerged(FreshTable, id, events);
		} finally {
			older.release();
			subscription?.end();
		}
	});
});
