const assert = require('node:assert');
const { table } = require('#src/resources/databases');

// Regression tests for #1712: bulk-deleting nodes (including the entry point) could sever a
// cluster of survivors into a disconnected island — internally connected, so the empty-list
// orphan check never fired, but with no path from the entry point, making the records
// unreachable by search at any ef. Mirrors the workload of the flaky integration test
// integrationTests/server/vector-index-integrity.test.ts ("delete-entry-point").

// Same deterministic vector generator as the integration test.
function seedVector(seed, dims = 8) {
	let s = (seed * 1664525 + 1013904223) >>> 0;
	const rand = () => {
		s = (s * 1664525 + 1013904223) >>> 0;
		return s / 4294967296;
	};
	const v = [];
	let mag = 0;
	for (let i = 0; i < dims; i++) {
		const x = rand() * 2 - 1;
		v.push(x);
		mag += x * x;
	}
	const inv = 1 / (Math.sqrt(mag) || 1);
	return v.map((x) => x * inv);
}

async function fromAsync(iterable) {
	const out = [];
	for await (const x of iterable) out.push(x);
	return out;
}

const DIMS = 8;
const N = 50;
const SURVIVORS = 10;
const deleteCount = N - SURVIVORS;

describe('HNSW delete connectivity repair (#1712)', () => {
	if (process.env.HARPER_STORAGE_ENGINE === 'lmdb') return; // don't try to test lmdb
	let tableSeq = 0;

	function makeTable() {
		return table({
			table: 'DelConn' + tableSeq++,
			database: 'test',
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'embedding', indexed: { type: 'HNSW', distance: 'cosine' }, type: 'Array' },
			],
		});
	}

	// Insert N, bulk-delete the first deleteCount (almost always including the entry point),
	// then assert the surviving graph is fully connected and every survivor is searchable.
	async function runWorkload(vectorTable) {
		for (let i = 0; i < N; i++) {
			await vectorTable.put(`ep-${i}`, { embedding: seedVector(i, DIMS) });
		}
		for (let i = 0; i < deleteCount; i++) {
			await vectorTable.delete(`ep-${i}`);
		}
		const connectivity = vectorTable.indices.embedding.customIndex.validateConnectivity();
		assert.equal(
			connectivity.isFullyConnected,
			true,
			`bulk delete severed survivors from the entry point (avg connections ${connectivity.averageConnections})`
		);
		const results = await fromAsync(
			vectorTable.search({
				sort: { attribute: 'embedding', target: seedVector(N + 1, DIMS), distance: 'cosine' },
				select: ['id'],
				limit: SURVIVORS + 5,
			})
		);
		const resultIds = new Set(results.map((r) => r.id));
		for (let i = deleteCount; i < N; i++) {
			assert.ok(resultIds.has(`ep-${i}`), `survivor ep-${i} not reachable by search`);
		}
	}

	it('deterministic severed-island topology stays fully connected and searchable', async () => {
		// HNSW level assignment draws from Math.random, so graph topology varies per run. Pin the
		// stream to a seed empirically chosen to build the failing topology: pre-fix, this exact
		// seed severs a mutually-linked island of survivors 10/10 runs (3/10 survivors unreachable
		// at any ef). The repair (repairSeveredNeighbors) must reconnect it.
		const realRandom = Math.random;
		let s = 57;
		Math.random = () => {
			s = (s * 1664525 + 1013904223) >>> 0;
			return s / 4294967296;
		};
		try {
			await runWorkload(makeTable());
		} finally {
			Math.random = realRandom;
		}
	});

	it('random topologies stay fully connected and searchable across repeated bulk deletes', async () => {
		// Unpinned sweep for breadth: pre-fix this workload severed survivors in ~1% of runs.
		for (let trial = 0; trial < 50; trial++) {
			await runWorkload(makeTable());
		}
	});
});
