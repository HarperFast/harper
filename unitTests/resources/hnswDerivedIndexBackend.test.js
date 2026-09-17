const assert = require('node:assert');
const { waitFor } = require('../waitFor');
const { DERIVED_INDEX_ACCEPTED } = require('#src/resources/derivedIndexRuntime');
const { DERIVED_INDEX_CURSOR_KEY, HnswDerivedIndexBackend } = require('#src/resources/indexes/hnswDerivedIndex');

const OWNER_EPOCH = 7n;
// Longer than the backend's 5 ms apply slice, so exactly one record applies per slice and every
// barrier below starts at a known batch boundary rather than wherever the slice happened to end.
const APPLY_MILLIS = 6;
const BATCH_RECORDS = 2;

// The native plane and its mapping store, reduced to what the backend drives: application costs
// real wall time, and a barrier settles only when the test says so.
class ControlledIndex {
	applied = [];
	barriers = [];
	#store = new Map();
	indexStore = {
		getSync: (key) => this.#store.get(key),
		putSync: (key, value) => this.#store.set(key, value),
		removeSync: (key) => this.#store.delete(key),
		clear: async () => this.#store.clear(),
	};

	applyDerivedValue(primaryKey) {
		const until = performance.now() + APPLY_MILLIS;
		while (performance.now() < until);
		this.applied.push(primaryKey);
	}

	flushDerived() {
		const barrier = { appliedAtStart: this.applied.length };
		barrier.settled = new Promise((settle, fail) => Object.assign(barrier, { settle, fail }));
		this.barriers.push(barrier);
		return barrier.settled;
	}

	resetDerivedStorage() {}
}

function makeBatch(sequence) {
	const first = (sequence - 1) * BATCH_RECORDS + 1;
	return {
		ownerEpoch: OWNER_EPOCH,
		transactions: [],
		records: Array.from({ length: BATCH_RECORDS }, (_, offset) => ({
			recordId: first + offset,
			logVersion: first + offset,
			state: { kind: 'record', projection: [1, 0, 0, 0], version: first + offset },
		})),
		through: { local: { sequence, offset: sequence } },
		bytes: BATCH_RECORDS,
	};
}

describe('HnswDerivedIndexBackend durability barriers', () => {
	let index, backend, wakes;
	const host = {
		isOwnerEpoch: (epoch) => epoch === OWNER_EPOCH,
		getReadiness: () => ({ state: 'ready', ownerEpoch: OWNER_EPOCH, rebuildAttempts: 0 }),
	};

	beforeEach(() => {
		index = new ControlledIndex();
		backend = new HnswDerivedIndexBackend('hnsw:test/vector', index);
		backend.attach(host);
		wakes = [];
		backend.onStateChange((change) => wakes.push(change));
	});

	const deliver = (count) => {
		for (let sequence = 1; sequence <= count; sequence++)
			assert.equal(backend.deliver(makeBatch(sequence)), DERIVED_INDEX_ACCEPTED);
	};
	const settled = (millis = 60) => new Promise((resolve) => setTimeout(resolve, millis));

	it('starts a requested barrier at a completed batch instead of waiting for the queue to drain', async () => {
		deliver(3);
		backend.flush('threshold');
		const barrier = await waitFor(() => index.barriers[0], 5000);
		assert.equal(barrier.appliedAtStart, BATCH_RECORDS, 'the barrier covers one completed batch, not the queue');
		assert.deepStrictEqual(backend.getDurableCursor(), undefined, 'the cursor lands only once the plane is durable');

		// Application stays paused for the whole barrier, so the barrier cannot publish a mapping it
		// did not cover.
		await settled();
		assert.equal(index.applied.length, BATCH_RECORDS);

		barrier.settle();
		await waitFor(() => index.applied.length === 3 * BATCH_RECORDS, 5000);
		assert.deepStrictEqual(
			backend.getDurableCursor(),
			{ local: { sequence: 1, offset: 1 } },
			'the durable cursor is the batch the barrier covered, never a later one'
		);
	});

	it('coalesces repeated requests during a barrier into one follow-up barrier', async () => {
		deliver(4);
		backend.flush('threshold');
		const first = await waitFor(() => index.barriers[0], 5000);
		backend.flush('age');
		backend.flush('threshold');
		assert.equal(index.barriers.length, 1, 'a barrier in flight absorbs further requests');

		first.settle();
		const second = await waitFor(() => index.barriers[1], 5000);
		second.settle();
		await waitFor(() => index.applied.length === 4 * BATCH_RECORDS, 5000);
		assert.equal(index.barriers.length, 2, 'the coalesced requests cost exactly one follow-up barrier');
	});

	it('reports a barrier that fails mid-catch-up without applying more of the queue', async () => {
		deliver(4);
		backend.flush('threshold');
		const barrier = await waitFor(() => index.barriers[0], 5000);
		barrier.fail(new Error('EIO'));
		await waitFor(() => wakes.includes('failed'), 5000);

		await settled();
		assert.equal(index.applied.length, BATCH_RECORDS, 'a failed barrier does not resume application');
		assert.equal(index.barriers.length, 1);
	});

	it('publishes every completed batch across a catch-up spanning several barriers', async () => {
		deliver(4);
		backend.flush('threshold');
		for (let sequence = 1; sequence < 4; sequence++) {
			const barrier = await waitFor(() => index.barriers[sequence - 1], 5000);
			assert.equal(barrier.appliedAtStart, sequence * BATCH_RECORDS);
			backend.flush('age');
			barrier.settle();
			await waitFor(() => backend.getDurableCursor()?.local.sequence === sequence, 5000);
		}
		(await waitFor(() => index.barriers[3], 5000)).settle();
		await waitFor(() => backend.getDurableCursor()?.local.sequence === 4, 5000);
	});

	it('leaves a successor the durable cursor a mid-catch-up barrier published', async () => {
		deliver(3);
		backend.flush('threshold');
		(await waitFor(() => index.barriers[0], 5000)).settle();
		await waitFor(() => backend.getDurableCursor() !== undefined, 5000);

		// The queue does not survive a crash but the mapping store does, so a successor reopens on
		// the cursor the mid-catch-up barrier published and replays only what followed it.
		const successor = new HnswDerivedIndexBackend('hnsw:test/vector', index);
		successor.attach(host);
		assert.deepStrictEqual(successor.getDurableCursor(), { local: { sequence: 1, offset: 1 } });
		assert.equal(index.indexStore.getSync(DERIVED_INDEX_CURSOR_KEY).local.sequence, 1);
	});
});
