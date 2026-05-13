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
