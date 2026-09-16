/**
 * Concurrent k-NN query driver. Returns per-query neighbour ids so recall can be scored, plus
 * wall-clock throughput and a latency distribution.
 */
export interface QueryResult {
	throughput: number;
	ids: (number | string)[][];
	latencies: number[];
	errors: number;
}

export async function runQueries(
	send: (vector: Float32Array, k: number) => Promise<(number | string)[]>,
	queries: Float32Array[],
	k: number,
	concurrency: number,
	repeats: number
): Promise<QueryResult> {
	const total = queries.length * repeats;
	const ids: (number | string)[][] = new Array(queries.length);
	const latencies: number[] = [];
	let issued = 0;
	let errors = 0;

	const started = performance.now();
	await Promise.all(
		Array.from({ length: concurrency }, async () => {
			while (true) {
				const n = issued++;
				if (n >= total) return;
				const qi = n % queries.length;
				const t0 = performance.now();
				try {
					const got = await send(queries[qi], k);
					latencies.push(performance.now() - t0);
					// Only the first pass over the query set is scored; later repeats are identical.
					if (n < queries.length) ids[qi] = got;
				} catch {
					errors++;
					if (n < queries.length) ids[qi] = [];
				}
			}
		})
	);
	const elapsed = (performance.now() - started) / 1000;
	return { throughput: total / elapsed, ids, latencies, errors };
}

export function percentile(latencies: number[], p: number): number {
	if (latencies.length === 0) return 0;
	const sorted = [...latencies].sort((a, b) => a - b);
	return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}
