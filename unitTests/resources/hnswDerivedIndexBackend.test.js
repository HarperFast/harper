const assert = require('node:assert');
const { waitFor } = require('../waitFor');
const { DERIVED_INDEX_ACCEPTED } = require('#src/resources/derivedIndexRuntime');
const { HnswDerivedIndexBackend } = require('#src/resources/indexes/hnswDerivedIndex');

const OWNER_EPOCH = 7n;
const SLOW_APPLY_MILLIS = 6; // exceeds the backend's 5 ms apply slice, so a slice ends mid-batch

const BATCH_RECORDS = 2;

class ControlledIndex {
	applied = [];
	barriers = [];
	#applyMillis;
	#store = new Map();

	constructor(applyMillis) {
		this.#applyMillis = applyMillis;
	}

	indexStore = {
		getSync: (key) => this.#store.get(key),
		putSync: (key, value) => this.#store.set(key, value),
		removeSync: (key) => this.#store.delete(key),
		clear: async () => this.#store.clear(),
	};

	applyDerivedValue(primaryKey) {
		const until = performance.now() + this.#applyMillis;
		while (performance.now() < until);
		this.applied.push(primaryKey);
	}

	flushDerived() {
		const barrier = { appliedAtStart: this.applied.length, startedAt: performance.now() };
		barrier.settled = new Promise((settle, fail) => Object.assign(barrier, { settle, fail }));
		this.barriers.push(barrier);
		return barrier.settled;
	}

	resetDerivedStorage() {}
}

function makeBatch(sequence, size = BATCH_RECORDS) {
	const first = (sequence - 1) * size + 1;
	return {
		ownerEpoch: OWNER_EPOCH,
		transactions: [],
		records: Array.from({ length: size }, (_, offset) => ({
			recordId: first + offset,
			logVersion: first + offset,
			state: { kind: 'record', projection: [1, 0, 0, 0], version: first + offset },
		})),
		through: { format: 1, logs: { local: sequence } },
		bytes: size,
	};
}

describe('HnswDerivedIndexBackend durability barriers', () => {
	let index, backend, wakes;
	const host = {
		isOwnerEpoch: (epoch) => epoch === OWNER_EPOCH,
		getReadiness: () => ({ state: 'ready', ownerEpoch: OWNER_EPOCH, rebuildAttempts: 0 }),
	};

	const start = (applyMillis = SLOW_APPLY_MILLIS) => {
		index = new ControlledIndex(applyMillis);
		backend = new HnswDerivedIndexBackend('hnsw:test/vector', index);
		backend.attach(host);
		wakes = [];
		backend.onStateChange((change) => wakes.push(change));
	};

	beforeEach(() => start());
	// Not awaited: a case that leaves a barrier unsettled would never resolve the shutdown.
	afterEach(() => void backend.shutdown(OWNER_EPOCH).catch(() => {}));

	const deliver = (count, size) => {
		for (let sequence = 1; sequence <= count; sequence++)
			assert.equal(backend.deliver(makeBatch(sequence, size)), DERIVED_INDEX_ACCEPTED);
	};
	const deliverRebuildChunks = (count, size) => {
		for (let sequence = 1; sequence <= count; sequence++) {
			const chunk = makeBatch(sequence, size);
			delete chunk.through;
			chunk.rebuild = true;
			assert.equal(backend.deliver(chunk), DERIVED_INDEX_ACCEPTED);
		}
	};
	const settled = (millis = 60) => new Promise((resolve) => setTimeout(resolve, millis));

	it('starts a requested barrier at a completed batch instead of waiting for the queue to drain', async () => {
		deliver(3);
		backend.flush('threshold');
		const barrier = await waitFor(() => index.barriers[0], 5000);
		assert.equal(barrier.appliedAtStart, BATCH_RECORDS, 'the barrier covers one completed batch, not the queue');
		assert.deepStrictEqual(backend.getDurableCursor(), undefined, 'the cursor lands only once the plane is durable');

		await settled();
		assert.equal(index.applied.length, BATCH_RECORDS);

		barrier.settle();
		await waitFor(() => index.applied.length === 3 * BATCH_RECORDS, 5000);
		assert.deepStrictEqual(
			backend.getDurableCursor(),
			{ format: 1, logs: { local: 1 } },
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

	it('takes the next batch boundary when a whole batch fits inside one apply slice', async () => {
		start(0);
		deliver(6, 50);
		backend.flush('threshold');
		const barrier = await waitFor(() => index.barriers[0], 5000);
		assert.equal(barrier.appliedAtStart, 50, 'the barrier waits for one batch, not for the queue to drain');
	});

	it('idles after an expensive barrier instead of spending the catch-up inside barriers', async () => {
		const barrierMillis = 60;
		deliver(40);
		backend.flush('threshold');
		const first = await waitFor(() => index.barriers[0], 5000);
		await new Promise((resolve) => setTimeout(resolve, barrierMillis));
		first.settle();
		const settledAt = performance.now();
		const cost = settledAt - first.startedAt;
		await waitFor(() => index.applied.length > first.appliedAtStart, 5000);
		backend.flush('age');
		const second = await waitFor(() => index.barriers[1], 5000);
		assert(
			second.startedAt - settledAt >= 3 * cost,
			`second barrier interrupted ${Math.round(second.startedAt - settledAt)} ms after a ${Math.round(cost)} ms barrier`
		);
		second.settle();
	});

	it('does not interrupt an apply slice for a chunk with no cursor to advance', async () => {
		start(0);
		deliverRebuildChunks(6, 50);
		backend.flush('threshold');
		const barrier = await waitFor(() => index.barriers[0], 5000);
		assert.equal(barrier.appliedAtStart, 300, 'queued rebuild chunks apply through to the drain');
		assert.equal(backend.getDurableCursor(), undefined, 'a rebuild scan publishes no cursor');
	});

	it('publishes every completed batch across a catch-up spanning several barriers', async () => {
		deliver(4);
		backend.flush('threshold');
		for (let sequence = 1; sequence < 4; sequence++) {
			const barrier = await waitFor(() => index.barriers[sequence - 1], 5000);
			assert.equal(barrier.appliedAtStart, sequence * BATCH_RECORDS);
			backend.flush('age');
			barrier.settle();
			await waitFor(() => backend.getDurableCursor()?.logs.local === sequence, 5000);
		}
		(await waitFor(() => index.barriers[3], 5000)).settle();
		await waitFor(() => backend.getDurableCursor()?.logs.local === 4, 5000);
	});
});
