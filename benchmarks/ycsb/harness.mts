/**
 * Shared YCSB benchmark harness: CLI option parsing, the load + run-phase
 * driver, results assembly, and console reporting. Both the single-node
 * (harper) and 3-node cluster (harper-pro) entry points call into this so the
 * workload definitions and result shape stay identical across them.
 */
import { parseArgs } from 'node:util';
import { execFileSync } from 'node:child_process';
import { writeFile, mkdir } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { join } from 'node:path';
import {
	WORKLOADS,
	KeyState,
	runOperations,
	type DistributionName,
	type LatencyStats,
	type OperationType,
	type PhaseResult,
} from './workload.mts';
import { createRestExecutor } from './restClient.mts';

export interface BenchmarkConfig {
	records: number;
	opsPerWorkload: number;
	concurrency: number;
	loadConcurrency: number;
	fieldCount: number;
	fieldLength: number;
	maxScanLength: number;
	warmupOps: number;
	workloads: string[];
	reps: number;
	distribution?: DistributionName;
	table: string;
}

export interface ParsedOptions {
	config: BenchmarkConfig;
	scale: string;
	engine: string;
	threads: number;
	nodeCount: number;
	out: string;
	startupTimeoutMs: number;
	settleMs: number;
	profile: boolean;
}

const SCALE_PRESETS: Record<string, { records: number; opsPerWorkload: number; concurrency: number }> = {
	quick: { records: 50_000, opsPerWorkload: 100_000, concurrency: 32 },
	standard: { records: 200_000, opsPerWorkload: 500_000, concurrency: 64 },
	heavy: { records: 1_000_000, opsPerWorkload: 4_000_000, concurrency: 128 },
};

const DEFAULT_WORKLOAD_ORDER = ['C', 'B', 'A', 'F', 'D', 'E'];

export function parseOptions(argv: string[]): ParsedOptions {
	const { values } = parseArgs({
		args: argv,
		options: {
			'scale': { type: 'string', default: 'standard' },
			'records': { type: 'string' },
			'ops': { type: 'string' },
			'concurrency': { type: 'string' },
			'load-concurrency': { type: 'string' },
			'fields': { type: 'string', default: '10' },
			'field-length': { type: 'string', default: '100' },
			'scan-max': { type: 'string', default: '100' },
			'warmup': { type: 'string' },
			'reps': { type: 'string', default: '1' },
			'workloads': { type: 'string', default: DEFAULT_WORKLOAD_ORDER.join(',') },
			'distribution': { type: 'string' },
			'engine': { type: 'string', default: 'rocksdb' },
			'threads': { type: 'string', default: '4' },
			'nodes': { type: 'string', default: '3' },
			'out': { type: 'string', default: join(import.meta.dirname, 'results') },
			'startup-timeout': { type: 'string', default: '120000' },
			'settle-ms': { type: 'string', default: '0' },
			'profile': { type: 'boolean', default: false },
		},
		allowPositionals: false,
	});

	const preset = SCALE_PRESETS[values.scale as string];
	if (!preset) throw new Error(`unknown scale "${values.scale}" (expected ${Object.keys(SCALE_PRESETS).join(', ')})`);

	const opsPerWorkload = values.ops ? Number(values.ops) : preset.opsPerWorkload;
	const concurrency = values.concurrency ? Number(values.concurrency) : preset.concurrency;
	const workloads = (values.workloads as string).split(',').map((w) => w.trim().toUpperCase());
	for (const w of workloads) {
		if (!WORKLOADS[w])
			throw new Error(`unknown workload "${w}" (expected one of ${Object.keys(WORKLOADS).join(', ')})`);
	}

	const config: BenchmarkConfig = {
		records: values.records ? Number(values.records) : preset.records,
		opsPerWorkload,
		concurrency,
		loadConcurrency: values['load-concurrency'] ? Number(values['load-concurrency']) : concurrency,
		fieldCount: Number(values.fields),
		fieldLength: Number(values['field-length']),
		maxScanLength: Number(values['scan-max']),
		warmupOps: values.warmup ? Number(values.warmup) : Math.min(opsPerWorkload, 20_000),
		workloads,
		reps: Math.max(1, Math.floor(Number(values.reps)) || 1),
		distribution: values.distribution as DistributionName | undefined,
		table: 'usertable',
	};

	return {
		config,
		scale: values.scale as string,
		engine: values.engine as string,
		threads: Number(values.threads),
		nodeCount: Number(values.nodes),
		out: values.out as string,
		startupTimeoutMs: Number(values['startup-timeout']),
		settleMs: Number(values['settle-ms']),
		profile: values.profile as boolean,
	};
}

function keyWidth(config: BenchmarkConfig): number {
	// Size for the largest key index any rep can reach. With --reps the keyspace carries
	// forward, so budget for every rep being all-inserts (the pessimistic bound) — keeps key
	// formatting consistent even if a future workload inserts far more than today's ≤5%.
	return Math.max(10, String(config.records + config.reps * config.opsPerWorkload).length);
}

/**
 * Picks the median run by throughput from a set of repetitions of the same
 * workload. Returning a whole rep (rather than computing each metric's median
 * independently) keeps the reported throughput and its latency block internally
 * consistent — they come from one real run. Robust to a single degenerate rep:
 * an outlier sorts to an end and is never selected. For an even count we take the
 * lower-middle (the more conservative throughput), avoiding any averaging of two
 * runs' incompatible latency blocks.
 */
export function medianByThroughput(reps: PhaseResult[]): PhaseResult {
	const sorted = [...reps].sort((a, b) => a.throughput - b.throughput);
	return sorted[Math.floor((sorted.length - 1) / 2)];
}

export interface WorkloadResult {
	name: string;
	description: string;
	distribution: DistributionName;
	ops: number;
	errors: number;
	elapsedMs: number;
	throughput: number;
	latency: Partial<Record<OperationType, LatencyStats>>;
	// Number of repetitions run for this workload; when >1 the fields above are the
	// median rep (by throughput) and `repThroughputs` lists every rep for transparency.
	reps?: number;
	repThroughputs?: number[];
}

export interface BenchmarkResults {
	meta: Record<string, unknown>;
	config: BenchmarkConfig & { engine: string; threads: number; nodeCount: number; baseUrls: string[] };
	load: { ops: number; errors: number; elapsedMs: number; throughput: number };
	workloads: WorkloadResult[];
}

function gitInfo(): { commit: string; branch: string } {
	const read = (args: string[]): string => {
		try {
			return execFileSync('git', args, { encoding: 'utf8' }).trim();
		} catch {
			return 'unknown';
		}
	};
	return { commit: read(['rev-parse', 'HEAD']), branch: read(['rev-parse', '--abbrev-ref', 'HEAD']) };
}

/**
 * Runs the load phase then each selected workload against the given base URLs
 * (one for single-node, several for a cluster — requests round-robin across
 * them). Returns the assembled results; does not manage instance lifecycle.
 */
export async function runBenchmark(
	baseUrls: string[],
	options: ParsedOptions,
	extraMeta: Record<string, unknown> = {}
): Promise<BenchmarkResults> {
	const { config } = options;
	const width = keyWidth(config);
	const shape = { fieldCount: config.fieldCount, fieldLength: config.fieldLength };
	const executor = createRestExecutor({
		baseUrls,
		table: config.table,
		maxSockets: Math.max(config.concurrency, config.loadConcurrency),
	});

	const log = (msg: string) => process.stdout.write(`${msg}\n`);

	try {
		// --- Load phase: insert `records` records with sequential keys ---
		log(`\n[load] inserting ${config.records.toLocaleString()} records (concurrency ${config.loadConcurrency})...`);
		const loadKeys = new KeyState({
			distribution: 'uniform',
			initialKeyCount: 0,
			keyWidth: width,
			shape,
			maxScanLength: config.maxScanLength,
		});
		const loadResult = await runOperations({
			opCount: config.records,
			concurrency: config.loadConcurrency,
			mix: { insert: 1 },
			executor,
			keys: loadKeys,
			onProgress: (done, total) => log(`  loaded ${done.toLocaleString()} / ${total.toLocaleString()}`),
		});
		log(
			`[load] ${loadResult.throughput.toFixed(0)} records/sec, ${loadResult.errors} errors, ${(loadResult.elapsedMs / 1000).toFixed(1)}s`
		);

		// --- Settle: let async replication converge before reading (cluster runs) ---
		if (options.settleMs > 0) {
			log(`[settle] waiting ${options.settleMs}ms for replication to converge...`);
			await delay(options.settleMs);
		}

		// --- Optional warmup (discarded) ---
		if (config.warmupOps > 0) {
			log(`[warmup] ${config.warmupOps.toLocaleString()} read ops (discarded)...`);
			await runOperations({
				opCount: config.warmupOps,
				concurrency: config.concurrency,
				mix: { read: 1 },
				executor,
				keys: new KeyState({
					distribution: 'zipfian',
					initialKeyCount: config.records,
					keyWidth: width,
					shape,
					maxScanLength: config.maxScanLength,
				}),
			});
		}

		// --- Run phase: each selected workload against the loaded dataset ---
		// Each workload runs `config.reps` times; the reported point is the median rep
		// (by throughput), which keeps a single degenerate rep from skewing the trend.
		// Warmup above runs once per workload set (not per rep) — the dataset is already
		// hot after the first rep, so re-warming each rep would only add runtime without
		// changing what's measured.
		const workloadResults: WorkloadResult[] = [];
		for (const name of config.workloads) {
			const spec = WORKLOADS[name];
			const distribution = config.distribution ?? spec.distribution;
			log(
				`\n[workload ${name}] ${spec.description} — ${distribution}, ${config.opsPerWorkload.toLocaleString()} ops × ${config.reps} rep(s)`
			);
			const reps: PhaseResult[] = [];
			// Carry the readable key count forward across reps so an insert-bearing workload
			// (E, D) keeps allocating fresh keys each rep, mirroring one continuous run, rather
			// than re-inserting the same keys as PUT overwrites. Read/scan-only workloads never
			// advance this, so it stays at config.records for them.
			let keyCount = config.records;
			for (let rep = 0; rep < config.reps; rep++) {
				// Fresh KeyState per rep (independent, reproducible draw) seeded with the
				// keyspace as grown by prior reps.
				const keys = new KeyState({
					distribution,
					initialKeyCount: keyCount,
					keyWidth: width,
					shape,
					maxScanLength: config.maxScanLength,
				});
				const repLabel = config.reps > 1 ? `${name} rep ${rep + 1}/${config.reps}` : name;
				const result: PhaseResult = await runOperations({
					opCount: config.opsPerWorkload,
					concurrency: config.concurrency,
					mix: spec.mix,
					executor,
					keys,
					onProgress: (done, total) => log(`  ${repLabel}: ${done.toLocaleString()} / ${total.toLocaleString()}`),
				});
				log(`[workload ${repLabel}] ${result.throughput.toFixed(0)} ops/sec, ${result.errors} errors`);
				reps.push(result);
				keyCount = keys.keyCount;
			}
			const median = medianByThroughput(reps);
			if (config.reps > 1) {
				const all = reps.map((r) => r.throughput.toFixed(0)).join(', ');
				log(`[workload ${name}] median ${median.throughput.toFixed(0)} ops/sec of [${all}]`);
			}
			workloadResults.push({
				name,
				description: spec.description,
				distribution,
				ops: median.ops,
				errors: median.errors,
				elapsedMs: median.elapsedMs,
				throughput: median.throughput,
				latency: median.latency,
				reps: config.reps,
				repThroughputs: reps.map((r) => r.throughput),
			});
		}

		const { commit, branch } = gitInfo();
		return {
			meta: {
				timestamp: new Date().toISOString(),
				gitCommit: commit,
				gitBranch: branch,
				nodeVersion: process.version,
				platform: `${process.platform}-${process.arch}`,
				...extraMeta,
			},
			config: {
				...config,
				engine: options.engine,
				threads: options.threads,
				nodeCount: baseUrls.length,
				baseUrls,
			},
			load: {
				ops: loadResult.ops,
				errors: loadResult.errors,
				elapsedMs: loadResult.elapsedMs,
				throughput: loadResult.throughput,
			},
			workloads: workloadResults,
		};
	} finally {
		executor.close();
	}
}

export async function writeResults(results: BenchmarkResults, outDir: string, label: string): Promise<string> {
	await mkdir(outDir, { recursive: true });
	const stamp = results.meta.timestamp as string;
	const file = join(outDir, `ycsb-${label}-${stamp.replace(/[:.]/g, '-')}.json`);
	await writeFile(file, JSON.stringify(results, null, 2));
	await writeFile(join(outDir, `ycsb-${label}-latest.json`), JSON.stringify(results, null, 2));
	return file;
}

function fmt(n: number): string {
	return n.toFixed(2).padStart(9);
}

export function printReport(results: BenchmarkResults): void {
	const lines: string[] = [];
	lines.push('');
	lines.push('='.repeat(78));
	lines.push(
		`YCSB results — ${results.config.nodeCount} node(s), threads.count=${results.config.threads}, ${results.config.engine}`
	);
	lines.push(
		`records=${results.config.records.toLocaleString()}  ops/workload=${results.config.opsPerWorkload.toLocaleString()}  concurrency=${results.config.concurrency}  reps=${results.config.reps} (median)`
	);
	lines.push('='.repeat(78));
	lines.push(`load: ${results.load.throughput.toFixed(0)} records/sec (${results.load.errors} errors)`);
	lines.push('');
	lines.push(
		`${'workload'.padEnd(10)}${'op'.padEnd(8)}${'thrput/s'.padStart(10)}${'p50 ms'.padStart(10)}${'p95 ms'.padStart(10)}${'p99 ms'.padStart(10)}${'max ms'.padStart(10)}`
	);
	lines.push('-'.repeat(78));
	for (const wl of results.workloads) {
		const header = `${wl.name.padEnd(10)}`;
		const types = Object.keys(wl.latency) as OperationType[];
		types.forEach((type, i) => {
			const s = wl.latency[type]!;
			const prefix = i === 0 ? header : ' '.repeat(10);
			const thr = i === 0 ? wl.throughput.toFixed(0).padStart(10) : ''.padStart(10);
			lines.push(`${prefix}${type.padEnd(8)}${thr}${fmt(s.p50)}${fmt(s.p95)}${fmt(s.p99)}${fmt(s.max)}`);
		});
		if (wl.errors > 0) lines.push(`${' '.repeat(10)}(${wl.errors} errors)`);
	}
	lines.push('='.repeat(78));
	process.stdout.write(lines.join('\n') + '\n');
}
