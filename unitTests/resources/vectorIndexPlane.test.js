require('../testUtils');
const assert = require('node:assert');
const fs = require('node:fs');
const { Worker } = require('node:worker_threads');
const { setupTestDBPath } = require('../testUtils');
const { waitFor } = require('../waitFor');
const { table, resetDatabases } = require('#src/resources/databases');
const { DatabaseTransaction } = require('#src/resources/DatabaseTransaction');
const { getPlaneBinding } = require('#src/resources/indexes/hnswPlaneBinding');
const { DERIVED_INDEX_CURSOR_KEY, derivedIndexReadiness } = require('#src/resources/indexes/hnswDerivedIndex');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');

/** Shared readiness the owning worker publishes for a table's vector index, readable on any worker. */
function indexReady(Table) {
	return derivedIndexReadiness(Table.auditStore, Table.indices.vector.name).state === 'ready';
}

async function fromAsync(iterable) {
	const out = [];
	for await (const value of iterable) out.push(value);
	return out;
}

const DIMS = 24;
const N = 500;
const EF = 200;
const DB = 'vector-plane';
const RETAINED_MARKER = '__native-plane-reopen-marker__';
let seedState = 42;
function rand() {
	seedState = (seedState * 1103515245 + 12345) % 2147483648;
	return seedState / 2147483648;
}
const centers = Array.from({ length: 20 }, () => Array.from({ length: DIMS }, () => rand() * 2 - 1));
function makeVector(i) {
	const center = centers[i % centers.length];
	return center.map((value) => value + (rand() - 0.5) * 0.2);
}
function cosineDistance(a, b) {
	let dot = 0;
	let aa = 0;
	let bb = 0;
	for (let i = 0; i < a.length; i++) {
		dot += a[i] * b[i];
		aa += a[i] * a[i];
		bb += b[i] * b[i];
	}
	return 1 - dot / Math.sqrt(aa * bb);
}

describe('HNSW native plane file-primary delivery', function () {
	if (process.env.HARPER_STORAGE_ENGINE === 'lmdb') return;
	if (!getPlaneBinding()) {
		it.skip('skipped: @harperfast/hnsw native module is unavailable', () => {});
		return;
	}
	this.timeout(30_000);
	let PlaneTest;
	const vectors = new Map();

	function defineTable() {
		return table({
			table: 'PlaneTest',
			database: DB,
			audit: true,
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'name', indexed: true },
				{
					name: 'vector',
					indexed: { type: 'HNSW', nativePlane: true, efConstruction: 200 },
					type: 'Array',
				},
			],
		});
	}
	function customIndex() {
		return PlaneTest.indices.vector.customIndex;
	}
	async function nativeSearch(target, filter) {
		return await customIndex().search(
			{ target, comparator: 'sort', distance: 'cosine', ef: EF },
			{ transaction: undefined },
			filter
		);
	}
	async function readySearch(target, filter) {
		return waitFor(
			async () => {
				if (!indexReady(PlaneTest)) return false;
				try {
					return await nativeSearch(target, filter);
				} catch (error) {
					if (/rebuilding/.test(error.message)) return false;
					throw error;
				}
			},
			{ timeout: 15_000, message: 'native plane did not become searchable' }
		);
	}
	async function waitForKey(id, target) {
		return waitFor(
			async () => {
				const results = await readySearch(target);
				return results.some((entry) => entry.key === id);
			},
			{ timeout: 15_000, message: `native plane did not index record ${id}` }
		);
	}
	async function waitForCursors() {
		return waitFor(
			() => {
				const cursor = PlaneTest.indices.vector.getSync(DERIVED_INDEX_CURSOR_KEY);
				for (const logName of PlaneTest.auditStore.rootStore.listLogs()) {
					let latest;
					for (const entry of PlaneTest.auditStore.getRange({ start: 0, log: logName })) {
						if (entry.endTxn) latest = entry.txnLogKey;
					}
					if (latest !== undefined && cursor?.logs?.[logName] !== latest) return false;
				}
				return true;
			},
			{ timeout: 15_000, message: 'the durable cursor did not reach the committed tail of every log' }
		);
	}

	before(async () => {
		setupTestDBPath();
		setMainIsWorker(true);
		PlaneTest = defineTable();
		await PlaneTest.indexingOperation;
		const firstVector = makeVector(0);
		vectors.set(0, firstVector);
		await PlaneTest.put(0, { name: 'rec0', vector: firstVector });
		await waitForKey(0, firstVector);
		await waitForCursors();
		for (let i = 1; i < N; i++) {
			const vector = makeVector(i);
			vectors.set(i, vector);
			await PlaneTest.put(i, { name: `rec${i}`, vector });
		}
		await waitForKey(3, vectors.get(3));
		await waitFor(
			() => {
				let mappings = 0;
				for (const { key } of PlaneTest.indices.vector.getRange()) if (typeof key === 'number') mappings++;
				return mappings >= N;
			},
			{ timeout: 15_000, message: 'post-commit native delivery did not drain' }
		);
		await waitForCursors();
	});

	it('stores only primary-key mappings and cursors in RocksDB', () => {
		assert.ok(fs.existsSync(customIndex().planeFilePath()));
		let mappings = 0;
		for (const { key, value } of PlaneTest.indices.vector.getRange()) {
			if (typeof key !== 'number') continue;
			mappings++;
			assert.equal(value.level, undefined, 'the CF must not retain HNSW graph nodes');
			assert.equal(value.vector, undefined, 'the CF must not retain graph vectors');
			assert.equal(value.pending, undefined, 'published mappings must follow the native durability barrier');
			assert.notEqual(value.primaryKey, undefined, 'numeric entries are native-id to primary-key mappings');
		}
		assert.ok(mappings >= N);
	});

	it('builds searchable native state with deterministic recall', async () => {
		for (const probe of [3, 77, 300]) {
			const entries = await nativeSearch(vectors.get(probe));
			assert.equal(entries[0].key, probe);
			const expected = [...vectors]
				.sort((a, b) => cosineDistance(vectors.get(probe), a[1]) - cosineDistance(vectors.get(probe), b[1]))
				.slice(0, 10)
				.map(([id]) => id);
			const returned = new Set(entries.slice(0, 20).map((entry) => entry.key));
			assert.ok(
				expected.filter((id) => returned.has(id)).length >= 9,
				'recall@10 in the first 20 must be at least 0.9'
			);
		}
	});

	it('does not publish an aborted transaction to the plane', async () => {
		const vector = makeVector(50_000);
		const plane = customIndex().getPlane();
		const highWater = plane.idHighWater();
		const context = { transaction: new DatabaseTransaction() };
		await PlaneTest.put(50_000, { name: 'aborted', vector }, context);
		context.transaction.abort();
		assert.equal(await PlaneTest.get(50_000), undefined);
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(plane.idHighWater(), highWater, 'an aborted write must allocate no native node');
	});

	it('keeps repeated same-key replay mappings pending until the native flush', async () => {
		const id = 50_001;
		const vector = makeVector(id);
		const index = customIndex();
		index.applyDerivedValue(id, vector, 1);
		index.applyDerivedValue(id, vector, 2);
		assert.ok(!(await nativeSearch(vector)).some((entry) => entry.key === id));
		await index.flushDerived();
		assert.ok((await nativeSearch(vector)).some((entry) => entry.key === id));
		index.applyDerivedValue(id, undefined, 3);
		await index.flushDerived();
	});

	it('ignores unrelated field changes and applies committed update/delete', async () => {
		const plane = customIndex().getPlane();
		const highWater = plane.idHighWater();
		await PlaneTest.put(3, { name: 'renamed', vector: vectors.get(3) });
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(plane.idHighWater(), highWater, 'an unchanged vector must schedule no native insert');

		const updated = makeVector(60_003);
		vectors.set(3, updated);
		await PlaneTest.put(3, { name: 'renamed', vector: updated });
		await waitForKey(3, updated);
		await PlaneTest.delete(77);
		vectors.delete(77);
		await waitFor(async () => !(await readySearch(updated)).some((entry) => entry.key === 77), {
			timeout: 10_000,
			message: 'deleted native id remained searchable',
		});
	});

	it('applies predicates and full-stack exact rescoring', async () => {
		const filtered = await readySearch(vectors.get(21), (id) => id % 3 === 0);
		assert.ok(filtered.length > 0);
		for (const entry of filtered) assert.equal(entry.key % 3, 0);
		const target = vectors.get(42);
		const results = await fromAsync(
			PlaneTest.search({
				sort: { attribute: 'vector', target, distance: 'cosine' },
				select: ['id', '$distance'],
				limit: 10,
			})
		);
		assert.equal(results[0].id, 42);
		for (let i = 1; i < results.length; i++) assert.ok(results[i].$distance >= results[i - 1].$distance);
		const withCondition = await fromAsync(
			PlaneTest.search({
				sort: { attribute: 'vector', target, distance: 'cosine' },
				conditions: [{ attribute: 'name', comparator: 'gt', value: 'rec9' }],
				select: ['id', 'name'],
				limit: 20,
			})
		);
		assert.ok(withCondition.length > 0);
		for (const record of withCondition) assert.ok(record.name > 'rec9');
		const within = await fromAsync(
			PlaneTest.search({
				conditions: [{ attribute: 'vector', comparator: 'le', value: 0.05, target }],
				select: ['id', '$distance'],
			})
		);
		assert.ok(within.length > 0, 'le threshold query should return nearby records');
		for (const record of within) assert.ok(record.$distance <= 0.05, `distance ${record.$distance} exceeds threshold`);
	});

	it('surfaces a throwing app filter without disabling the native plane', async () => {
		const target = vectors.get(3);
		await assert.rejects(
			nativeSearch(target, () => {
				throw new Error('filter boom');
			}),
			/filter boom/
		);
		assert.ok((await readySearch(target)).length > 0);
	});

	it('rejects a wrong-dimension write and query as client errors, not index failures', async () => {
		const wrong = makeVector(0).concat(1);
		await assert.rejects(
			async () => PlaneTest.put(90_001, { name: 'wrong-dims', vector: wrong }),
			(error) => {
				assert.match(error.message, /components, but this index stores/);
				assert.equal(error.statusCode, 400, 'a wrong-length vector is the caller mistake, not a 503');
				return true;
			}
		);
		// The native insert would throw an unclassifiable error instead, which reconstruction
		// rethrows — one such record would abort every rebuild and strand the index at 503.
		assert.equal(await PlaneTest.get(90_001), undefined, 'the rejected write must not commit');
		await assert.rejects(
			async () => nativeSearch(wrong),
			(error) => {
				assert.match(error.message, /Search target has/);
				assert.equal(error.statusCode, 400);
				return true;
			}
		);
		// A BigInt component would throw out of Float32Array.from, which the caller reads as plane
		// corruption and answers by unlinking a healthy file.
		const bigintTarget = vectors.get(3).slice();
		bigintTarget[0] = 1n;
		await assert.rejects(async () => nativeSearch(bigintTarget), /not a finite 32-bit float/);
		assert.ok(fs.existsSync(customIndex().planeFilePath()), 'a malformed query must not unlink the plane');
		assert.ok((await readySearch(vectors.get(3))).length > 0, 'the index stays healthy');
	});

	it('rejects a component outside the f32 range instead of stranding reconstruction', async () => {
		const overflowing = makeVector(0).slice();
		overflowing[0] = 1e39; // finite as a double, Infinity as the f32 the plane stores
		await assert.rejects(
			async () => PlaneTest.put(90_002, { name: 'f32-overflow', vector: overflowing }),
			(error) => {
				assert.match(error.message, /not a finite 32-bit float/);
				assert.equal(error.statusCode, 400);
				return true;
			}
		);
		assert.equal(await PlaneTest.get(90_002), undefined, 'the rejected write must not commit');

		// f32-finite components whose squares are not: invMag would store 0 and every distance
		// involving the node would be NaN.
		const huge = makeVector(0).map(() => 1e20);
		await assert.rejects(
			async () => PlaneTest.put(90_003, { name: 'f32-magnitude', vector: huge }),
			/magnitude too large/
		);

		// Math.fround throws a TypeError on a BigInt, which is not a ClientError and would strand
		// reconstruction exactly as the native throw did.
		const bigint = makeVector(0).slice();
		bigint[0] = 1n;
		await assert.rejects(
			async () => PlaneTest.put(90_004, { name: 'f32-bigint', vector: bigint }),
			/not a finite 32-bit float/
		);

		assert.ok((await readySearch(vectors.get(3))).length > 0, 'the index stays healthy');
	});

	it('rejects synchronous iteration of asynchronous plane-backed results', () => {
		const results = PlaneTest.search({
			sort: { attribute: 'vector', target: vectors.get(42), distance: 'cosine' },
			select: ['id'],
			limit: 5,
		});
		assert.throws(() => [...results], /async/i, 'sync iteration must throw instead of spinning');
	});

	it('serializes overlapping next calls on one plane-backed result cursor', async () => {
		const query = () => ({
			sort: { attribute: 'vector', target: vectors.get(42), distance: 'cosine' },
			select: ['id'],
			limit: 5,
		});
		const sequential = (await fromAsync(PlaneTest.search(query()))).map((record) => record.id);
		assert.ok(sequential.length > 2, 'need several results to detect a duplicate or skip');
		const iterator = PlaneTest.search(query()).iterate({ async: true });
		const [first, second] = await Promise.all([iterator.next(), iterator.next()]);
		const seen = [first.value.id, second.value.id];
		for (let next = await iterator.next(); !next.done; next = await iterator.next()) seen.push(next.value.id);
		assert.deepEqual(seen, sequential, 'overlapping next calls must yield the sequential order exactly once');
	});

	it('does not raise an unhandled rejection when a plane-backed iterable is abandoned', async () => {
		const index = customIndex();
		const unhandled = [];
		const onUnhandled = (reason) => unhandled.push(reason);
		process.on('unhandledRejection', onUnhandled);
		try {
			index.rescoreResults = () => {
				throw new Error('rescore boom');
			};
			const results = PlaneTest.search({
				sort: { attribute: 'vector', target: vectors.get(42), distance: 'cosine' },
				select: ['id'],
				limit: 5,
			});
			await results.iterate({ async: true }).return();
			await new Promise((resolve) => setTimeout(resolve, 100));
		} finally {
			delete index.rescoreResults;
			process.off('unhandledRejection', onUnhandled);
		}
		assert.deepEqual(
			unhandled.map((reason) => String(reason?.message ?? reason)),
			[],
			'an unobserved rejection here exits the process under Node default policy'
		);
	});

	it('serializes post-commit delivery from two workers into one native file', async () => {
		PlaneTest.indices.vector.putSync(RETAINED_MARKER, true);
		const worker = new Worker(require.resolve('./vectorIndexPlane-thread.js'), {
			workerData: { workerIndex: 1, workerCount: 2 },
		});
		const nextMessage = () =>
			new Promise((resolve, reject) => {
				worker.once('message', resolve);
				worker.once('error', reject);
			});
		try {
			const ready = await nextMessage();
			assert.equal(ready.type, 'ready');
			assert.equal(ready.retainedMarker, true, 'a peer worker should reopen a current plane without rebuilding it');
			const workerRecords = [];
			for (let i = 0; i < 20; i++) {
				const id = 2_000 + i;
				const vector = makeVector(id);
				vectors.set(id, vector);
				workerRecords.push({ id, name: `worker${i}`, vector });
			}
			const workerDone = nextMessage();
			worker.postMessage({ type: 'put', records: workerRecords });
			for (let i = 0; i < 20; i++) {
				const id = 3_000 + i;
				const vector = makeVector(id);
				vectors.set(id, vector);
				await PlaneTest.put(id, { name: `main${i}`, vector });
			}
			const result = await workerDone;
			assert.equal(result.type, 'done', result.stack ?? result.message);
			await waitForKey(2_003, vectors.get(2_003));
			await waitForKey(3_003, vectors.get(3_003));
		} finally {
			await worker.terminate();
		}
		const replacement = new Worker(require.resolve('./vectorIndexPlane-thread.js'), {
			workerData: { workerIndex: 1, workerCount: 2 },
		});
		try {
			const ready = await new Promise((resolve, reject) => {
				replacement.once('message', resolve);
				replacement.once('error', reject);
			});
			assert.equal(ready.type, 'ready');
			assert.equal(ready.retainedMarker, true, 'a replacement worker should reopen rather than rebuild the plane');
			await waitForCursors();
		} finally {
			await replacement.terminate();
		}
	});

	it('replays a committed write after its worker terminates before delivery', async () => {
		const id = 4_000;
		const vector = makeVector(id);
		vectors.set(id, vector);
		const worker = new Worker(require.resolve('./vectorIndexPlane-thread.js'), {
			workerData: { workerIndex: 1, workerCount: 2 },
		});
		try {
			const ready = await new Promise((resolve, reject) => {
				worker.once('message', resolve);
				worker.once('error', reject);
			});
			assert.equal(ready.type, 'ready');
			const committed = new Promise((resolve, reject) => {
				worker.once('message', resolve);
				worker.once('error', reject);
			});
			worker.postMessage({ type: 'commitAndBlock', record: { id, name: 'crash-window', vector } });
			assert.equal((await committed).type, 'committed');
		} finally {
			await worker.terminate();
		}

		const replacement = new Worker(require.resolve('./vectorIndexPlane-thread.js'), {
			workerData: { workerIndex: 1, workerCount: 2 },
		});
		try {
			const ready = await new Promise((resolve, reject) => {
				replacement.once('message', resolve);
				replacement.once('error', reject);
			});
			assert.equal(ready.type, 'ready');
			await waitForKey(id, vector);
		} finally {
			await replacement.terminate();
		}
	});

	it('rebuilds after a whole-table snapshot reload marker', async () => {
		PlaneTest.indices.vector.putSync(999_998, { primaryKey: 'stale-snapshot-mapping' });
		await PlaneTest.writeReloadMarker();
		await waitFor(() => indexReady(PlaneTest) && PlaneTest.indices.vector.getSync(999_998) === undefined, {
			timeout: 15_000,
			message: 'whole-table reload marker did not replace derived mappings',
		});
		await waitForKey(42, vectors.get(42));
	});

	it('rebuilds when a replacement worker replays a snapshot reload marker', async () => {
		PlaneTest.indices.vector.putSync(999_997, { primaryKey: 'stale-offline-snapshot-mapping' });
		await PlaneTest.derivedIndexRuntime.close();
		await PlaneTest.writeReloadMarker();
		resetDatabases();
		PlaneTest = defineTable();
		await waitFor(() => indexReady(PlaneTest) && PlaneTest.indices.vector.getSync(999_997) === undefined, {
			timeout: 15_000,
			message: 'replayed reload marker did not replace derived mappings',
		});
		await waitForKey(42, vectors.get(42));
	});

	it('recovers searchable native state across a database reset', async () => {
		const planePath = customIndex().planeFilePath();
		resetDatabases();
		PlaneTest = defineTable();
		await waitForKey(42, vectors.get(42));
		assert.ok(fs.existsSync(planePath));
	});

	it('rebuilds from primary records when its durable cursor is outside audit retention', async () => {
		const index = customIndex();
		const planePath = index.planeFilePath();
		// A live owner's shutdown barrier republishes the cursor it applied, so the stale cursor has to
		// be installed after the runtime has released — the shape of a restart onto a purged log.
		await PlaneTest.derivedIndexRuntime.close();
		PlaneTest.indices.vector.putSync(999_999, { primaryKey: 'stale-derived-mapping' });
		PlaneTest.indices.vector.putSync(DERIVED_INDEX_CURSOR_KEY, { format: 1, logs: { local: 1 } });

		resetDatabases();
		PlaneTest = defineTable();
		// The successor publishes ready on acquisition and meets the unresolvable cursor on its first
		// drain turn, so the rebuild is proven by the stale mapping's disappearance, not by a search.
		await waitFor(() => indexReady(PlaneTest) && PlaneTest.indices.vector.getSync(999_999) === undefined, {
			timeout: 15_000,
			message: 'the retention gap must replace stale derived mappings from primary records',
		});
		await waitForKey(42, vectors.get(42));
		assert.ok(fs.existsSync(planePath));
	});

	it('answers an empty index with no results instead of a rebuilding 503', async () => {
		const EmptyTable = table({
			table: 'PlaneEmpty',
			database: DB,
			audit: true,
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'vector', indexed: { type: 'HNSW', nativePlane: true, efConstruction: 200 }, type: 'Array' },
			],
		});
		const index = EmptyTable.indices.vector.customIndex;
		await waitFor(() => indexReady(EmptyTable), {
			timeout: 15_000,
			message: 'the empty derived runtime never became ready',
		});
		const results = await index.search(
			{ target: makeVector(0), comparator: 'sort', distance: 'cosine', ef: EF },
			{ transaction: undefined }
		);
		assert.deepEqual([...results], []);
		// The search target must not publish a placeholder file: a concurrent first insert would
		// read it as another worker's in-progress create and reject the write for a full minute.
		assert.ok(!fs.existsSync(index.planeFilePath()));
		await EmptyTable.dropTable();
	});

	it('reports 503 rather than no results when a populated index has lost its file', async () => {
		const LostFile = table({
			table: 'PlaneLostFile',
			database: DB,
			audit: true,
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'vector', indexed: { type: 'HNSW', nativePlane: true, efConstruction: 200 }, type: 'Array' },
			],
		});
		await LostFile.indexingOperation;
		const index = LostFile.indices.vector.customIndex;
		const probe = makeVector(5);
		await LostFile.put(1, { vector: probe });
		await waitFor(
			async () => {
				if (!indexReady(LostFile)) return false;
				const hits = await index.search(
					{ target: probe, comparator: 'sort', distance: 'cosine', ef: EF },
					{
						transaction: undefined,
					}
				);
				return [...hits].some((entry) => entry.key === 1);
			},
			{ timeout: 15_000, message: 'the populated index never became searchable' }
		);
		index.plane = undefined;
		fs.rmSync(index.planeFilePath(), { force: true });
		// The node mappings survive the file, so emptiness is not proven: answering [] here would
		// hide every indexed vector behind a query that looks successful.
		assert.throws(
			() => index.search({ target: probe, comparator: 'sort', distance: 'cosine', ef: EF }, { transaction: undefined }),
			/rebuilding/
		);
		await LostFile.dropTable();
	});

	it('requires audit logging and native construction geometry', () => {
		assert.throws(
			() =>
				table({
					table: 'PlaneNoAudit',
					database: DB,
					audit: false,
					attributes: [
						{ name: 'id', isPrimaryKey: true },
						{ name: 'vector', indexed: { type: 'HNSW', nativePlane: true }, type: 'Array' },
					],
				}),
			/audit logging/
		);
		assert.throws(
			() =>
				table({
					table: 'PlaneBadGeometry',
					database: DB,
					audit: true,
					attributes: [
						{ name: 'id', isPrimaryKey: true },
						{ name: 'vector', indexed: { type: 'HNSW', nativePlane: true, M: 8 }, type: 'Array' },
					],
				}),
			/requires M=16/
		);
		for (const bad of [[], { length: -1 }, { length: 1.5 }, {}]) {
			assert.throws(
				() => customIndex().prepareCommitted('bad-vector', bad, undefined, { transaction: {} }),
				/must be an array of at least one number/,
				`${JSON.stringify(bad)} must not reach the plane`
			);
		}
		// An already-audited table must not be able to turn auditing off underneath a nativePlane
		// index: nothing clears Table.audit, so the descriptor would persist audit: false and the
		// next process start would fail catalog load on the derived-index attach.
		assert.throws(
			() =>
				table({
					table: 'PlaneTest',
					database: DB,
					audit: false,
					attributes: [
						{ name: 'id', isPrimaryKey: true },
						{ name: 'name', indexed: true },
						{
							name: 'vector',
							indexed: { type: 'HNSW', nativePlane: true, efConstruction: 200 },
							type: 'Array',
						},
					],
				}),
			/audit logging/
		);
	});

	(process.env.HNSW_NATIVE_REBUILD_BENCHMARK ? it : it.skip)(
		'sustains the native rebuild insertion floor for 100k records',
		async function () {
			this.timeout(180_000);
			const total = 100_000;
			const index = customIndex();
			const startedAt = Date.now();
			for (let id = 100_000; id < 100_000 + total; id++) {
				index.applyDerivedValue(id, makeVector(id), id);
				if (id % 10_000 === 9_999) {
					await index.flushDerived(id);
					const indexed = id - 100_000 + 1;
					const rate = Math.round(indexed / Math.max((Date.now() - startedAt) / 1_000, 0.001));
					const eta = Math.ceil((total - indexed) / Math.max(rate, 1));
					console.log(`Native rebuild benchmark: ${indexed}/${total} records, ${rate}/s, ETA ${eta}s`);
				}
			}
			const rate = total / Math.max((Date.now() - startedAt) / 1_000, 0.001);
			assert.ok(rate >= 1_000, `native rebuild rate ${Math.round(rate)}/s is below the 1,000/s floor`);
		}
	);

	it('removes the native file when the table is dropped', async () => {
		const planePath = customIndex().planeFilePath();
		await PlaneTest.dropTable();
		assert.ok(!fs.existsSync(planePath));
	});
});
