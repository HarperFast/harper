'use strict';
/**
 * HNSW search latency against the REAL Harper table stack (RocksDB + record cache), which is what
 * an application actually measures — benchmarks/hnsw-scale.js isolates graph behaviour over an
 * in-memory Map and so excludes node fetch/decode entirely.
 *
 * Optionally loads a real embedding pool (row-major float32) instead of random vectors; random
 * high-dimensional vectors have no cluster structure and are not representative of embeddings.
 *
 *   node --conditions=typestrip benchmarks/hnsw-real-store.cjs \
 *       --n=25000 --dims=768 --queries=100 [--corpus=/path/pool.f32] [--baseline] [--limit=10]
 *
 * --baseline restores the pre-fix descent (full ef at every layer) for an A/B on the same build.
 */
require('../unitTests/testUtils');
const fs = require('node:fs');
const { performance } = require('node:perf_hooks');
const { setupTestDBPath } = require('../unitTests/testUtils');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { HierarchicalNavigableSmallWorld } = require('#src/resources/indexes/HierarchicalNavigableSmallWorld');

const argv = Object.fromEntries(
	process.argv.slice(2).map((a) => {
		const [k, v] = a.replace(/^--/, '').split('=');
		return [k, v ?? true];
	})
);
const N = Number(argv.n ?? 25000);
const DIMS = Number(argv.dims ?? 768);
const Q = Number(argv.queries ?? 100);
const LIMIT = Number(argv.limit ?? 10);
const BASELINE = Boolean(argv.baseline);
const CORPUS = argv.corpus ? String(argv.corpus) : undefined;

function pct(sorted, p) {
	if (!sorted.length) return 0;
	return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

function loadPool() {
	if (!CORPUS) {
		const pool = new Float32Array(N * DIMS);
		for (let i = 0; i < pool.length; i++) pool[i] = Math.random() * 2 - 1;
		return pool;
	}
	const buf = fs.readFileSync(CORPUS);
	const raw = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
	if (Math.floor(raw.length / DIMS) < N) throw new Error(`corpus has ${Math.floor(raw.length / DIMS)} rows, need ${N}`);
	return raw;
}

function row(pool, i) {
	const out = new Array(DIMS);
	const base = i * DIMS;
	for (let d = 0; d < DIMS; d++) out[d] = pool[base + d];
	return out;
}

// Reproduce the pre-fix behaviour for A/B: an exact getKeysCount() per query to resolve the graph
// size, and every layer searched at the full ef. `baselineOn` toggles it per query so the two
// configurations can be interleaved — a shared machine drifts under other load, and comparing two
// separate runs attributes that drift to the code under test.
let baselineOn = false;
function installBaselineToggle() {
	const proto = HierarchicalNavigableSmallWorld.prototype;
	const originalSearch = proto.search;
	const originalSearchLayer = proto.searchLayer;
	let efForQuery = 0;
	proto.search = function (condition, context, filter, minResults) {
		if (baselineOn) {
			const count = this.indexStore.getKeysCount
				? this.indexStore.getKeysCount()
				: (this.indexStore.getStats?.()?.entryCount ?? 0);
			efForQuery = Math.min(512, Math.max(100, Math.round(100 * Math.sqrt(Math.max(1, count / 1000)))));
		}
		return originalSearch.call(this, condition, context, filter, minResults);
	};
	proto.searchLayer = function (v, epId, ep, ef, level, ...rest) {
		return originalSearchLayer.call(this, v, epId, ep, baselineOn && level > 0 ? efForQuery : ef, level, ...rest);
	};
}

// Attribute query time between fetching graph nodes from the store and everything else (distance
// arithmetic, heap/candidate-list maintenance). On the real stack the fetch includes decode, so this
// says whether the lever is "visit fewer nodes" or "make each node cheaper".
const nodeFetch = { calls: 0, ms: 0 };
const nodeCount = { calls: 0, ms: 0 };
function instrumentNodeFetch(T) {
	const proto = HierarchicalNavigableSmallWorld.prototype;
	const original = proto.safeGetSync;
	proto.safeGetSync = function (id, options) {
		const t0 = performance.now();
		const r = original.call(this, id, options);
		nodeFetch.ms += performance.now() - t0;
		nodeFetch.calls++;
		return r;
	};
	// autoScaleEf resolves the graph size on every query; time what that costs on a real store.
	const store = T.indices.vector.customIndex.indexStore;
	if (store && typeof store.getKeysCount === 'function') {
		const originalCount = store.getKeysCount.bind(store);
		store.getKeysCount = function (...a) {
			const t0 = performance.now();
			const r = originalCount(...a);
			nodeCount.ms += performance.now() - t0;
			nodeCount.calls++;
			return r;
		};
	}
}

(async () => {
	installBaselineToggle();

	setupTestDBPath();
	setMainIsWorker(true);
	const T = table({
		table: 'HNSWRealStoreBench',
		database: 'test',
		attributes: [
			{ name: 'id', isPrimaryKey: true },
			{ name: 'vector', indexed: { type: 'HNSW', distance: 'cosine' }, type: 'Array' },
		],
	});

	if (argv.profile) instrumentNodeFetch(T);
	const pool = loadPool();
	console.log(
		`\nHNSW real-store bench — ${N} x ${DIMS}, ${Q} queries, limit=${LIMIT}, ` +
			`corpus=${CORPUS ? 'real embeddings' : 'random'}, descent=${BASELINE ? 'BASELINE (full ef)' : 'greedy'}\n`
	);

	process.stdout.write('building index...');
	const buildStart = performance.now();
	for (let i = 0; i < N; i++) {
		await T.put(i, { vector: row(pool, i) });
		if (i % 5000 === 4999) process.stdout.write(`${i + 1}...`);
	}
	const buildMs = performance.now() - buildStart;
	console.log(` ${(buildMs / 1000).toFixed(1)}s (${(buildMs / N).toFixed(2)} ms/insert)`);

	const customIndex = T.indices.vector.customIndex;
	const queries = [];
	for (let q = 0; q < Q; q++) {
		const v = row(pool, (q * 7919) % N);
		for (let d = 0; d < DIMS; d++) v[d] += (Math.random() - 0.5) * 0.02;
		queries.push(v);
	}

	for (let i = 0; i < 20; i++) {
		for await (const _ of T.search({
			sort: { attribute: 'vector', target: queries[i % Q], distance: 'cosine' },
			select: ['id'],
			limit: LIMIT,
		}));
	}

	// Interleaved A/B: each query runs under both configurations back to back, so any load spike
	// hits both arms. Medians are taken per arm over the paired samples.
	const arms = {
		baseline: { lat: [], visited: 0, fetchMs: 0, fetchCalls: 0, countMs: 0 },
		greedy: { lat: [], visited: 0, fetchMs: 0, fetchCalls: 0, countMs: 0 },
	};
	const runOne = async (target, arm) => {
		baselineOn = arm === 'baseline';
		const v0 = customIndex.nodesVisitedCount;
		const f0 = nodeFetch.ms;
		const fc0 = nodeFetch.calls;
		const c0 = nodeCount.ms;
		const t0 = performance.now();
		let n = 0;
		for await (const _ of T.search({
			sort: { attribute: 'vector', target, distance: 'cosine' },
			select: ['id'],
			limit: LIMIT,
		}))
			n++;
		const dt = performance.now() - t0;
		const a = arms[arm];
		a.lat.push(dt);
		a.visited += customIndex.nodesVisitedCount - v0;
		a.fetchMs += nodeFetch.ms - f0;
		a.fetchCalls += nodeFetch.calls - fc0;
		a.countMs += nodeCount.ms - c0;
		return n;
	};

	customIndex.nodesVisitedCount = 0;
	nodeFetch.calls = 0;
	nodeFetch.ms = 0;
	nodeCount.calls = 0;
	nodeCount.ms = 0;
	let rows = 0;
	for (let q = 0; q < Q; q++) {
		// alternate which arm goes first so ordering effects (cache warmth) cancel
		const order = q % 2 === 0 ? ['baseline', 'greedy'] : ['greedy', 'baseline'];
		for (const arm of order) rows += await runOne(queries[q], arm);
	}
	baselineOn = false;

	console.log(`  rows/query ${(rows / (2 * Q)).toFixed(1)}\n`);
	for (const [name, a] of Object.entries(arms)) {
		a.lat.sort((x, y) => x - y);
		const total = a.lat.reduce((x, y) => x + y, 0);
		console.log(
			`  ${name.padEnd(9)} p50 ${pct(a.lat, 50).toFixed(2)}ms  p95 ${pct(a.lat, 95).toFixed(2)}ms  ` +
				`visited ${(a.visited / Q).toFixed(0)}  nodeFetch ${(a.fetchMs / Q).toFixed(2)}ms (${((100 * a.fetchMs) / total).toFixed(0)}%)  ` +
				`graphSizeProbe ${(a.countMs / Q).toFixed(2)}ms (${((100 * a.countMs) / total).toFixed(0)}%)`
		);
	}
	const bp = pct(arms.baseline.lat, 50);
	const gp = pct(arms.greedy.lat, 50);
	console.log(
		`\n  p50 speedup: ${(bp / gp).toFixed(2)}x   (visits ${(arms.baseline.visited / arms.greedy.visited).toFixed(2)}x)`
	);
	const latencies = arms.greedy.lat;
	console.log(
		`REAL_STORE_AB n=${N} corpus=${CORPUS ? 'real' : 'random'} build_s=${(buildMs / 1000).toFixed(1)} ` +
			`baseline_p50=${bp.toFixed(2)} greedy_p50=${gp.toFixed(2)} speedup=${(bp / gp).toFixed(2)}\n`
	);
	process.exit(0);
})();
