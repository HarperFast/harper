/**
 * Converts a YCSB results JSON (from run-single-node.mts) into the
 * github-action-benchmark "custom" format used by the nightly workflow to track
 * trends and alert on regressions. Emits two files because the metrics have
 * opposite "better" directions:
 *   throughput.json — ops/sec, bigger is better  (tool: customBiggerIsBetter)
 *   latency.json    — p99 ms,  smaller is better (tool: customSmallerIsBetter)
 *
 *   node benchmarks/ycsb/to-benchmark-json.mts <results.json> <out-dir>
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

interface BenchPoint {
	name: string;
	unit: string;
	value: number;
}

interface LatencyStats {
	p50: number;
	p99: number;
}

interface Results {
	load: { throughput: number };
	workloads: { name: string; throughput: number; latency: Record<string, LatencyStats> }[];
}

function round(n: number): number {
	return Math.round(n * 100) / 100;
}

async function main(): Promise<void> {
	const [resultsPath, outDir] = process.argv.slice(2);
	if (!resultsPath || !outDir) throw new Error('usage: to-benchmark-json.mts <results.json> <out-dir>');

	const results = JSON.parse(await readFile(resultsPath, 'utf8')) as Results;

	const throughput: BenchPoint[] = [{ name: 'load', unit: 'records/sec', value: round(results.load.throughput) }];
	const latency: BenchPoint[] = [];
	for (const wl of results.workloads) {
		throughput.push({ name: `workload ${wl.name}`, unit: 'ops/sec', value: round(wl.throughput) });
		for (const [op, stats] of Object.entries(wl.latency)) {
			latency.push({ name: `${wl.name} ${op} p99`, unit: 'ms', value: round(stats.p99) });
		}
	}

	await mkdir(outDir, { recursive: true });
	await writeFile(join(outDir, 'throughput.json'), JSON.stringify(throughput, null, 2));
	await writeFile(join(outDir, 'latency.json'), JSON.stringify(latency, null, 2));
	console.log(`wrote ${throughput.length} throughput + ${latency.length} latency metrics to ${outDir}`);
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
