/**
 * Harper vs. a conventional Node stack (Fastify + Postgres + Redis) on the same
 * YCSB-style REST workload.
 *
 * Reuses benchmarks/ycsb for everything that defines the workload — record
 * shape, key distributions, op mixes, REST client, latency recording — and adds
 * a multi-process load driver (shardedDriver.mts), because the single-process
 * runner's own ~38k req/s ceiling sits below what these targets can serve.
 *
 *   node benchmarks/ycsb-vs-pg/run-compare.mts --scale=standard
 *   node benchmarks/ycsb-vs-pg/run-compare.mts --workloads=C,A --targets=harper,pg-redis
 *
 * `--threads` sets Harper's worker-thread count AND the Fastify cluster size, so
 * both sides get the same number of request handlers. `--shards` (default 4) is
 * the number of load-generator processes; raise it if client-ceiling.mts shows
 * the client is still the limit.
 */
import { setTimeout as delay } from 'node:timers/promises';
import { readFile, writeFile, mkdir, statfs } from 'node:fs/promises';
import { statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { createHarperContext, setupHarperWithFixture, teardownHarper } from '@harperfast/integration-testing';
import { parseOptions } from '../ycsb/harness.mts';
import { WORKLOADS } from '../ycsb/workload.mts';
import type { DistributionName, LatencyStats, PhaseResult } from '../ycsb/workload.mts';
import { startDriver } from './shardedDriver.mts';
import { startPgStack, dataDir } from './pgStack.mts';
import { sampleResources, diffResources, type ResourceTargets, type ResourceDelta } from './resources.mts';

const REPO_ROOT = join(import.meta.dirname, '..', '..');
const HARPER_BIN = join(REPO_ROOT, 'dist', 'bin', 'harper.js');
const HARPER_APP_DIR = join(REPO_ROOT, 'benchmarks', 'ycsb', 'app');
const RESULTS_DIR = join(import.meta.dirname, 'results');

const ALL_TARGETS = ['harper', 'pg-redis', 'pg-only'] as const;
type TargetName = (typeof ALL_TARGETS)[number];

const TARGET_LABELS: Record<TargetName, string> = {
	'harper': 'Harper (REST + built-in store/cache)',
	'pg-redis': 'Fastify + Postgres + Redis (cache-aside)',
	'pg-only': 'Fastify + Postgres (no cache)',
};

interface TargetResult {
	target: TargetName;
	load: PhaseResult;
	workloads: {
		name: string;
		description: string;
		shards: number;
		result: PhaseResult;
		reps: number[];
		resources: ResourceDelta;
	}[];
	meanBusyCores: number;
}

async function waitForRoute(url: string, deadlineMs: number): Promise<void> {
	const deadline = Date.now() + deadlineMs;
	while (Date.now() < deadline) {
		try {
			const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
			await res.body?.cancel();
			if (res.status >= 200 && res.status < 300) return;
		} catch {
			// not accepting connections yet
		}
		await delay(250);
	}
	throw new Error(`timed out waiting for ${url}`);
}

/** Machine-wide busy CPU in cores — a coarse "what did this cost" signal. */
async function cpuBusyTicks(): Promise<number> {
	const values = (await readFile('/proc/stat', 'utf8')).split('\n')[0].split(/\s+/).slice(1).map(Number);
	return values.reduce((a, b) => a + b, 0) - values[3] - values[4];
}

type Options = ReturnType<typeof parseOptions>;

async function withHarper<T>(
	options: Options,
	body: (baseUrl: string, targets: ResourceTargets) => Promise<T>
): Promise<T> {
	const ctx = createHarperContext('ycsb-vs-pg-harper');
	console.log(`\n=== harper: starting (threads.count=${options.threads}, engine=${options.engine}) ===`);
	await setupHarperWithFixture(ctx, HARPER_APP_DIR, {
		harperBinPath: HARPER_BIN,
		config: {
			threads: { count: options.threads },
			analytics: { aggregatePeriod: -1 },
			logging: { level: 'warn' },
		},
		env: { HARPER_STORAGE_ENGINE: options.engine },
		startupTimeoutMs: options.startupTimeoutMs,
	});
	try {
		const { httpURL } = ctx.harper;
		await waitForRoute(`${httpURL}/${options.config.table}/`, 30_000);
		console.log(`harper ready at ${httpURL}`);
		// Harper is one process; its worker threads are counted with it.
		return await body(httpURL, { processes: { harper: 'dist/bin/harper.js' }, cgroups: {} });
	} finally {
		await teardownHarper(ctx);
	}
}

async function withPgStack<T>(
	options: Options,
	target: 'pg-redis' | 'pg-only',
	body: (baseUrl: string, targets: ResourceTargets) => Promise<T>
): Promise<T> {
	const useCache = target === 'pg-redis';
	console.log(`\n=== ${target}: starting (fastify workers=${options.threads}, cache=${useCache}) ===`);
	const stack = await startPgStack({
		workers: options.threads,
		useCache,
		fields: options.config.fieldCount,
		poolSize: Math.max(4, Math.ceil(options.config.concurrency / options.threads) + 4),
	});
	try {
		await waitForRoute(`${stack.baseUrl}/${options.config.table}/`, 30_000);
		console.log(`${target} ready at ${stack.baseUrl}`);
		return await body(stack.baseUrl, {
			processes: { fastify: 'pg-app/server.mjs' },
			cgroups: stack.cgroups,
			redisExec: useCache ? stack.redisExec : undefined,
		});
	} finally {
		await stack.stop();
	}
}

/**
 * Runs ONE workload against a freshly started target: new server, new dataset,
 * new warmup, then `reps` timed repetitions.
 *
 * Deliberately not amortized across workloads. Sharing one server for all of A,
 * B, C and F let each workload inherit the previous one's state — the record
 * cache left resident by a preceding read sweep, the compaction backlog left by a
 * preceding write burst — and the effect was large enough to reorder the results
 * (a 95%-read workload measuring slower than a 50%-write one). Reloading per
 * workload costs ~20s each and makes every measurement start from the same place.
 */
async function benchmarkWorkload(
	target: TargetName,
	workload: string,
	options: Options,
	shards: number
): Promise<{
	load: PhaseResult;
	result: PhaseResult;
	shards: number;
	reps: number[];
	resources: ResourceDelta;
	meanBusyCores: number;
}> {
	const { config } = options;
	const keyWidth = Math.max(10, String(config.records + config.reps * config.opsPerWorkload).length);
	const spec = WORKLOADS[workload];
	const distribution = (config.distribution ?? spec.distribution) as DistributionName;

	const body = async (baseUrl: string, resourceTargets: ResourceTargets) => {
		const driver = await startDriver({
			baseUrl,
			table: config.table,
			records: config.records,
			opsPerWorkload: config.opsPerWorkload,
			concurrency: config.concurrency,
			shards,
			shape: { fieldCount: config.fieldCount, fieldLength: config.fieldLength },
			keyWidth,
			maxScanLength: config.maxScanLength,
		});
		try {
			console.log(`  [load] ${driver.load.throughput.toFixed(0)} records/sec, ${driver.load.errors} errors`);
			// Warm UNIFORMLY over at least the whole keyspace: a zipfian warmup only touches the
			// hot keys, leaving the measured workload to absorb the first-touch cost of every
			// remaining row — for Postgres, the hint-bit rewrite each page needs after a bulk load.
			if (config.warmupOps > 0) {
				const warmupOps = Math.max(config.warmupOps, config.records * 2);
				console.log(`  [warmup] ${warmupOps.toLocaleString()} uniform read ops (discarded)`);
				await driver.runWorkload('C', 'uniform', warmupOps);
			}
			// Resources are sampled around the timed reps only — the load and warmup
			// phases would otherwise charge each workload for setup it doesn't measure.
			const reps: { result: PhaseResult; resources: ResourceDelta }[] = [];
			for (let rep = 0; rep < config.reps; rep++) {
				const before = await sampleResources(resourceTargets);
				const result = await driver.runWorkload(workload, distribution);
				const resources = diffResources(before, await sampleResources(resourceTargets));
				const perCore = result.ops / Math.max(resources.totalCpuSeconds, 1e-9);
				const cacheTotal = resources.redisHits + resources.redisMisses;
				const hitRate = cacheTotal > 0 ? ` cache-hit ${((resources.redisHits / cacheTotal) * 100).toFixed(1)}%` : '';
				console.log(
					`  [${workload} rep ${rep + 1}/${config.reps}] ${result.throughput.toFixed(0)} ops/sec, ` +
						`${resources.totalCpuSeconds.toFixed(1)} server cpu-s, ${perCore.toFixed(0)} ops/core-s${hitRate}`
				);
				reps.push({ result, resources });
			}
			const sorted = [...reps].sort((a, b) => a.result.throughput - b.result.throughput);
			const median = sorted[Math.floor((sorted.length - 1) / 2)];
			return {
				load: driver.load,
				result: median.result,
				shards: driver.shardsUsed(workload),
				reps: reps.map((r) => r.result.throughput),
				resources: median.resources,
			};
		} finally {
			driver.close();
		}
	};

	console.log(`\n--- ${target} / workload ${workload} (${spec.description}) ---`);
	const beforeTicks = await cpuBusyTicks();
	const started = Date.now();
	const measured =
		target === 'harper'
			? await withHarper(options, body)
			: await withPgStack(options, target as 'pg-redis' | 'pg-only', body);
	const meanBusyCores = ((await cpuBusyTicks()) - beforeTicks) / 100 / ((Date.now() - started) / 1000);
	return { ...measured, meanBusyCores };
}

async function benchmarkTarget(target: TargetName, options: Options, shards: number): Promise<TargetResult> {
	const workloads: TargetResult['workloads'] = [];
	const loads: PhaseResult[] = [];
	let busySum = 0;
	for (const name of options.config.workloads) {
		const measured = await benchmarkWorkload(target, name, options, shards);
		loads.push(measured.load);
		busySum += measured.meanBusyCores;
		workloads.push({
			name,
			description: WORKLOADS[name].description,
			shards: measured.shards,
			result: measured.result,
			reps: measured.reps,
			resources: measured.resources,
		});
	}
	// Every workload reloaded the dataset, so report the median load throughput.
	const sortedLoads = [...loads].sort((a, b) => a.throughput - b.throughput);
	return {
		target,
		load: sortedLoads[Math.floor((sortedLoads.length - 1) / 2)],
		workloads,
		meanBusyCores: busySum / Math.max(1, options.config.workloads.length),
	};
}

function printComparison(results: TargetResult[]): void {
	const baseline = results[0];
	const width = 118;
	const out: string[] = ['', '='.repeat(width)];
	out.push('Harper vs. conventional Node stack — throughput (ops/sec), higher is better');
	out.push('='.repeat(width));
	for (const r of results) out.push(`  ${r.target.padEnd(10)} ${TARGET_LABELS[r.target]}`);
	out.push('');

	const header = ['phase'.padEnd(30), ...results.map((r) => r.target.padStart(14))];
	for (const r of results.slice(1)) header.push(`${baseline.target}/${r.target}`.padStart(22));
	out.push(header.join(''));
	out.push('-'.repeat(width));

	const row = (label: string, pick: (r: TargetResult) => number) => {
		const values = results.map(pick);
		const cells = [label.slice(0, 30).padEnd(30), ...values.map((v) => v.toFixed(0).padStart(14))];
		for (let i = 1; i < values.length; i++) cells.push(`${(values[0] / values[i]).toFixed(2)}x`.padStart(22));
		out.push(cells.join(''));
	};

	row('load (inserts)', (r) => r.load.throughput);
	for (const wl of baseline.workloads) {
		row(`${wl.name}: ${wl.description}`, (r) => r.workloads.find((w) => w.name === wl.name)!.result.throughput);
	}

	out.push('');
	out.push('p99 latency (ms), primary op of each workload');
	out.push('-'.repeat(width));
	for (const wl of baseline.workloads) {
		const cells = [wl.name.padEnd(30)];
		for (const r of results) {
			const match = r.workloads.find((w) => w.name === wl.name)!.result.latency;
			const stats: LatencyStats | undefined = match.read ?? (Object.values(match)[0] as LatencyStats | undefined);
			cells.push((stats?.p99 ?? 0).toFixed(2).padStart(14));
		}
		out.push(cells.join(''));
	}

	out.push('');
	out.push('efficiency — ops per server CPU-second (load generator excluded), higher is better');
	out.push('-'.repeat(width));
	const effRow = (label: string, pick: (r: TargetResult) => number) => {
		const values = results.map(pick);
		const cells = [label.slice(0, 30).padEnd(30), ...values.map((v) => v.toFixed(0).padStart(14))];
		for (let i = 1; i < values.length; i++) cells.push(`${(values[0] / values[i]).toFixed(2)}x`.padStart(22));
		out.push(cells.join(''));
	};
	for (const wl of baseline.workloads) {
		effRow(wl.name, (r) => {
			const w = r.workloads.find((x) => x.name === wl.name)!;
			return w.result.ops / Math.max(w.resources.totalCpuSeconds, 1e-9);
		});
	}

	out.push('');
	out.push('server CPU-seconds per workload, split by component');
	out.push('-'.repeat(width));
	for (const r of results) {
		for (const wl of r.workloads) {
			const parts = Object.entries(wl.resources.byComponent)
				.filter(([, v]) => v > 0.01)
				.map(([k, v]) => `${k} ${v.toFixed(1)}`)
				.join('  ');
			out.push(`  ${`${r.target}/${wl.name}`.padEnd(20)} total ${wl.resources.totalCpuSeconds.toFixed(1).padStart(7)}   ${parts}`);
		}
	}

	const withCache = results.filter((r) =>
		r.workloads.some((w) => w.resources.redisHits + w.resources.redisMisses > 0)
	);
	if (withCache.length > 0) {
		out.push('');
		out.push('Redis cache hit rate (look-aside, behind Fastify) — what fraction never reached Postgres');
		out.push('-'.repeat(width));
		for (const r of withCache) {
			for (const wl of r.workloads) {
				const total = wl.resources.redisHits + wl.resources.redisMisses;
				if (total === 0) continue;
				const pct = (wl.resources.redisHits / total) * 100;
				out.push(
					`  ${`${r.target}/${wl.name}`.padEnd(20)} ${pct.toFixed(1).padStart(6)}%   ` +
						`hits ${wl.resources.redisHits.toLocaleString()}  misses ${wl.resources.redisMisses.toLocaleString()}`
				);
			}
		}
	}
	out.push('='.repeat(width));
	process.stdout.write(out.join('\n') + '\n');
}

function cpuCount(): number {
	return Number(execFileSync('nproc', { encoding: 'utf8' }).trim());
}

/**
 * Puts both engines' data on one real filesystem and proves they share it.
 *
 * The storage medium is not a detail here. On tmpfs an fsync costs nothing, so
 * Postgres gets `synchronous_commit=on` for free while Harper still pays real
 * RocksDB compaction — every write-bearing workload is then measuring the
 * asymmetry, not the engines. Same device, real disk, or the comparison is void.
 */
async function prepareDataDirs(): Promise<{ base: string; harperRoot: string }> {
	const base = dataDir();
	const harperRoot = join(base, 'harper');
	await mkdir(join(base, 'pgdata'), { recursive: true });
	await mkdir(harperRoot, { recursive: true });

	// The framework reads this from the environment when it allocates an install dir.
	process.env.HARPER_INTEGRATION_TEST_INSTALL_PARENT_DIR = harperRoot;

	const pgDev = statSync(join(base, 'pgdata')).dev;
	const harperDev = statSync(harperRoot).dev;
	if (pgDev !== harperDev) {
		throw new Error(
			`Harper and Postgres data directories are on different devices (${harperDev} vs ${pgDev}); ` +
				'set YCSB_VS_PG_DATA_DIR to a single filesystem so the storage medium is not a variable'
		);
	}
	// f_flags is not exposed portably, so detect tmpfs by its magic number instead.
	const fs = await statfs(base);
	const TMPFS_MAGIC = 0x01021994;
	if (Number(fs.type) === TMPFS_MAGIC) {
		throw new Error(
			`${base} is tmpfs — fsync is a no-op there, which flatters whichever engine relies on it. ` +
				'Point YCSB_VS_PG_DATA_DIR at a real disk.'
		);
	}
	return { base, harperRoot };
}

async function main(): Promise<void> {
	const argv = process.argv.slice(2);
	const extract = (flag: string): string | undefined => {
		const found = argv.find((a) => a.startsWith(`${flag}=`));
		return found?.slice(flag.length + 1);
	};
	const targetsArg = extract('--targets');
	const shardsArg = extract('--shards');
	const targets = (targetsArg ? targetsArg.split(',') : ['harper', 'pg-redis']).map((t) => t.trim()) as TargetName[];
	for (const target of targets) {
		if (!ALL_TARGETS.includes(target)) throw new Error(`unknown target "${target}" (expected ${ALL_TARGETS.join(', ')})`);
	}
	const shards = Number(shardsArg ?? 4);
	const options = parseOptions(argv.filter((a) => !a.startsWith('--targets=') && !a.startsWith('--shards=')));

	const { base } = await prepareDataDirs();
	console.log(`Data directories under ${base} (real disk, single filesystem)`);

	const results: TargetResult[] = [];
	for (const target of targets) results.push(await benchmarkTarget(target, options, shards));

	printComparison(results);
	await mkdir(RESULTS_DIR, { recursive: true });
	const stamp = new Date().toISOString().replace(/[:.]/g, '-');
	const payload = {
		meta: { timestamp: stamp, nodeVersion: process.version, cpus: cpuCount(), shards, dataDir: base },
		config: { ...options.config, threads: options.threads, engine: options.engine },
		targets: results,
	};
	const file = join(RESULTS_DIR, `compare-${stamp}.json`);
	await writeFile(file, JSON.stringify(payload, null, 2));
	await writeFile(join(RESULTS_DIR, 'compare-latest.json'), JSON.stringify(payload, null, 2));
	console.log(`\nResults written to ${file}`);
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
