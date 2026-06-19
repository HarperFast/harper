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
import { WORKLOADS } from './workload.mts';

interface BenchPoint {
	name: string;
	unit: string;
	value: number;
}

interface LatencyStats {
	p50: number;
	p99: number;
}

export interface Results {
	load?: { throughput: number };
	workloads: { name: string; description?: string; throughput: number; latency: Record<string, LatencyStats> }[];
}

function round(n: number): number {
	return Math.round(n * 100) / 100;
}

// Brief description of the load phase (no WorkloadSpec exists for it).
const LOAD_DESCRIPTION = 'bulk insert';

/**
 * Full description for a workload, sourced from the results, falling back to the WorkloadSpec.
 * Returns undefined when neither carries a description, so callers can omit the suffix/tag
 * rather than echoing the bare name (which would produce "workload FOO — FOO" / a "foo" tag).
 */
function describeWorkload(wl: { name: string; description?: string }): string | undefined {
	return wl.description ?? WORKLOADS[wl.name]?.description;
}

/**
 * Short tag for latency series labels (chart titles get crowded with the full mix).
 * Takes the descriptive phrase before the parenthetical op-mix, e.g.
 * "Update heavy (50% read / 50% update)" -> "update heavy".
 */
function shortTag(description: string): string {
	return description.split('(')[0].trim().toLowerCase();
}

/** Pure conversion of a results object into the two benchmark series arrays. */
export function convert(results: Results): { throughput: BenchPoint[]; latency: BenchPoint[] } {
	const throughput: BenchPoint[] = [];
	// The load phase can be skipped (e.g. a run against a pre-loaded dataset); omit its
	// series rather than throwing on the missing field.
	if (results.load) {
		throughput.push({ name: `load — ${LOAD_DESCRIPTION}`, unit: 'records/sec', value: round(results.load.throughput) });
	}
	const latency: BenchPoint[] = [];
	for (const wl of results.workloads) {
		const description = describeWorkload(wl);
		const throughputName = description ? `workload ${wl.name} — ${description}` : `workload ${wl.name}`;
		throughput.push({ name: throughputName, unit: 'ops/sec', value: round(wl.throughput) });
		const tag = description ? shortTag(description) : undefined;
		for (const [op, stats] of Object.entries(wl.latency)) {
			const latencyName = tag ? `${wl.name} ${op} p99 — ${tag}` : `${wl.name} ${op} p99`;
			latency.push({ name: latencyName, unit: 'ms', value: round(stats.p99) });
		}
	}
	return { throughput, latency };
}

async function main(): Promise<void> {
	const [resultsPath, outDir] = process.argv.slice(2);
	if (!resultsPath || !outDir) throw new Error('usage: to-benchmark-json.mts <results.json> <out-dir>');

	const results = JSON.parse(await readFile(resultsPath, 'utf8')) as Results;
	const { throughput, latency } = convert(results);

	await mkdir(outDir, { recursive: true });
	await writeFile(join(outDir, 'throughput.json'), JSON.stringify(throughput, null, 2));
	await writeFile(join(outDir, 'latency.json'), JSON.stringify(latency, null, 2));
	console.log(`wrote ${throughput.length} throughput + ${latency.length} latency metrics to ${outDir}`);
}

// Only run as a CLI; stays inert when imported (e.g. by the test module).
if (import.meta.url === `file://${process.argv[1]}`) {
	main().catch((error) => {
		console.error(error);
		process.exit(1);
	});
}
