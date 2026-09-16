/**
 * SIFT1M loader and exact-kNN ground truth.
 *
 * Real descriptors rather than synthetic vectors: random high-dimensional points are very nearly
 * equidistant, so an ANN index looks either perfect or useless on them and recall stops
 * discriminating. SIFT is the canonical ANN-benchmark corpus and its `fvecs` container is a flat
 * sequence of (int32 dim, dim x float32) records, which needs no HDF5 dependency.
 */
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const DATA_DIR = process.env.VECTOR_DATA_DIR || '/home/kzyp/dev/tmp/vecdata/sift';

/** Reads an .fvecs file, optionally stopping after `limit` vectors. */
export function readFvecs(path: string, limit = Infinity): { dims: number; vectors: Float32Array[] } {
	const buf = readFileSync(path);
	const vectors: Float32Array[] = [];
	let offset = 0;
	let dims = 0;
	while (offset < buf.length && vectors.length < limit) {
		dims = buf.readInt32LE(offset);
		offset += 4;
		// Copy rather than subarray: a view would pin the whole file buffer in memory.
		const v = new Float32Array(dims);
		for (let i = 0; i < dims; i++) v[i] = buf.readFloatLE(offset + i * 4);
		offset += dims * 4;
		vectors.push(v);
	}
	return { dims, vectors };
}

function l2(a: Float32Array, b: Float32Array): number {
	let sum = 0;
	for (let i = 0; i < a.length; i++) {
		const d = a[i] - b[i];
		sum += d * d;
	}
	return sum;
}

/**
 * Exact k nearest neighbours by brute force, cached to disk.
 *
 * The ground truth shipped with SIFT is computed against the full 1M base, so any subset needs
 * its own; using the shipped file on a subset would silently score against neighbours that are
 * not in the index.
 */
export function groundTruth(base: Float32Array[], queries: Float32Array[], k: number): number[][] {
	const cache = join(DATA_DIR, `gt-${base.length}-${queries.length}-${k}.json`);
	if (existsSync(cache)) return JSON.parse(readFileSync(cache, 'utf8'));

	const started = Date.now();
	const result: number[][] = [];
	for (const q of queries) {
		// Keep only the k best seen so far; a full sort per query would dominate the runtime.
		const best: { i: number; d: number }[] = [];
		let worst = Infinity;
		for (let i = 0; i < base.length; i++) {
			const d = l2(q, base[i]);
			if (best.length < k || d < worst) {
				best.push({ i, d });
				best.sort((x, y) => x.d - y.d);
				if (best.length > k) best.pop();
				worst = best[best.length - 1].d;
			}
		}
		result.push(best.map((b) => b.i));
	}
	writeFileSync(cache, JSON.stringify(result));
	console.log(`  [ground truth] ${queries.length} queries x ${base.length} base in ${(Date.now() - started) / 1000}s`);
	return result;
}

/** Fraction of the true k neighbours that appear in the returned ids. */
export function recallAt(returned: (number | string)[], truth: number[]): number {
	if (truth.length === 0) return 1;
	const set = new Set(returned.map(Number));
	let hits = 0;
	for (const t of truth) if (set.has(t)) hits++;
	return hits / truth.length;
}
