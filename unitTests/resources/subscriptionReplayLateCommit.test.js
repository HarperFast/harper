// On RocksDB a log key is reserved before its transaction commits, so a transaction can commit after a startTime
// replay passed a higher key; live delivery must still take it, once (harper#2311).
require('../testUtils');
const assert = require('assert');
const { setupTestDBPath } = require('../testUtils');
const { waitFor } = require('../waitFor.js');
const { table } = require('#src/resources/databases');
const { transaction } = require('#src/resources/transaction');
const { setMainIsWorker } = require('#src/server/threads/manageThreads');

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

function countBy(events, id) {
	return events.filter((event) => event.id === id).length;
}

describe('startTime replay handoff to live delivery', () => {
	let tableSequence = 0;
	function freshTable() {
		return table({
			table: `SubReplayLateCommit${++tableSequence}`,
			database: 'test',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'name' }],
			audit: true,
		});
	}
	before(() => {
		setupTestDBPath();
		setMainIsWorker(true);
	});

	for (const reportProgress of [false, true]) {
		it(`delivers once a transaction that commits after the replay passed a higher key${reportProgress ? ' (reportProgress)' : ''}`, async () => {
			const T = freshTable();
			const startTime = Date.now() - 1;
			const older = stageHeldTransaction((context) => T.put('older', { name: 'older' }, context));
			let subscription;
			try {
				await older.isStaged;
				await T.put('newer', { name: 'newer' });
				subscription = await T.subscribe({ startTime, isCollection: true, reportProgress });
				const events = [];
				subscription.on('data', (event) => events.push(event));
				await waitFor(() => events.some((event) => event.id === 'newer'), { timeout: 5000 });
				// set when the replay hands off to live delivery
				await waitFor(() => subscription.ungated, { timeout: 5000 });
				older.release();
				await older.committed;
				await T.put('sentinel', { name: 'sentinel' });
				await waitFor(() => events.some((event) => event.id === 'sentinel'), { timeout: 5000 });
				await waitFor(() => events.some((event) => event.id === 'older'), { timeout: 2000 }).catch(() => {});
				assert.equal(
					countBy(events, 'older'),
					1,
					`the late lower-key commit was not delivered exactly once: ${JSON.stringify(events.map((e) => e.id))}`
				);
				assert.equal(countBy(events, 'newer'), 1, 'the replayed write was not delivered exactly once');
				assert.equal(countBy(events, 'sentinel'), 1);
			} finally {
				older.release();
				await older.committed.catch(() => {});
				subscription?.end();
			}
		});
	}

	it('delivers each write exactly once while an older transaction is held open across the replay', async () => {
		const T = freshTable();
		const startTime = Date.now() - 1;
		const older = stageHeldTransaction((context) => T.put('older', { name: 'older' }, context));
		let subscription;
		const total = 300; // above the broadcast's 256-entry batch, so a pass can yield across the handoff
		try {
			await older.isStaged;
			const before = [];
			for (let i = 0; i < total / 2; i++) before.push(T.put(i, { name: 'before' + i }));
			await Promise.all(before);
			const inFlight = [];
			for (let i = total / 2; i < total; i++) inFlight.push(T.put(i, { name: 'inflight' + i }));
			subscription = await T.subscribe({ startTime, isCollection: true });
			const events = [];
			subscription.on('data', (event) => events.push(event));
			older.release();
			await Promise.all([...inFlight, older.committed]);
			await T.put('sentinel', { name: 'sentinel' });
			await waitFor(
				() => {
					const ids = new Set(events.map((event) => event.id));
					for (let i = 0; i < total; i++) if (!ids.has(i)) return false;
					return ids.has('older') && ids.has('sentinel');
				},
				{ timeout: 10000 }
			).catch(() => {});
			for (let i = 0; i < total; i++) assert.equal(countBy(events, i), 1, `id ${i} not delivered exactly once`);
			assert.equal(countBy(events, 'older'), 1, 'the held transaction was not delivered exactly once');
			assert.equal(countBy(events, 'sentinel'), 1);
		} finally {
			older.release();
			await older.committed.catch(() => {});
			subscription?.end();
		}
	});
});
