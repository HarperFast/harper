require('../testUtils');
const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { waitFor } = require('../waitFor.js');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#src/server/threads/manageThreads');
const { RequestTarget } = require('#src/resources/RequestTarget');

const ENGINE = process.env.HARPER_STORAGE_ENGINE ?? 'rocksdb';
const SWEEP_INTERVAL_MS = 60_000;
// resources/Table.ts RECORD_EXPIRATION_CHUNK_SIZE and the sweep's in-flight cap
const CHUNK_SIZE = 500;
const IN_FLIGHT_LIMIT = 50;

// The @expiresAt pruning sweep (harper#1481): it walks the expiry index for past deadlines and evicts
// the records, so they are physically reclaimed rather than only hidden from reads.
describe(`The @expiresAt pruning sweep (${ENGINE})`, function () {
	this.timeout(60_000);
	let tableCount = 0;
	const createdTables = [];

	function newTable() {
		const Table = table({
			table: `ExpiresAtSweep${tableCount++}`,
			database: 'test',
			audit: true,
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'deadline', expiresAt: true, indexed: true },
				{ name: 'tag', indexed: true },
			],
		});
		createdTables.push(Table);
		return Table;
	}

	// The real interval callback resumeMaintenance() arms, captured so a test runs one pass on demand
	async function captureSweep(Table) {
		await Table.closeMaintenance();
		const captured = [];
		const realSetInterval = globalThis.setInterval;
		globalThis.setInterval = (callback, interval, ...args) => {
			if (interval === SWEEP_INTERVAL_MS) captured.push(callback);
			return realSetInterval(callback, interval, ...args);
		};
		try {
			Table.resumeMaintenance();
		} finally {
			globalThis.setInterval = realSetInterval;
		}
		assert.strictEqual(captured.length, 1, 'precondition: resumeMaintenance() armed the @expiresAt sweep once');
		return captured[0];
	}

	// Delegates to the real native chunk read, recording each request and the entries it returned
	function recordChunks(Table, onChunk) {
		const index = Table.indices.deadline;
		const real = index.getCompositeRange;
		const chunks = [];
		index.getCompositeRange = function (options) {
			const entries = Array.from(real.call(this, options));
			chunks.push({ options, size: entries.length });
			onChunk?.(chunks.length);
			return entries;
		};
		return { chunks, restore: () => (index.getCompositeRange = real) };
	}

	// A bare array id would read as a batch put
	function targetFor(id) {
		if (!Array.isArray(id)) return id;
		const target = new RequestTarget();
		target.id = id;
		return target;
	}

	async function seed(Table, rows) {
		for (let start = 0; start < rows.length; start += 200) {
			await Promise.all(
				rows.slice(start, start + 200).map(({ id, record, options }) => Table.put(targetFor(id), record, options))
			);
		}
		await Table.primaryStore.committed;
	}

	const passFinished = (chunks) => chunks.length > 0 && chunks[chunks.length - 1].size < CHUNK_SIZE;

	before(function () {
		setupTestDBPath();
		setMainIsWorker(true);
	});

	afterEach(async function () {
		for (const Table of createdTables.splice(0)) await Table.closeMaintenance?.();
	});

	it('physically reclaims expired records and their index entries across several chunks', async function () {
		const Table = newTable();
		const sweep = await captureSweep(Table);
		const past = Date.now() - 10_000;
		const expired = [];
		// 1,203 rows over 7 repeated deadlines, so chunk boundaries fall inside runs of equal index values
		for (let n = 0; n < 1203; n++) {
			const id = n % 3 === 0 ? `s${n}` : n % 3 === 1 ? ['group', n] : [n % 4, `member-${n}`];
			expired.push({ id, record: { id, deadline: past - (n % 7), tag: 'expired' } });
		}
		const futureDeadline = Date.now() + 3_600_000;
		const controls = [
			{ id: 'future', record: { id: 'future', deadline: futureDeadline, tag: 'live' } },
			{ id: 'no-field', record: { id: 'no-field', tag: 'live' } },
			// a stored deadline overrides the past field: the index reaches it, the sweep must keep it
			{
				id: 'override',
				record: { id: 'override', deadline: past - 100, tag: 'live' },
				options: { expiresAt: futureDeadline },
			},
		];
		await seed(Table, [...expired, ...controls]);
		assert.strictEqual(Table.primaryStore.getEntry(['group', 1])?.expiresAt, past - 1, 'precondition: stored deadline');
		assert.strictEqual(Table.primaryStore.getEntry('override')?.expiresAt, futureDeadline, 'precondition');

		sweep();
		await waitFor(() => expired.every(({ id }) => Table.primaryStore.getEntry(id)?.value == null), {
			timeout: 20_000,
			message: () =>
				`${expired.filter(({ id }) => Table.primaryStore.getEntry(id)?.value != null).length} expired rows remain`,
		});
		await Table.primaryStore.committed;

		for (let offset = 0; offset < 7; offset++)
			assert.strictEqual(
				Table.indices.deadline.getValuesCount(past - offset),
				0,
				`index entries at deadline -${offset}`
			);
		assert.strictEqual(Table.indices.tag.getValuesCount('expired'), 0, 'secondary index entries are reclaimed');
		assert.strictEqual(Table.indices.tag.getValuesCount('live'), 3);
		for (const { id } of controls) assert.ok(Table.primaryStore.getEntry(id)?.value, `${id} survives`);
	});

	if (ENGINE !== 'rocksdb') return;

	it('reads finite chunks resumed from a full composite cursor and yields between them', async function () {
		const Table = newTable();
		const sweep = await captureSweep(Table);
		const past = Date.now() - 10_000;
		const futureDeadline = Date.now() + 3_600_000;
		const rows = [];
		// every candidate is in range but retained, so no eviction commit can supply the yields
		for (let n = 0; n < 1100; n++) {
			const id = ['kept', n % 7, n];
			rows.push({ id, record: { id, deadline: past - (n % 3), tag: 'kept' }, options: { expiresAt: futureDeadline } });
		}
		await seed(Table, rows);
		let sentinelFired = false;
		const chunksBeforeSentinel = [];
		const { chunks, restore } = recordChunks(Table, (count) => {
			if (!sentinelFired) chunksBeforeSentinel.push(count);
		});
		try {
			setImmediate(() => (sentinelFired = true));
			sweep();
			await waitFor(() => passFinished(chunks), 10_000);
		} finally {
			restore();
		}

		assert.strictEqual(chunks.length, 3, 'three chunk reads cover 1,100 candidates');
		for (const { options } of chunks) assert.strictEqual(options.limit, CHUNK_SIZE);
		assert.strictEqual(chunks[0].options.after, undefined);
		assert.deepStrictEqual(
			chunks.map(({ size }) => size),
			[500, 500, 100],
			'no candidate is skipped or read twice'
		);
		const cursor = chunks[1].options.after;
		assert.ok(Array.isArray(cursor) && cursor.length === 4, 'the cursor is the full [deadline, ...primaryKey] key');
		assert.deepStrictEqual(chunksBeforeSentinel, [1], 'the event loop runs between chunk reads');
		assert.strictEqual(Table.indices.tag.getValuesCount('kept'), 1100, 'retained candidates keep their rows');
	});

	it('admits at most a fixed number of evictions while their commits are pending', async function () {
		const Table = newTable();
		const sweep = await captureSweep(Table);
		const past = Date.now() - 10_000;
		const rows = [];
		for (let n = 0; n < 600; n++) rows.push({ id: n, record: { id: n, deadline: past, tag: 'expired' } });
		await seed(Table, rows);
		const realEvict = Table.evict;
		let release;
		const gate = new Promise((resolve) => (release = resolve));
		let pending = 0;
		let maxPending = 0;
		let admitted = 0;
		Table.evict = function (...args) {
			const eviction = realEvict.apply(this, args);
			admitted++;
			pending++;
			maxPending = Math.max(maxPending, pending);
			return Promise.resolve(eviction)
				.then(() => gate)
				.finally(() => pending--);
		};
		try {
			sweep();
			await waitFor(() => admitted >= IN_FLIGHT_LIMIT, 10_000);
			for (let turn = 0; turn < 20; turn++) await new Promise(setImmediate);
			assert.strictEqual(admitted, IN_FLIGHT_LIMIT, 'no eviction is admitted past the bound while commits are held');
			release();
			await waitFor(() => rows.every(({ id }) => Table.primaryStore.getEntry(id) === undefined), 20_000);
		} finally {
			release();
			Table.evict = realEvict;
		}
		assert.strictEqual(maxPending, IN_FLIGHT_LIMIT);
		assert.strictEqual(Table.indices.tag.getValuesCount('expired'), 0);
	});

	it('keeps a row with a past field but no stored deadline (explicit no-expiry or legacy metadata)', async function () {
		const Table = newTable();
		const sweep = await captureSweep(Table);
		const past = Date.now() - 10_000;
		await Table.put('no-expiry', { id: 'no-expiry', deadline: past, tag: 'kept' }, { expiresAt: -1 });
		await Table.put('z-expired', { id: 'z-expired', deadline: past, tag: 'expired' });
		await Table.primaryStore.committed;
		assert.strictEqual(
			Table.primaryStore.getEntry('no-expiry')?.expiresAt,
			undefined,
			'precondition: no stored deadline'
		);
		assert.strictEqual(Table.indices.deadline.getValuesCount(past), 2, 'precondition: the sweep reaches both');

		sweep();
		await waitFor(() => Table.primaryStore.getEntry('z-expired') === undefined, 10_000);

		assert.strictEqual(Table.primaryStore.getEntry('no-expiry')?.value.tag, 'kept');
		assert.strictEqual(Table.indices.deadline.getValuesCount(past), 1);
	});

	it('removes index entries of missing or deleted records and keeps the retained tombstone', async function () {
		const Table = newTable();
		const sweep = await captureSweep(Table);
		const past = Date.now() - 10_000;
		await Table.put('deleted', { id: 'deleted', tag: 'gone' });
		await Table.delete('deleted');
		await Table.primaryStore.committed;
		const tombstone = Table.primaryStore.getEntry('deleted');
		assert.ok(tombstone && tombstone.value === null, 'precondition: the delete left a tombstone');
		Table.indices.deadline.putSync(past, 'deleted');
		Table.indices.deadline.putSync(past, 'missing');
		await Table.put('z-expired', { id: 'z-expired', deadline: past, tag: 'expired' });
		await Table.primaryStore.committed;
		assert.strictEqual(Table.indices.deadline.getValuesCount(past), 3, 'precondition');

		sweep();
		await waitFor(() => Table.indices.deadline.getValuesCount(past) === 0, 10_000);

		const after = Table.primaryStore.getEntry('deleted');
		assert.ok(after && after.value === null && after.version === tombstone.version, 'the tombstone is untouched');
		assert.strictEqual(Table.primaryStore.getEntry('z-expired'), undefined);
	});

	it('stops a multi-chunk pass on closeMaintenance() and settles its admitted work', async function () {
		const Table = newTable();
		const sweep = await captureSweep(Table);
		const past = Date.now() - 10_000;
		const rows = [];
		for (let n = 0; n < 1100; n++) rows.push({ id: n, record: { id: n, deadline: past - (n % 5), tag: 'expired' } });
		await seed(Table, rows);
		let closing;
		const { chunks, restore } = recordChunks(Table, (count) => {
			if (count === 2) closing = Table.closeMaintenance();
		});
		try {
			sweep();
			await waitFor(() => closing !== undefined, {
				timeout: 10_000,
				message: () => `chunks read: ${JSON.stringify(chunks)}`,
			});
			await closing;
			const chunkReadsAtClose = chunks.length;
			for (let turn = 0; turn < 20; turn++) await new Promise(setImmediate);
			assert.strictEqual(chunks.length, chunkReadsAtClose, 'no chunk is read after close settles');
		} finally {
			restore();
		}
		assert.strictEqual(chunks.length, 2, 'the pass stopped at its second chunk');
		const remaining = rows.filter(({ id }) => Table.primaryStore.getEntry(id)).length;
		assert.ok(remaining > 0 && remaining < rows.length, `the pass stopped part way (${remaining} remain)`);

		// resume arms the sweep once, and the next pass finishes the backlog
		const resumed = await captureSweep(Table);
		resumed();
		await waitFor(() => rows.every(({ id }) => Table.primaryStore.getEntry(id) === undefined), 20_000);
	});
});
