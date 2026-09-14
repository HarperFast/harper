/**
 * harper#2537: a thread that reaches Table.indices through the schema load path (resetDatabases ->
 * initStores) rather than by declaring the schema held `isIndexing === false` for a rebuilding index
 * and served it — 200 with rows missing, while a primary-key read returned the same record.
 *
 * The backfill is held by blocking the declaring thread's event loop in `Atomics.wait`: runIndexing
 * suspends at its first await, so the index is empty there and no timing window is needed.
 */

require('../testUtils');
const assert = require('node:assert');
const { Worker } = require('node:worker_threads');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const manageThreads = require('#js/server/threads/manageThreads');
const { setMainIsWorker } = manageThreads;

const WAIT_MS = 30000;
const PROBE_ID = 'seed-3';
const PROBE_VALUE = '/p/3';

describe('an index being rebuilt is incomplete on every thread (harper#2537)', function () {
	this.timeout(60000);

	before(() => {
		setupTestDBPath();
		setMainIsWorker(true);
	});

	/**
	 * Runs the three-step probe on a second thread: before the rebuild is triggered, while it is held,
	 * and after it has completed. `trigger` runs on this thread between the first and second probe and
	 * must return without awaiting the backfill.
	 */
	async function withReader(tableName, attributeName, trigger) {
		const phase = new Int32Array(new SharedArrayBuffer(4));
		const ack = new Int32Array(new SharedArrayBuffer(4));
		const worker = new Worker(__dirname + '/indexRebuildThreadConsistency-thread.js', {
			workerData: {
				phase,
				ack,
				tableName,
				attributeName,
				probeValue: PROBE_VALUE,
				probeId: PROBE_ID,
				addPorts: [],
				// startWorker sends this key with every worker it spawns; the reader must adopt it, not mint
				// its own, or two live threads would disagree about which builds this process owns
				processIncarnation: manageThreads.processIncarnation,
			},
		});
		const probes = {};
		const failure = new Promise((_, reject) => worker.once('error', reject));
		worker.on('message', (message) => (probes[message.step] = message));
		const probed = (step) =>
			Promise.race([
				failure,
				new Promise((resolve) => {
					if (probes[step]) return resolve(probes[step]);
					worker.on('message', function onMessage(message) {
						if (message.step !== step) return;
						worker.off('message', onMessage);
						resolve(message);
					});
				}),
			]);
		// every exit from here must terminate the worker, or it stays blocked in Atomics.wait
		try {
			// Waits on the acknowledged step rather than on Atomics.wait's return: a reader that acks
			// before this thread reaches the wait makes it return 'not-equal', which is success, not failure.
			const release = (step) => {
				Atomics.store(phase, 0, step);
				Atomics.notify(phase, 0);
				const deadline = Date.now() + WAIT_MS;
				while (Atomics.load(ack, 0) < step) {
					const remaining = deadline - Date.now();
					if (remaining <= 0) return false;
					Atomics.wait(ack, 0, step - 1, remaining);
				}
				return true;
			};

			assert.ok(release(1), 'the reader thread never finished its pre-rebuild load');
			const before = await probed(1);

			const Table = trigger();
			assert.ok(Table.indexingOperation, 'the rebuild was not triggered, so nothing is held');
			// Blocking here keeps the backfill suspended at runIndexing's first await, so the reader
			// observes an armed descriptor over an index with nothing written to it yet.
			assert.ok(release(2), 'the reader thread never finished its mid-rebuild load');
			const during = await probed(2);

			await Table.indexingOperation;
			assert.ok(release(3), 'the reader thread never finished its post-rebuild load');
			const after = await probed(3);

			for (const probe of [before, during, after])
				assert.strictEqual(probe.failure, undefined, `reader thread failed at step ${probe.step}: ${probe.failure}`);
			return { before, during, after };
		} finally {
			await worker.terminate();
		}
	}

	function seed(tableName, attributes) {
		const Table = table({ table: tableName, database: 'test', schemaDefined: true, attributes });
		let lastPut;
		for (let i = 0; i < 8; i++) lastPut = Table.put({ id: `seed-${i}`, path: `/p/${i}` });
		return { Table, lastPut };
	}

	it('a thread that opened the table before the rebuild must not serve the partial index', async () => {
		const tableName = 'IndexThreadNewHandle';
		const { Table, lastPut } = seed(tableName, [
			{ name: 'id', type: 'ID', isPrimaryKey: true },
			{ name: 'path', type: 'String' },
		]);
		await lastPut;
		if (Table.indexingOperation) await Table.indexingOperation;

		const { before, during, after } = await withReader(tableName, 'path', () =>
			table({
				table: tableName,
				database: 'test',
				schemaDefined: true,
				attributes: [
					{ name: 'id', type: 'ID', isPrimaryKey: true },
					{ name: 'path', type: 'String', indexed: true },
				],
			})
		);

		assert.ok(before.loaded, 'the reader thread must have loaded the table before the rebuild');
		assert.strictEqual(
			before.processIncarnation,
			manageThreads.processIncarnation,
			'a worker must adopt the incarnation it was started with, so live threads agree on build ownership'
		);
		assert.strictEqual(before.isIndexing, null, 'there is no index on the attribute before the rebuild');

		assert.ok(
			during.foundById,
			'the probe record must be readable by primary key while the rebuild is held, or the test proves nothing'
		);
		assert.strictEqual(
			during.isIndexing,
			true,
			'a thread that loaded the table before the rebuild was triggered held isIndexing = false and served the partial index'
		);
		assert.match(
			during.searchError ?? '',
			/not indexed yet/,
			`a read of a rebuilding index must refuse, not return ${during.hits} rows for a record that exists`
		);

		assert.strictEqual(after.isIndexing, false, 'the reload after completion must clear isIndexing');
		assert.strictEqual(after.searchError, null, 'the completed index must serve reads');
		assert.strictEqual(after.hits, 1, 'the completed index must return the seeded record');
	});

	it('a handle the reader already holds is re-stamped, not left at its previous state', async () => {
		const tableName = 'IndexThreadReusedHandle';
		const indexedAttributes = (indexed) => [
			{ name: 'id', type: 'ID', isPrimaryKey: true },
			{ name: 'path', type: 'String', indexed },
		];
		const { Table, lastPut } = seed(tableName, indexedAttributes(true));
		await lastPut;
		if (Table.indexingOperation) await Table.indexingOperation;

		// A structural index-option change re-triggers the backfill over an attribute the reader thread
		// already holds an open index handle for, so its handle is reused by the reload rather than opened.
		const { before, during, after } = await withReader(tableName, 'path', () =>
			table({
				table: tableName,
				database: 'test',
				schemaDefined: true,
				attributes: indexedAttributes({ indexNulls: false }),
			})
		);

		assert.strictEqual(before.isIndexing, false, 'the completed index must be usable before the rebuild');
		assert.strictEqual(before.hits, 1, 'the completed index must return the seeded record before the rebuild');

		assert.strictEqual(
			during.isIndexing,
			true,
			'a handle already open on the reader thread must be re-stamped as rebuilding'
		);
		assert.match(
			during.searchError ?? '',
			/not indexed yet/,
			'a reused handle must also refuse reads while rebuilding'
		);

		assert.strictEqual(
			after.isIndexing,
			false,
			'the reload after completion must clear isIndexing on the reused handle'
		);
		assert.strictEqual(after.hits, 1, 'the rebuilt index must return the seeded record');
	});
});
