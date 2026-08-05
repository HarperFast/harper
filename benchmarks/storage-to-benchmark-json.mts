/**
 * Converts the RESULT lines from the ST-1/ST-2/ST-5 storage benchmark logs (as captured
 * by perf-benchmarks-nightly.yml into benchmarks/_results/*.log) into the
 * github-action-benchmark "custom" format, mirroring benchmarks/ycsb/to-benchmark-json.mts.
 * Emits two files because the metrics have opposite "better" directions:
 *   throughput.json — ops/sec & record counts, bigger is better (tool: customBiggerIsBetter)
 *   latency.json    — ms & MB,                 smaller is better (tool: customSmallerIsBetter)
 *
 *   node benchmarks/storage-to-benchmark-json.mts <results-dir> <out-dir>
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

interface BenchPoint {
	name: string;
	unit: string;
	value: number;
}

export interface Logs {
	indexedWrite?: string;
	ttlChurn?: string;
	concurrentRw?: string;
}

function round(n: number): number {
	return Math.round(n * 100) / 100;
}

function firstMatch(log: string, pattern: RegExp): RegExpMatchArray | undefined {
	return log.match(pattern) ?? undefined;
}

/** Pure conversion of the three raw log bodies into the two benchmark series arrays. */
export function convert(logs: Logs): { throughput: BenchPoint[]; latency: BenchPoint[] } {
	const throughput: BenchPoint[] = [];
	const latency: BenchPoint[] = [];

	if (logs.indexedWrite) {
		for (const m of logs.indexedWrite.matchAll(/INDEXED_WRITE_RESULT variant=(\S+) ops_per_sec=(\S+)/g)) {
			throughput.push({ name: `indexed-write ${m[1]}`, unit: 'ops/sec', value: round(Number(m[2])) });
		}
	}

	if (logs.ttlChurn) {
		const m = firstMatch(
			logs.ttlChurn,
			/TTL_CHURN_RESULT duration_s=(\S+) peak_bytes=(\S+) final_bytes=(\S+) total_inserts=(\S+) bounded=(true|false)/
		);
		if (m) {
			throughput.push({ name: 'ttl-churn total inserts', unit: 'records', value: Number(m[4]) });
			latency.push({ name: 'ttl-churn peak size', unit: 'MB', value: round(Number(m[2]) / 1e6) });
			latency.push({ name: 'ttl-churn final size', unit: 'MB', value: round(Number(m[3]) / 1e6) });
		}
	}

	if (logs.concurrentRw) {
		const m = firstMatch(
			logs.concurrentRw,
			/CONCURRENT_RW_RESULT read_ops=(\S+) write_ops=(\S+) read_p50_ms=(\S+) read_p95_ms=(\S+) read_p99_ms=(\S+)/
		);
		if (m) {
			throughput.push({ name: 'concurrent-rw read ops', unit: 'ops', value: Number(m[1]) });
			throughput.push({ name: 'concurrent-rw write ops', unit: 'ops', value: Number(m[2]) });
			latency.push({ name: 'concurrent-rw read p50', unit: 'ms', value: round(Number(m[3])) });
			latency.push({ name: 'concurrent-rw read p95', unit: 'ms', value: round(Number(m[4])) });
			latency.push({ name: 'concurrent-rw read p99', unit: 'ms', value: round(Number(m[5])) });
		}
	}

	return { throughput, latency };
}

async function readIfPresent(path: string): Promise<string | undefined> {
	try {
		return await readFile(path, 'utf8');
	} catch {
		return undefined;
	}
}

async function main(): Promise<void> {
	const [resultsDir, outDir] = process.argv.slice(2);
	if (!resultsDir || !outDir) throw new Error('usage: storage-to-benchmark-json.mts <results-dir> <out-dir>');

	const logs: Logs = {
		indexedWrite: await readIfPresent(join(resultsDir, 'indexed-write.log')),
		ttlChurn: await readIfPresent(join(resultsDir, 'ttl-churn.log')),
		concurrentRw: await readIfPresent(join(resultsDir, 'concurrent-rw.log')),
	};
	const { throughput, latency } = convert(logs);

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
