'use strict';
/**
 * HNSW searchLayer performance benchmark — measures search latency, throughput,
 * nodes visited per query, and recall@K against brute-force ground truth.
 *
 * Run (from core/ directory, after npm run build):
 *   node benchmarks/hnsw-search.js [N_VECTORS] [DIMS] [N_QUERIES]
 *
 * Examples:
 *   node benchmarks/hnsw-search.js            # defaults: 2000 x 384 x 50
 *   node benchmarks/hnsw-search.js 5000 768   # realistic embedding workload
 */

const { performance } = require('node:perf_hooks');
const { HierarchicalNavigableSmallWorld } = require('#src/resources/indexes/HierarchicalNavigableSmallWorld');
const { cosineDistance } = require('#src/resources/indexes/vector');

const N_VECTORS = parseInt(process.argv[2]) || 2_000;
const DIMS = parseInt(process.argv[3]) || 384;
const N_QUERIES = parseInt(process.argv[4]) || 50;
const TOP_K = 10;

// ---------------------------------------------------------------------------
// Minimal in-memory store — enough interface for HierarchicalNavigableSmallWorld
// ---------------------------------------------------------------------------

class MemoryStore {
	constructor() {
		this._map = new Map();
		this.encoder = { useFloat32: null };
	}
	_key(k) {
		if (Array.isArray(k)) {
			return k.map((v) => (typeof v === 'symbol' ? (Symbol.keyFor(v) ?? String(v)) : v)).join('\x00');
		}
		return k;
	}
	getSync(key) {
		return this._map.get(this._key(key));
	}
	put(key, value) {
		this._map.set(this._key(key), value);
	}
	remove(key) {
		this._map.delete(this._key(key));
	}
	*getKeys({ reverse = false, limit = Infinity, start = -Infinity, end = Infinity } = {}) {
		const keys = [];
		for (const k of this._map.keys()) {
			if (typeof k === 'number' && k >= start && k <= end) keys.push(k);
		}
		keys.sort((a, b) => (reverse ? b - a : a - b));
		let n = 0;
		for (const k of keys) {
			if (n++ >= limit) break;
			yield k;
		}
	}
	*getRange({ start = -Infinity, end = Infinity } = {}) {
		for (const [k, v] of this._map) {
			if (typeof k === 'number' && k >= start && k <= end) yield { key: k, value: v };
		}
	}
	getUserSharedBuffer(_name, buf) {
		return buf;
	}
	getStats() {
		let n = 0;
		for (const k of this._map.keys()) if (typeof k === 'number') n++;
		return { entryCount: n };
	}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function randomVector(dims) {
	const v = new Array(dims);
	for (let i = 0; i < dims; i++) v[i] = Math.random() * 2 - 1;
	return v;
}

function fmtNs(ns) {
	if (ns < 1_000) return `${ns.toFixed(1)} ns`;
	if (ns < 1_000_000) return `${(ns / 1_000).toFixed(2)} µs`;
	return `${(ns / 1_000_000).toFixed(2)} ms`;
}

// ---------------------------------------------------------------------------
// Build index
// ---------------------------------------------------------------------------

console.log(`\nHNSW benchmark — ${N_VECTORS.toLocaleString()} vectors × ${DIMS} dims, ${N_QUERIES} queries\n`);

const vectors = Array.from({ length: N_VECTORS }, () => randomVector(DIMS));
const store = new MemoryStore();
const hnsw = new HierarchicalNavigableSmallWorld(store, { distance: 'cosine' });

process.stdout.write('Building index...');
const buildStart = performance.now();
for (let i = 0; i < N_VECTORS; i++) {
	hnsw.index('r' + i, vectors[i], undefined, {});
}
const buildMs = performance.now() - buildStart;
console.log(` done in ${buildMs.toFixed(0)} ms  (${(buildMs / N_VECTORS).toFixed(2)} ms/insert)\n`);

// ---------------------------------------------------------------------------
// Brute-force ground truth for recall@K
// ---------------------------------------------------------------------------

const queries = Array.from({ length: N_QUERIES }, () => randomVector(DIMS));

process.stdout.write('Computing brute-force ground truth...');
const gtStart = performance.now();
const groundTruth = queries.map((query) => {
	const scored = vectors.map((v, i) => ({ i, d: cosineDistance(query, v) }));
	scored.sort((a, b) => a.d - b.d);
	return new Set(scored.slice(0, TOP_K).map((x) => x.i));
});
console.log(` done in ${(performance.now() - gtStart).toFixed(0)} ms\n`);

// ---------------------------------------------------------------------------
// Search benchmark
// ---------------------------------------------------------------------------

// Warmup
for (let i = 0; i < 10; i++) {
	hnsw.search({ target: queries[i % N_QUERIES], comparator: 'sort', descending: false }, {});
}
hnsw.nodesVisitedCount = 0;

const searchStart = performance.now();
const allResults = queries.map((query) => hnsw.search({ target: query, comparator: 'sort', descending: false }, {}));
const searchMs = performance.now() - searchStart;

// ---------------------------------------------------------------------------
// Recall@K
// ---------------------------------------------------------------------------

let recallSum = 0;
for (let i = 0; i < N_QUERIES; i++) {
	const resultIndices = new Set(allResults[i].slice(0, TOP_K).map((r) => parseInt(r.key.slice(1))));
	let hits = 0;
	for (const idx of groundTruth[i]) if (resultIndices.has(idx)) hits++;
	recallSum += hits / TOP_K;
}
const recall = recallSum / N_QUERIES;

const avgNs = (searchMs * 1_000_000) / N_QUERIES;
const qps = (N_QUERIES / searchMs) * 1_000;

console.log('Search results:');
console.log(`  Latency:            ${fmtNs(avgNs)}/query avg`);
console.log(`  Throughput:         ${qps.toFixed(0)} qps`);
console.log(`  Nodes visited/query: ${(hnsw.nodesVisitedCount / N_QUERIES).toFixed(1)}`);
console.log(`  Recall@${TOP_K}:          ${(recall * 100).toFixed(1)}%\n`);

// ---------------------------------------------------------------------------
// Filtered-recall scenario (#1241): recall@K vs. selectivity for three strategies —
//   post-filter    : plain search, then drop non-matching from the fixed top-ef set (today's behavior)
//   predicate      : predicate-aware traversal (filter passed into search, ACORN-style)
//   brute-force    : exact distance over the matching set only (the selective-filter fallback)
// Predicate traversal should dominate post-filter on recall at low selectivity without pathological
// latency; brute-force is the crossover once the matching set is tiny.
// ---------------------------------------------------------------------------

const idxOf = (key) => parseInt(key.slice(1));
const SELECTIVITIES = [0.5, 0.1, 0.01, 0.001];

console.log(`Filtered recall@${TOP_K} vs. selectivity (${N_QUERIES} queries):\n`);
console.log('  selectivity   matches   post-filter   predicate   brute-force   pred.lat    bf.lat');
console.log('  ' + '-'.repeat(88));

for (const p of SELECTIVITIES) {
	// Deterministic-ish membership: mark a p-fraction of vectors as matching the companion predicate.
	const matches = new Array(N_VECTORS);
	let matchCount = 0;
	for (let i = 0; i < N_VECTORS; i++) {
		matches[i] = Math.random() < p;
		if (matches[i]) matchCount++;
	}
	if (matchCount === 0) {
		console.log(
			`  ${(p * 100).toFixed(1).padStart(9)}%   ${String(matchCount).padStart(7)}   (no matching vectors — skipped)`
		);
		continue;
	}
	const filter = (key) => matches[idxOf(key)];
	const k = Math.min(TOP_K, matchCount);

	// Ground truth: the k nearest among the matching vectors only.
	const filteredGT = queries.map((query) => {
		const scored = [];
		for (let i = 0; i < N_VECTORS; i++) if (matches[i]) scored.push({ i, d: cosineDistance(query, vectors[i]) });
		scored.sort((a, b) => a.d - b.d);
		return new Set(scored.slice(0, k).map((x) => x.i));
	});

	let postRecall = 0;
	let predRecall = 0;
	let bfRecall = 0;
	let predNs = 0;
	let bfNs = 0;

	for (let q = 0; q < N_QUERIES; q++) {
		const query = queries[q];
		const gt = filteredGT[q];

		// post-filter: unfiltered search, then keep matching, take k
		const plain = hnsw.search({ target: query, comparator: 'sort', descending: false }, {});
		const postIdx = new Set(
			plain
				.filter((r) => matches[idxOf(r.key)])
				.slice(0, k)
				.map((r) => idxOf(r.key))
		);
		postRecall += overlap(gt, postIdx) / k;

		// predicate-aware traversal
		const t0 = performance.now();
		const pred = hnsw.search({ target: query, comparator: 'sort', descending: false }, {}, filter);
		predNs += (performance.now() - t0) * 1e6;
		const predIdx = new Set(pred.slice(0, k).map((r) => idxOf(r.key)));
		predRecall += overlap(gt, predIdx) / k;

		// brute-force over the matching set
		const b0 = performance.now();
		const scored = [];
		for (let i = 0; i < N_VECTORS; i++) if (matches[i]) scored.push({ i, d: cosineDistance(query, vectors[i]) });
		scored.sort((a, b) => a.d - b.d);
		bfNs += (performance.now() - b0) * 1e6;
		const bfIdx = new Set(scored.slice(0, k).map((x) => x.i));
		bfRecall += overlap(gt, bfIdx) / k;
	}

	const pct = (x) => `${((x / N_QUERIES) * 100).toFixed(1)}%`.padStart(9);
	console.log(
		`  ${(p * 100).toFixed(1).padStart(9)}%   ${String(matchCount).padStart(7)}   ` +
			`${pct(postRecall).padStart(11)}   ${pct(predRecall).padStart(9)}   ${pct(bfRecall).padStart(11)}   ` +
			`${fmtNs(predNs / N_QUERIES).padStart(8)}   ${fmtNs(bfNs / N_QUERIES).padStart(8)}`
	);
}
console.log('');

function overlap(a, b) {
	let n = 0;
	for (const x of a) if (b.has(x)) n++;
	return n;
}
