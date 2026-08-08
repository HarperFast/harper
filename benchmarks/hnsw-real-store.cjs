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

// Reproduce the pre-fix descent for A/B: every layer searched at the full ef.
function applyBaseline() {
	const proto = HierarchicalNavigableSmallWorld.prototype;
	const originalSearch = proto.search;
	const originalSearchLayer = proto.searchLayer;
	let efForQuery = 0;
	proto.search = function (condition, context, filter, minResults) {
		const count = this.indexStore.getKeysCount
			? this.indexStore.getKeysCount()
			: (this.indexStore.getStats?.()?.entryCount ?? 0);
		efForQuery = Math.min(512, Math.max(100, Math.round(100 * Math.sqrt(Math.max(1, count / 1000)))));
		return originalSearch.call(this, condition, context, filter, minResults);
	};
	proto.searchLayer = function (v, epId, ep, ef, level, ...rest) {
		return originalSearchLayer.call(this, v, epId, ep, level > 0 ? efForQuery : ef, level, ...rest);
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
	if (BASELINE) applyBaseline();

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

	customIndex.nodesVisitedCount = 0;
	nodeFetch.calls = 0;
	nodeFetch.ms = 0;
	nodeCount.calls = 0;
	nodeCount.ms = 0;
	const latencies = [];
	let rows = 0;
	for (let q = 0; q < Q; q++) {
		const t0 = performance.now();
		let n = 0;
		for await (const _ of T.search({
			sort: { attribute: 'vector', target: queries[q], distance: 'cosine' },
			select: ['id'],
			limit: LIMIT,
		}))
			n++;
		latencies.push(performance.now() - t0);
		rows += n;
	}
	latencies.sort((a, b) => a - b);
	console.log(
		`  p50 ${pct(latencies, 50).toFixed(2)}ms  p95 ${pct(latencies, 95).toFixed(2)}ms  p99 ${pct(latencies, 99).toFixed(2)}ms  ` +
			`nodes/query ${(customIndex.nodesVisitedCount / Q).toFixed(0)}  rows/query ${(rows / Q).toFixed(1)}  ` +
			`µs/vector ${((pct(latencies, 50) * 1000) / N).toFixed(2)}`
	);
	if (argv.profile) {
		const totalMs = latencies.reduce((a, b) => a + b, 0);
		console.log(
			`  node fetch: ${(nodeFetch.calls / Q).toFixed(0)} calls/query, ${(nodeFetch.ms / Q).toFixed(2)} ms/query ` +
				`(${((100 * nodeFetch.ms) / totalMs).toFixed(1)}% of query time, ${((nodeFetch.ms * 1000) / nodeFetch.calls).toFixed(2)} µs/call)`
		);
		console.log(
			`  graph-size probe (autoScaleEf): ${(nodeCount.calls / Q).toFixed(2)} calls/query, ${(nodeCount.ms / Q).toFixed(2)} ms/query ` +
				`(${((100 * nodeCount.ms) / totalMs).toFixed(1)}% of query time)`
		);
	}
	console.log(
		`REAL_STORE_RESULT n=${N} descent=${BASELINE ? 'baseline' : 'greedy'} corpus=${CORPUS ? 'real' : 'random'} ` +
			`build_s=${(buildMs / 1000).toFixed(1)} p50=${pct(latencies, 50).toFixed(2)} p95=${pct(latencies, 95).toFixed(2)} ` +
			`visited=${(customIndex.nodesVisitedCount / Q).toFixed(0)}\n`
	);
	process.exit(0);
})();
