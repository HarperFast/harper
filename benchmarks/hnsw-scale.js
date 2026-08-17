'use strict';
/**
 * HNSW scaling benchmark — how search cost and recall move as the corpus grows.
 *
 * Unlike benchmarks/hnsw-search.js (uniform random vectors, single N), this drives a
 * Gaussian-mixture corpus (clustered, like real embeddings) across a sweep of corpus
 * sizes and reports the per-layer work breakdown, so the scaling exponent and the
 * layer that produces it are both visible.
 *
 * Run (after npm run build):
 *   node benchmarks/hnsw-scale.js [--n=5000,10000,25000] [--dims=768] [--queries=50]
 *                                 [--clusters=N] [--ef=auto] [--quantization=int8|none]
 *                                 [--upper-ef=N]   (override ef used above layer 0)
 *                                 [--json=path]
 */

const { performance } = require('node:perf_hooks');
const path = require('node:path');
const fs = require('node:fs');

const DIST = path.resolve(__dirname, '../dist/resources/indexes');
const { HierarchicalNavigableSmallWorld } = require(`${DIST}/HierarchicalNavigableSmallWorld.js`);

const argv = Object.fromEntries(
	process.argv.slice(2).map((a) => {
		const [k, v] = a.replace(/^--/, '').split('=');
		return [k, v ?? true];
	})
);
const SIZES = String(argv.n ?? '5000,10000,25000')
	.split(',')
	.map(Number);
const DIMS = Number(argv.dims ?? 768);
const N_QUERIES = Number(argv.queries ?? 50);
const TOP_K = Number(argv.k ?? 10);
const QUANTIZATION = argv.quantization ?? 'int8';
const EF_OPT = argv.ef ?? 'auto';
const EF_SWEEP = String(argv['ef-sweep'] ?? 'auto').split(',');
const OPTIMIZE_ROUTING = argv['optimize-routing'] === undefined ? undefined : Number(argv['optimize-routing']);
const M_OPT = argv.M === undefined ? undefined : Number(argv.M);
const EF_CONSTRUCTION = argv['ef-construction'] === undefined ? undefined : Number(argv['ef-construction']);
// --build-upper-ef=<n> restores the pre-change INDEX-time descent (full efConstruction above the
// target level) so a graph built the old way can be compared against a greedy-built one. That change
// is baked into stored graphs and only recoverable by a reindex, so it needs its own A/B.
const BUILD_UPPER_EF = argv['build-upper-ef'] === undefined ? undefined : Number(argv['build-upper-ef']);
const UPPER_EF =
	argv['upper-ef'] === undefined ? undefined : argv['upper-ef'] === 'match' ? 'match' : Number(argv['upper-ef']);
// Intra-cluster cosine similarity target. Per-dim gaussian noise sigma is derived from it:
// a unit centroid perturbed by N(0,s) per dim has expected cosine 1/sqrt(1+dims*s^2) with the
// centroid, so s = sqrt((1/cos^2 - 1)/dims). Real sentence embeddings sit around 0.6-0.85
// within a topic; specifying sigma directly (the old --noise flag) silently produced a
// uniform-random corpus at 768 dims, which no ANN can index.
// --corpus=<prefix>.f32 loads a REAL embedding pool (row-major float32) instead of generating one.
// Synthetic gaussian mixtures are far easier than real transformer embeddings (which are anisotropic:
// median pairwise distance is ~0.37, not ~0.95), so any ef/recall conclusion has to be confirmed on
// real vectors before it is trusted.
const CORPUS = argv.corpus ? String(argv.corpus) : undefined;
const INTRA_COS = Number(argv['intra-cos'] ?? 0.75);
const NOISE = argv.noise !== undefined ? Number(argv.noise) : Math.sqrt((1 / (INTRA_COS * INTRA_COS) - 1) / DIMS);

// Deterministic RNG so A/B runs (different ef, quantization, routing) see the SAME corpus and the
// same HNSW level assignments — Math.random is overridden globally because the index draws node
// levels from it too.
const SEED = Number(argv.seed ?? 1);
function mulberry32(a) {
	return function () {
		a |= 0;
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}
Math.random = mulberry32(SEED);

class MemoryStore {
	constructor() {
		this._map = new Map();
		this.encoder = { useFloat32: null };
		this._numericCount = 0;
	}
	_key(k) {
		if (Array.isArray(k))
			return k.map((v) => (typeof v === 'symbol' ? (Symbol.keyFor(v) ?? String(v)) : v)).join('\x00');
		return k;
	}
	getSync(key) {
		return this._map.get(this._key(key));
	}
	put(key, value) {
		const k = this._key(key);
		if (typeof k === 'number' && !this._map.has(k)) this._numericCount++;
		this._map.set(k, value);
	}
	remove(key) {
		const k = this._key(key);
		if (typeof k === 'number' && this._map.has(k)) this._numericCount--;
		this._map.delete(k);
	}
	*getKeys({ reverse = false, limit = Infinity, start = -Infinity, end = Infinity } = {}) {
		// A reverse scan passes the high bound as `start` and the low one as `end`, so normalize before
		// filtering — otherwise resolveNodeCount's `{start: Infinity, end: 0}` seek matches nothing and
		// the fallback node count silently reads 0.
		const low = Math.min(start, end);
		const high = Math.max(start, end);
		const keys = [];
		for (const k of this._map.keys()) if (typeof k === 'number' && k >= low && k <= high) keys.push(k);
		keys.sort((a, b) => (reverse ? b - a : a - b));
		let n = 0;
		for (const k of keys) {
			if (n++ >= limit) break;
			yield k;
		}
	}
	*getRange({ start = -Infinity, end = Infinity } = {}) {
		for (const [k, v] of this._map) if (typeof k === 'number' && k >= start && k <= end) yield { key: k, value: v };
	}
	getUserSharedBuffer(_name, buf) {
		return buf;
	}
	getStats() {
		return { entryCount: this._numericCount };
	}
}

let _spare = null;
function gauss() {
	if (_spare !== null) {
		const s = _spare;
		_spare = null;
		return s;
	}
	let u, v, s;
	do {
		u = Math.random() * 2 - 1;
		v = Math.random() * 2 - 1;
		s = u * u + v * v;
	} while (s === 0 || s >= 1);
	const mul = Math.sqrt((-2 * Math.log(s)) / s);
	_spare = v * mul;
	return u * mul;
}

/** Corpus stored in one Float32Array pool; row i at [i*DIMS, (i+1)*DIMS). Unit-normalized. */
function buildCorpus(n, dims, nClusters) {
	const centroids = new Float32Array(nClusters * dims);
	for (let c = 0; c < nClusters; c++) {
		let mag = 0;
		for (let d = 0; d < dims; d++) {
			const x = gauss();
			centroids[c * dims + d] = x;
			mag += x * x;
		}
		mag = Math.sqrt(mag) || 1;
		for (let d = 0; d < dims; d++) centroids[c * dims + d] /= mag;
	}
	const pool = new Float32Array(n * dims);
	const labels = new Int32Array(n);
	for (let i = 0; i < n; i++) {
		const c = (Math.random() * nClusters) | 0;
		labels[i] = c;
		let mag = 0;
		for (let d = 0; d < dims; d++) {
			const x = centroids[c * dims + d] + gauss() * NOISE;
			pool[i * dims + d] = x;
			mag += x * x;
		}
		mag = Math.sqrt(mag) || 1;
		for (let d = 0; d < dims; d++) pool[i * dims + d] /= mag;
	}
	return { pool, labels, centroids };
}

/**
 * Load `n` rows of a real float32 embedding pool, unit-normalized, holding out `nQueries` rows to
 * use as queries. The held-out rows are spread evenly through the file rather than taken from the
 * tail, because a corpus built by walking directories is ordered by file and the tail would be one
 * unrepresentative neighbourhood. Held-out rows are genuine out-of-sample queries — jittering an
 * indexed row instead makes rank 1 trivially recoverable and overstates recall.
 */
function loadCorpus(file, n, dims, nQueries) {
	const buf = fs.readFileSync(file);
	const raw = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
	const available = Math.floor(raw.length / dims);
	const needed = n + nQueries;
	if (available < needed) throw new Error(`corpus ${file} has ${available} rows of ${dims} dims, need ${needed}`);
	const holdout = new Set();
	for (let q = 0; q < nQueries; q++) holdout.add(Math.floor((q * needed) / nQueries));
	const normalize = (src, dst, dstRow) => {
		let mag = 0;
		for (let d = 0; d < dims; d++) mag += raw[src + d] * raw[src + d];
		mag = Math.sqrt(mag) || 1;
		for (let d = 0; d < dims; d++) dst[dstRow * dims + d] = raw[src + d] / mag;
	};
	const pool = new Float32Array(n * dims);
	const queryPool = new Float32Array(nQueries * dims);
	let indexed = 0;
	let held = 0;
	for (let i = 0; i < needed && indexed < n; i++) {
		if (holdout.has(i) && held < nQueries) normalize(i * dims, queryPool, held++);
		else normalize(i * dims, pool, indexed++);
	}
	return { pool, queryPool, labels: null, centroids: null };
}

function rowToArray(pool, i, dims) {
	const out = new Array(dims);
	const base = i * dims;
	for (let d = 0; d < dims; d++) out[d] = pool[base + d];
	return out;
}

/** Ground truth over unit-normalized rows: cosine distance = 1 - dot. */
function bruteForceTopK(pool, n, dims, query, k) {
	const dist = new Float64Array(n);
	for (let i = 0; i < n; i++) {
		let dot = 0;
		const base = i * dims;
		for (let d = 0; d < dims; d++) dot += pool[base + d] * query[d];
		dist[i] = 1 - dot;
	}
	const idx = Array.from({ length: n }, (_, i) => i);
	idx.sort((a, b) => dist[a] - dist[b]);
	return new Set(idx.slice(0, k));
}

function pct(sorted, p) {
	if (!sorted.length) return 0;
	return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

let inSearch = false;
let currentEf = 0;
const layerStats = { visitsByLevel: new Map(), timeByLevel: new Map(), callsByLevel: new Map() };
function resetLayerStats() {
	layerStats.visitsByLevel.clear();
	layerStats.timeByLevel.clear();
	layerStats.callsByLevel.clear();
}
function instrument(hnsw) {
	const proto = Object.getPrototypeOf(hnsw);
	if (proto.__instrumented) return;
	proto.__instrumented = true;
	const original = proto.searchLayer;
	const originalSearch = proto.search;
	// --upper-ef must only change the SEARCH-time descent, not index construction (which legitimately
	// needs efConstruction at every level to build good upper-layer connections).
	proto.search = function (...a) {
		inSearch = true;
		try {
			return originalSearch.apply(this, a);
		} finally {
			inSearch = false;
		}
	};
	proto.searchLayer = function (queryVector, entryPointId, entryPoint, ef, level, ...rest) {
		// --upper-ef=match reproduces the pre-fix behaviour (full ef at every layer) for A/B.
		// Layer 0 is searched last, so `currentEf` holds the ef the index resolved on the previous
		// query — the same value, and read from the index rather than recomputed here, so this cannot
		// drift when the auto-scale formula changes.
		if (inSearch && level === 0) currentEf = ef;
		if (inSearch && UPPER_EF !== undefined && level > 0 && currentEf) ef = UPPER_EF === 'match' ? currentEf : UPPER_EF;
		else if (inSearch && UPPER_EF !== undefined && UPPER_EF !== 'match' && level > 0) ef = UPPER_EF;
		else if (!inSearch && BUILD_UPPER_EF !== undefined && level > 0) ef = BUILD_UPPER_EF;
		const before = this.nodesVisitedCount;
		const t0 = performance.now();
		const results = original.call(this, queryVector, entryPointId, entryPoint, ef, level, ...rest);
		const dt = performance.now() - t0;
		const visited = this.nodesVisitedCount - before;
		layerStats.visitsByLevel.set(level, (layerStats.visitsByLevel.get(level) ?? 0) + visited);
		layerStats.timeByLevel.set(level, (layerStats.timeByLevel.get(level) ?? 0) + dt);
		layerStats.callsByLevel.set(level, (layerStats.callsByLevel.get(level) ?? 0) + 1);
		return results;
	};
}

function graphShape(store) {
	const levels = new Map();
	let deg0 = 0;
	let deg0Nodes = 0;
	for (const [k, v] of store._map) {
		if (typeof k !== 'number' || !v || v.level === undefined) continue;
		levels.set(v.level, (levels.get(v.level) ?? 0) + 1);
		if (v[0]) {
			deg0 += v[0].length;
			deg0Nodes++;
		}
	}
	return { levels: [...levels.entries()].sort((a, b) => a[0] - b[0]), avgDegree0: deg0 / (deg0Nodes || 1) };
}

const rows = [];
console.log(
	`\nHNSW scaling sweep — dims=${DIMS}, queries=${N_QUERIES}, k=${TOP_K}, quantization=${QUANTIZATION}, ef=${EF_OPT}` +
		(UPPER_EF !== undefined ? `, upper-ef=${UPPER_EF}` : '') +
		(BUILD_UPPER_EF !== undefined ? `, build-upper-ef=${BUILD_UPPER_EF}` : '') +
		`, intraCos=${INTRA_COS}, sigma=${NOISE.toFixed(4)}\n`
);

for (const N of SIZES) {
	const nClusters = Number(argv.clusters ?? Math.max(8, Math.round(N / 500)));
	global.gc?.();
	Math.random = mulberry32(SEED); // identical corpus + level assignments for every configuration
	_spare = null;
	const { pool, queryPool } = CORPUS ? loadCorpus(CORPUS, N, DIMS, N_QUERIES) : buildCorpus(N, DIMS, nClusters);

	const store = new MemoryStore();
	const options = { distance: 'cosine', quantization: QUANTIZATION };
	if (EF_OPT !== 'auto') options.efConstructionSearch = Number(EF_OPT);
	if (OPTIMIZE_ROUTING !== undefined) options.optimizeRouting = OPTIMIZE_ROUTING;
	if (M_OPT !== undefined) options.M = M_OPT;
	if (EF_CONSTRUCTION !== undefined) options.efConstruction = EF_CONSTRUCTION;
	const hnsw = new HierarchicalNavigableSmallWorld(store, options);
	instrument(hnsw);

	const buildStart = performance.now();
	for (let i = 0; i < N; i++) hnsw.index('r' + i, rowToArray(pool, i, DIMS), undefined, {});
	const buildMs = performance.now() - buildStart;

	const shape = graphShape(store);

	// queries drawn from the same distribution (perturbed corpus rows)
	const queries = [];
	for (let q = 0; q < N_QUERIES; q++) {
		if (queryPool) {
			// real corpus: a held-out embedding, never indexed
			queries.push(rowToArray(queryPool, q, DIMS));
			continue;
		}
		// synthetic: perturb an indexed row so rank 1 is not trivially the query itself
		const src = (Math.random() * N) | 0;
		const v = rowToArray(pool, src, DIMS);
		let mag = 0;
		for (let d = 0; d < DIMS; d++) {
			v[d] += gauss() * NOISE * 0.5;
			mag += v[d] * v[d];
		}
		mag = Math.sqrt(mag) || 1;
		for (let d = 0; d < DIMS; d++) v[d] /= mag;
		queries.push(v);
	}

	// corpus diagnostic: how separated is the true nearest neighbour from a random row?
	// (if these are close, the corpus is effectively uniform and no ANN can help)
	let sepNear = 0;
	let sepRand = 0;
	{
		const probes = 20;
		for (let p = 0; p < probes; p++) {
			const q = queries[p % queries.length];
			let best = Infinity;
			for (let i = 0; i < Math.min(N, 3000); i++) {
				let dot = 0;
				const base = i * DIMS;
				for (let d = 0; d < DIMS; d++) dot += pool[base + d] * q[d];
				const dist = 1 - dot;
				if (dist < best) best = dist;
				if (i < 200) sepRand += dist;
			}
			sepNear += best;
		}
		sepNear /= probes;
		sepRand /= probes * 200;
	}

	const gtStart = performance.now();
	const groundTruth = queries.map((q) => bruteForceTopK(pool, N, DIMS, q, TOP_K));
	const gtMs = performance.now() - gtStart;

	for (const efSpec of EF_SWEEP) {
		const queryEf = efSpec === 'auto' ? undefined : Number(efSpec);
		currentEf = queryEf ?? 0; // resolved from the index itself on the warm-up queries below

		// warm-up
		for (let q = 0; q < Math.min(5, N_QUERIES); q++)
			hnsw.search({ target: queries[q], comparator: 'sort', ef: queryEf }, { transaction: undefined });

		const effectiveEf = currentEf; // what the index actually searched layer 0 at
		resetLayerStats();
		const latencies = [];
		let totalVisited = 0;
		let hits = 0; // recall of the raw (quantized-order) top-K
		let setHits = 0; // recall of the full candidate set — what production sees after exact rescoring
		let returned = 0;
		for (let q = 0; q < N_QUERIES; q++) {
			hnsw.nodesVisitedCount = 0;
			const t0 = performance.now();
			const results = hnsw.search({ target: queries[q], comparator: 'sort', ef: queryEf }, { transaction: undefined });
			latencies.push(performance.now() - t0);
			totalVisited += hnsw.nodesVisitedCount;
			returned += results.length;
			const gt = groundTruth[q];
			for (const r of results.slice(0, TOP_K)) if (gt.has(Number(String(r.key).slice(1)))) hits++;
			for (const r of results) if (gt.has(Number(String(r.key).slice(1)))) setHits++;
		}

		latencies.sort((a, b) => a - b);
		const upperVisits = [...layerStats.visitsByLevel.entries()].filter(([l]) => l > 0).reduce((s, [, v]) => s + v, 0);
		const upperTime = [...layerStats.timeByLevel.entries()].filter(([l]) => l > 0).reduce((s, [, v]) => s + v, 0);
		const l0Visits = layerStats.visitsByLevel.get(0) ?? 0;
		const l0Time = layerStats.timeByLevel.get(0) ?? 0;

		const row = {
			N,
			clusters: nClusters,
			buildMs: Math.round(buildMs),
			msPerInsert: +(buildMs / N).toFixed(2),
			efSpec: String(efSpec),
			ef: effectiveEf,
			p50: +pct(latencies, 50).toFixed(2),
			p95: +pct(latencies, 95).toFixed(2),
			p99: +pct(latencies, 99).toFixed(2),
			usPerVector: +((pct(latencies, 50) * 1000) / N).toFixed(2),
			visited: Math.round(totalVisited / N_QUERIES),
			visitedPctOfGraph: +((100 * (totalVisited / N_QUERIES)) / N).toFixed(1),
			l0Visited: Math.round(l0Visits / N_QUERIES),
			upperVisited: Math.round(upperVisits / N_QUERIES),
			upperTimePct: +((100 * upperTime) / (upperTime + l0Time)).toFixed(1),
			recall: +(hits / (N_QUERIES * TOP_K)).toFixed(3),
			recallSet: +(setHits / (N_QUERIES * TOP_K)).toFixed(3),
			returned: Math.round(returned / N_QUERIES),
			levels: shape.levels.map(([l, c]) => `${l}:${c}`).join(' '),
			avgDegree0: +shape.avgDegree0.toFixed(1),
			gtMs: Math.round(gtMs),
			dNear: +sepNear.toFixed(3),
			dRand: +sepRand.toFixed(3),
		};
		rows.push(row);
		console.log(
			`N=${String(N).padStart(7)}  build ${String(row.buildMs).padStart(7)}ms (${row.msPerInsert} ms/ins)  ` +
				`ef=${String(row.ef).padStart(4)}${efSpec === 'auto' ? '*' : ' '}  p50 ${String(row.p50).padStart(8)}ms  p95 ${String(row.p95).padStart(8)}ms  ` +
				`µs/vec ${String(row.usPerVector).padStart(6)}  visited ${String(row.visited).padStart(7)} (${String(row.visitedPctOfGraph).padStart(5)}% of graph; L0 ${row.l0Visited}, upper ${row.upperVisited}, upper ${row.upperTimePct}% of time)  ` +
				`d(nn)/d(rand) ${row.dNear}/${row.dRand}  recall@${TOP_K} raw ${row.recall} set ${row.recallSet}  returned ${row.returned}  deg0 ${row.avgDegree0}  levels ${row.levels}`
		);
	}
}

// scaling exponent between consecutive points
console.log('');
for (let i = 1; i < rows.length; i++) {
	const a = rows[i - 1];
	const b = rows[i];
	const exp = Math.log(b.p50 / a.p50) / Math.log(b.N / a.N);
	const visitExp = Math.log(b.visited / a.visited) / Math.log(b.N / a.N);
	console.log(
		`  ${a.N} → ${b.N}: latency ∝ n^${exp.toFixed(2)}, visits ∝ n^${visitExp.toFixed(2)} ` +
			`(recall ${a.recall} → ${b.recall})`
	);
}

if (argv.json) {
	fs.writeFileSync(
		argv.json,
		JSON.stringify(
			{ dims: DIMS, queries: N_QUERIES, k: TOP_K, quantization: QUANTIZATION, ef: EF_OPT, upperEf: UPPER_EF, rows },
			null,
			2
		)
	);
	console.log(`\nwrote ${argv.json}`);
}
console.log('');
