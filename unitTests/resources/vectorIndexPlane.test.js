/**
 * Coverage for the native HNSW traversal plane, phase 1 (dual-write + opt-in search cutover,
 * hnsw-native-plane.md §8): with `nativePlane: true` every graph mutation is mirrored into a
 * plane file next to the index store and searches run through the native module, while the
 * RocksDB column family stays authoritative. The plane graph must be a bit-identical mirror of
 * the CF graph (same ids/levels/edges), so a native search over it must return the same
 * candidates as the JS traversal of the CF graph at equal ef.
 *
 * The whole suite is skipped when the optional native artifact is absent — build it with
 * `npm run build:hnsw-plane`.
 */
require('../testUtils');
const assert = require('node:assert');
const fs = require('node:fs');
const { setupTestDBPath } = require('../testUtils');
const { table, resetDatabases } = require('#src/resources/databases');
const { HierarchicalNavigableSmallWorld } = require('#src/resources/indexes/HierarchicalNavigableSmallWorld');
const { getPlaneBinding, planeStalePathFor } = require('#src/resources/indexes/hnswPlaneBinding');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');

async function fromAsync(iterable) {
	const out = [];
	for await (const value of iterable) out.push(value);
	return out;
}

const DIMS = 24;
const N = 1200;
const EF = 200;
const DB = 'test';

// Deterministic clustered corpus: 20 well-separated centers plus per-vector noise, so graphs are
// meaningful (uniform-random high-dim corpora defeat ANN) and runs are reproducible.
let seedState = 42;
function rand() {
	seedState = (seedState * 1103515245 + 12345) % 2147483648;
	return seedState / 2147483648;
}
const centers = [];
for (let c = 0; c < 20; c++) {
	const center = new Array(DIMS);
	for (let d = 0; d < DIMS; d++) center[d] = rand() * 2 - 1;
	centers.push(center);
}
function makeVector(i) {
	const center = centers[i % centers.length];
	const v = new Array(DIMS);
	for (let d = 0; d < DIMS; d++) v[d] = center[d] + (rand() - 0.5) * 0.2;
	return v;
}

describe('HNSW native plane dual-write', function () {
	if (process.env.HARPER_STORAGE_ENGINE === 'lmdb') return; // custom object index is RocksDB-only here
	if (!getPlaneBinding()) {
		it.skip('skipped: native hnsw-plane module not built (npm run build:hnsw-plane)', () => {});
		return;
	}
	let PlaneTest;
	const vectors = new Map(); // id → current vector
	before(async () => {
		setupTestDBPath();
		setMainIsWorker(true);
		PlaneTest = table({
			table: 'PlaneTest',
			database: DB,
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'name', indexed: true },
				{ name: 'vector', indexed: { type: 'HNSW', nativePlane: true }, type: 'Array' },
			],
		});
		for (let i = 0; i < N; i++) {
			const vector = makeVector(i);
			vectors.set(i, vector);
			await PlaneTest.put(i, { name: 'rec' + i, vector });
		}
	});

	function customIndex() {
		return PlaneTest.indices.vector.customIndex;
	}

	// A flag-off HierarchicalNavigableSmallWorld over the SAME index store: the pure JS traversal
	// of the CF graph, the reference the plane must match.
	function jsReference() {
		return new HierarchicalNavigableSmallWorld(PlaneTest.indices.vector, {});
	}

	async function searchBoth(target, filter) {
		const condition = { target, comparator: 'sort', distance: 'cosine', ef: EF };
		const planeResult = customIndex().search(condition, { transaction: undefined }, filter);
		assert.equal(typeof planeResult?.then, 'function', 'the flagged index should search through the plane (async)');
		const planeEntries = await planeResult;
		const jsEntries = jsReference().search(condition, { transaction: undefined }, filter);
		assert.equal(typeof jsEntries?.then, 'undefined', 'the reference instance must use the JS path');
		return { planeEntries, jsEntries };
	}

	// Same candidate set; same order wherever consecutive distances are distinct (the plane
	// computes f32 distances vs the JS f64, so exact ties may swap — and post-load rescoring
	// restores exact order for real queries anyway).
	function assertParity(planeEntries, jsEntries) {
		const planeKeys = planeEntries.map((e) => e.key);
		const jsKeys = jsEntries.map((e) => e.key);
		assert.deepEqual(
			[...planeKeys].sort((a, b) => a - b),
			[...jsKeys].sort((a, b) => a - b),
			'plane and JS searches must return the same candidate set'
		);
		for (let i = 0; i < planeEntries.length; i++) {
			if (planeKeys[i] === jsKeys[i]) continue;
			const distanceGap = Math.abs(planeEntries[i].distance - jsEntries[i].distance);
			assert.ok(
				distanceGap < 1e-4,
				`order diverged at rank ${i} (${planeKeys[i]} vs ${jsKeys[i]}) with distance gap ${distanceGap}`
			);
		}
	}

	it('dual-writes into a plane file next to the index store', () => {
		const planePath = customIndex().planeFilePath();
		assert.ok(planePath, 'the index should resolve a plane file path');
		assert.ok(fs.existsSync(planePath), 'inserts through the flagged index should have created the plane file');
	});

	it('plane search returns the same candidates as the JS path at equal ef', async () => {
		for (const probe of [3, 77, 500]) {
			const { planeEntries, jsEntries } = await searchBoth(vectors.get(probe));
			assert.ok(planeEntries.length >= 100, `expected a full candidate list, got ${planeEntries.length}`);
			assertParity(planeEntries, jsEntries);
			assert.equal(planeEntries[0].key, probe, 'the probe vector should be its own nearest neighbor');
		}
	});

	it('parity holds after update-in-place and delete (including neighbor repair)', async () => {
		for (let i = 0; i < 100; i++) {
			const vector = makeVector(i + 5000);
			vectors.set(i, vector);
			await PlaneTest.put(i, { name: 'rec' + i, vector });
		}
		for (let i = 100; i < 200; i++) {
			vectors.delete(i);
			await PlaneTest.delete(i);
		}
		for (const probe of [0, 50, 300]) {
			const { planeEntries, jsEntries } = await searchBoth(vectors.get(probe));
			assertParity(planeEntries, jsEntries);
			for (const entry of planeEntries) {
				assert.ok(entry.key < 100 || entry.key >= 200, `deleted record ${entry.key} returned by the plane`);
			}
		}
	});

	it('predicate-filtered plane search returns only predicate-passing records', async () => {
		const filter = (primaryKey) => primaryKey % 3 === 0;
		const { planeEntries, jsEntries } = await searchBoth(vectors.get(21), filter);
		assert.ok(planeEntries.length > 0, 'filtered plane search should return results');
		for (const entry of planeEntries) {
			assert.equal(entry.key % 3, 0, `record ${entry.key} does not pass the predicate`);
		}
		// budget/pipelining semantics differ slightly under selective filters, so assert the head
		// of the ranking agrees rather than the full candidate set
		assert.equal(planeEntries[0].key, jsEntries[0].key, 'best filtered match should agree with the JS path');
	});

	it('full-stack query runs through the plane and rescoring restores exact order', async () => {
		const target = vectors.get(42);
		const results = await fromAsync(
			PlaneTest.search({
				sort: { attribute: 'vector', target, distance: 'cosine' },
				select: ['id', '$distance'],
				limit: 10,
			})
		);
		assert.equal(results.length, 10);
		assert.equal(results[0].id, 42, 'the probe vector should be its own nearest neighbor');
		for (let i = 1; i < results.length; i++) {
			assert.ok(results[i].$distance >= results[i - 1].$distance, 'rescored results must be ordered');
		}
		// conditions alongside the vector sort exercise the predicate pushdown through search.ts
		const filtered = await fromAsync(
			PlaneTest.search({
				sort: { attribute: 'vector', target, distance: 'cosine' },
				conditions: [{ attribute: 'name', comparator: 'gt', value: 'rec9' }],
				select: ['id', 'name'],
				limit: 20,
			})
		);
		assert.ok(filtered.length > 0);
		for (const record of filtered) assert.ok(record.name > 'rec9');
		// threshold comparator: int8 suppresses the traversal-time limit and rescoreResults
		// re-filters on exact distances post-load — via the plane path
		const within = await fromAsync(
			PlaneTest.search({
				conditions: [{ attribute: 'vector', comparator: 'le', value: 0.05, target }],
				select: ['id', '$distance'],
			})
		);
		assert.ok(within.length > 0, 'le threshold query should return nearby records');
		for (const record of within) assert.ok(record.$distance <= 0.05, `distance ${record.$distance} exceeds threshold`);
	});

	it('a throwing app filter surfaces as the query error without disabling the plane', async () => {
		const condition = { target: vectors.get(3), comparator: 'sort', distance: 'cosine', ef: EF };
		await assert.rejects(
			Promise.resolve(
				customIndex().search(condition, { transaction: undefined }, () => {
					throw new Error('filter boom');
				})
			),
			/filter boom/
		);
		const after = customIndex().search(condition, { transaction: undefined });
		assert.equal(typeof after?.then, 'function', 'the plane must stay enabled after an app-filter throw');
		assert.ok((await after).length > 0);
	});

	it('synchronous iteration of plane-backed results fails loudly instead of spinning', () => {
		const results = PlaneTest.search({
			sort: { attribute: 'vector', target: vectors.get(42), distance: 'cosine' },
			select: ['id'],
			limit: 5,
		});
		assert.throws(() => [...results], /async/i, 'sync iteration must throw, not loop on promise-shaped results');
	});

	it('overlapping next() calls on plane-backed results advance one shared cursor', async () => {
		const query = () => ({
			sort: { attribute: 'vector', target: vectors.get(42), distance: 'cosine' },
			select: ['id'],
			limit: 5,
		});
		const sequential = (await fromAsync(PlaneTest.search(query()))).map((record) => record.id);
		assert.ok(sequential.length > 2, 'need several results to detect a duplicate or a skip');
		const iterator = PlaneTest.search(query()).iterate({ async: true });
		// both issued before the first resolves: building an iterator per call returned entry 0
		// twice and dropped entry 1
		const [first, second] = await Promise.all([iterator.next(), iterator.next()]);
		const seen = [first.value.id, second.value.id];
		for (let next = await iterator.next(); !next.done; next = await iterator.next()) seen.push(next.value.id);
		assert.deepEqual(seen, sequential, 'overlapping next() calls must yield the sequential order exactly once');
	});

	it('an abandoned plane-backed iterable does not raise an unhandled rejection', async () => {
		const index = customIndex();
		const unhandled = [];
		const onUnhandled = (reason) => unhandled.push(reason);
		process.on('unhandledRejection', onUnhandled);
		try {
			// a post-load step that throws is the reachable way the pending pipeline rejects
			index.rescoreResults = () => {
				throw new Error('rescore boom');
			};
			const results = PlaneTest.search({
				sort: { attribute: 'vector', target: vectors.get(42), distance: 'cosine' },
				select: ['id'],
				limit: 5,
			});
			// aborted request / limit 0: the consumer walks away without a single next()
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

	it('reopens the same plane file across a restart', async () => {
		const planePath = customIndex().planeFilePath();
		const inodeBefore = fs.statSync(planePath).ino;
		resetDatabases();
		PlaneTest = table({
			table: 'PlaneTest',
			database: DB,
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'name', indexed: true },
				{ name: 'vector', indexed: { type: 'HNSW', nativePlane: true }, type: 'Array' },
			],
		});
		const { planeEntries, jsEntries } = await searchBoth(vectors.get(7));
		assertParity(planeEntries, jsEntries);
		assert.equal(fs.statSync(planePath).ino, inodeBefore, 'restart should reopen the plane file, not recreate it');
	});

	it('builds the plane lazily when the flag is enabled on an existing index', async () => {
		let Later = table({
			table: 'PlaneLater',
			database: DB,
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'vector', indexed: { type: 'HNSW' }, type: 'Array' },
			],
		});
		const laterVectors = new Map();
		for (let i = 0; i < 300; i++) {
			const vector = makeVector(i + 9000);
			laterVectors.set(i, vector);
			await Later.put(i, { vector });
		}
		assert.ok(
			!Later.indices.vector.customIndex.planeFilePath() ||
				!fs.existsSync(Later.indices.vector.customIndex.planeFilePath()),
			'no plane file before the flag is enabled'
		);
		resetDatabases();
		Later = table({
			table: 'PlaneLater',
			database: DB,
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'vector', indexed: { type: 'HNSW', nativePlane: true }, type: 'Array' },
			],
		});
		assert.ok(!Later.indexingOperation, 'nativePlane is search-only: enabling it must not trigger a reindex');
		const condition = { target: laterVectors.get(5), comparator: 'sort', distance: 'cosine', ef: EF };
		const planeEntries = await Later.indices.vector.customIndex.search(condition, { transaction: undefined });
		const jsEntries = new HierarchicalNavigableSmallWorld(Later.indices.vector, {}).search(condition, {
			transaction: undefined,
		});
		assert.ok(fs.existsSync(Later.indices.vector.customIndex.planeFilePath()), 'first search should build the plane');
		assert.deepEqual(
			planeEntries.map((e) => e.key).sort((a, b) => a - b),
			jsEntries.map((e) => e.key).sort((a, b) => a - b),
			'the lazily-mirrored plane must return the same candidate set'
		);
		await Later.dropTable();
	});

	it('a plane whose initial mirror never completed is not searched', async () => {
		const condition = { target: vectors.get(11), comparator: 'sort', distance: 'cosine', ef: EF };
		const index = customIndex();
		const plane = index.getPlane();
		assert.ok(plane, 'the plane should be attached');
		plane.setWatermark(0); // simulate a crashed/incomplete initial mirror
		index.planeReady = false;
		const jsResults = index.search(condition, { transaction: undefined });
		assert.equal(typeof jsResults?.then, 'undefined', 'an incomplete mirror must fall back to the JS path');
		assert.ok(jsResults.length > 0);
		plane.setWatermark(1);
		const planeResults = index.search(condition, { transaction: undefined });
		assert.equal(typeof planeResults?.then, 'function', 'a completed mirror serves searches again');
		await planeResults;
	});

	it('an unopenable plane file degrades to the JS path without erroring', async () => {
		const Foreign = table({
			table: 'PlaneForeign',
			database: DB,
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'vector', indexed: { type: 'HNSW', nativePlane: true }, type: 'Array' },
			],
		});
		const index = Foreign.indices.vector.customIndex;
		fs.writeFileSync(index.planeFilePath(), 'not a plane'); // e.g. a crashed create's leftovers
		for (let i = 0; i < 20; i++) await Foreign.put(i, { vector: makeVector(i + 20000) });
		const results = index.search(
			{ target: makeVector(20003), comparator: 'sort', distance: 'cosine', ef: 50 },
			{ transaction: undefined }
		);
		assert.equal(typeof results?.then, 'undefined', 'writes and searches must run on the JS path meanwhile');
		assert.ok(results.length > 0);
		await Foreign.dropTable();
	});

	it('a stale tombstone left without its plane file rebuilds instead of disabling the plane forever', async () => {
		const Orphan = table({
			table: 'PlaneOrphan',
			database: DB,
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'vector', indexed: { type: 'HNSW', nativePlane: true }, type: 'Array' },
			],
		});
		const index = Orphan.indices.vector.customIndex;
		for (let i = 0; i < 30; i++) await Orphan.put(i, { vector: makeVector(i + 40000) });
		const planePath = index.planeFilePath();
		const stalePath = planeStalePathFor(planePath);
		try {
			// the documented rollback, run by hand: the operator deletes the plane file while a
			// tombstone from an earlier undeletable-plane path is still sitting next to it
			index.resetDerivedStorage();
			fs.writeFileSync(stalePath, '');
			assert.ok(!fs.existsSync(planePath), 'precondition: tombstone present, plane file gone');
			const results = index.search(
				{ target: makeVector(40003), comparator: 'sort', distance: 'cosine', ef: 50 },
				{ transaction: undefined }
			);
			if (typeof results?.then === 'function') await results;
			assert.ok(!fs.existsSync(stalePath), 'the tombstone must be cleared, not left to disable the plane forever');
			assert.ok(fs.existsSync(planePath), 'the plane must rebuild once the tombstone is cleared');
		} finally {
			fs.rmSync(stalePath, { force: true });
			await Orphan.dropTable();
		}
	});

	it('disabling the flag deletes the plane file so a re-enable rebuilds instead of adopting it stale', async () => {
		const planePath = customIndex().planeFilePath();
		assert.ok(fs.existsSync(planePath));
		resetDatabases();
		PlaneTest = table({
			table: 'PlaneTest',
			database: DB,
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'name', indexed: true },
				{ name: 'vector', indexed: { type: 'HNSW' }, type: 'Array' },
			],
		});
		assert.ok(!PlaneTest.indexingOperation, 'removing the search-only flag must not reindex');
		assert.ok(!fs.existsSync(planePath), 'the derived plane file should be deleted with the flag off');
		// mutate while the flag is off, then re-enable: the rebuilt plane must see the mutation
		const vector = makeVector(30001);
		vectors.set(1201, vector);
		await PlaneTest.put(1201, { name: 'rec1201', vector });
		resetDatabases();
		PlaneTest = table({
			table: 'PlaneTest',
			database: DB,
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'name', indexed: true },
				{ name: 'vector', indexed: { type: 'HNSW', nativePlane: true }, type: 'Array' },
			],
		});
		const { planeEntries, jsEntries } = await searchBoth(vector);
		assertParity(planeEntries, jsEntries);
		assert.equal(planeEntries[0].key, 1201, 'a record written while the flag was off must be in the rebuilt plane');
	});

	it('index drop removes the plane file', async () => {
		const planePath = customIndex().planeFilePath();
		assert.ok(fs.existsSync(planePath));
		await PlaneTest.dropTable();
		assert.ok(!fs.existsSync(planePath), 'dropping the table should delete the plane file');
	});
});
