// The replication (source-applied) shape of harper#1968: a replicated transaction that carries two
// updates to the same record must leave the secondary index holding only the record's final value.
// Both updates still apply — 4.7 avoided the phantom only by dropping the second as a duplicate
// timestamp, which left the record on the intermediate value.
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

const TRANSITIONS = ['STOPPING', 'STOPPED', 'STARTING', 'RUNNING'];

describe('secondary index vs. replicated (source-applied) status transitions', () => {
	let Inst, sub;

	before(async () => {
		setupTestDBPath();
		setMainIsWorker(true);
		Inst = table({
			table: 'IndexOrphanReplica',
			database: 'test',
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'status', indexed: true },
			],
			audit: true,
		});
		if (Inst.indexingOperation) await Inst.indexingOperation;
		Inst.sourcedFrom({
			subscribe() {
				return (sub = new IterableEventQueue());
			},
		});
		// sourcedFrom subscribes asynchronously; wait for the subscription itself, not a guessed delay
		await waitFor(() => sub, { message: 'source subscription was never established' });
	});

	async function applyTransitions(id, statuses, { awaitEach }) {
		let ts = Date.now();
		const commits = [];
		for (const status of statuses) {
			ts += 1;
			const done = new Promise((resolve) => {
				sub.send({
					type: 'patch',
					id,
					table: 'IndexOrphanReplica',
					timestamp: ts,
					value: { status },
					beginTxn: true,
				});
				sub.send({ type: 'end_txn', localTime: ts, onCommit: resolve });
			});
			commits.push(done);
			if (awaitEach) await done;
		}
		await Promise.all(commits);
		await waitForStatus(id, statuses[statuses.length - 1]);
	}

	// the applies commit asynchronously off the subscription queue; wait for the last one to land
	// rather than for a fixed duration
	async function waitForStatus(id, status) {
		await waitFor(async () => (await Inst.get(id))?.status === status, {
			message: `record ${id} never reached ${status}`,
		});
	}

	async function indexState(id) {
		const found = [];
		for (const status of new Set(['RUNNING', ...TRANSITIONS])) {
			const rows = await collect(Inst.search({ conditions: [{ attribute: 'status', value: status }] }));
			if (rows.some((r) => r.id === id)) found.push(status);
		}
		return found;
	}

	it('pipelined apply (no backpressure) leaves no phantom index entries', async () => {
		const id = 'pipelined';
		await Inst.put({ id, status: 'RUNNING' });
		await applyTransitions(id, TRANSITIONS, { awaitEach: false });
		const record = await Inst.get(id);
		assert.deepStrictEqual(await indexState(id), [record.status]);
	});

	it('two updates to the same record in ONE replicated transaction leave no phantom', async () => {
		const id = 'same-txn';
		await Inst.put({ id, status: 'RUNNING' });
		const ts = Date.now() + 1000;
		await new Promise((resolve) => {
			sub.send({
				type: 'patch',
				id,
				table: 'IndexOrphanReplica',
				timestamp: ts,
				value: { status: 'STOPPING' },
				beginTxn: true,
			});
			sub.send({
				type: 'patch',
				id,
				table: 'IndexOrphanReplica',
				timestamp: ts,
				value: { status: 'STOPPED' },
				beginTxn: false,
			});
			sub.send({ type: 'end_txn', localTime: ts, onCommit: resolve });
		});
		await waitForStatus(id, 'STOPPED');
		const record = await Inst.get(id);
		assert.deepStrictEqual(await indexState(id), [record.status], `index should hold only ${record.status}`);
	});

	it('serialized apply (backpressured) leaves no phantom index entries', async () => {
		const id = 'serialized';
		await Inst.put({ id, status: 'RUNNING' });
		await applyTransitions(id, TRANSITIONS, { awaitEach: true });
		const record = await Inst.get(id);
		assert.deepStrictEqual(await indexState(id), [record.status]);
	});
});
