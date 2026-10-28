/**
 * Harper vs. a conventional Node stack (Fastify + Postgres + Redis) on the same
 * YCSB-style REST workload, at an equal CPU budget.
 *
 * Reuses benchmarks/ycsb for everything that defines the workload — record
 * shape, key distributions, op mixes, REST client, latency recording — and adds
 * a multi-process load driver (shardedDriver.mts), because the single-process
 * runner's own ceiling sits below what these targets can serve.
 *
 *   node benchmarks/ycsb-vs-pg/run-compare.mts --scale=standard
 *   node benchmarks/ycsb-vs-pg/run-compare.mts --workloads=C,A --targets=harper,pg-redis --target-cpus=4
 *
 * Every target, as a whole, runs on the same set of `--target-cpus` cores (see README); the load
 * generator and this process run on disjoint physical cores.
 */
import { readFile, writeFile, mkdir, statfs } from 'node:fs/promises';
import { statSync, existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { parseOptions } from '../ycsb/harness.mts';
import { WORKLOADS } from '../ycsb/workload.mts';
import type { DistributionName, LatencyStats, PhaseResult } from '../ycsb/workload.mts';
import { startDriver } from './shardedDriver.mts';
import { startPgStack, dataDir, STACK_MEMORY } from './pgStack.mts';
import {
	sampleResources,
	diffResources,
	ClockProbe,
	MemoryPeakSampler,
	parseCpuList,
	readTopology,
	chooseCpuSets,
	assertDisjointCores,
	verifyAffinity,
	pinPid,
	writePinnedRuntime,
	type ResourceTargets,
	type ResourceDelta,
} from './resources.mts';

const REPO_ROOT = join(import.meta.dirname, '..', '..');
const HARPER_APP_DIR = join(REPO_ROOT, 'benchmarks', 'ycsb', 'app');
const RESULTS_DIR = join(import.meta.dirname, 'results');

const ALL_TARGETS = ['harper', 'harper-sized', 'harper-base', 'pg-redis', 'pg-only'] as const;
type TargetName = (typeof ALL_TARGETS)[number];

const TARGET_LABELS: Record<TargetName, string> = {
	'harper': 'Harper (this checkout), stock record cache',
	'harper-sized': 'Harper (this checkout), HARPER_RECORD_CACHE_SIZE >= record count',
	'harper-base': 'Harper (--base-harper build), stock record cache',
	'pg-redis': 'Fastify + Postgres + Redis (cache-aside)',
	'pg-only': 'Fastify + Postgres (no cache)',
};

/** The memory each target is budgeted, summed across all its processes. Recorded, see README. */
const MEMORY_BUDGET_BYTES = 8 * 1024 ** 3;

type CacheMode = 'warm' | 'cold';
type Options = ReturnType<typeof parseOptions>;

interface Session {
	options: Options;
	cache: CacheMode;
	shards: number;
	serverCpus: number[];
	driverCpus: number[];
	harperBin: string;
	baseHarperBin?: string;
	/** Applied to the harper-sized target (warm) or every Harper target (cold). */
	recordCacheSize: number;
	uws: boolean;
}

interface Sample {
	rep: number;
	/** 1-based position of this target within its rep's order, for drift analysis. */
	position: number;
	target: TargetName;
	workload: string;
	shards: number;
	load: PhaseResult;
	warm: PhaseResult;
	result: PhaseResult;
	resources: ResourceDelta & { peakMemoryBytes: Record<string, number>; peakTotalMemoryBytes: number };
	generatorCpuSeconds: number;
	cpuMicrosPerOp: number;
	redisHitRate?: number;
	recordCacheSize?: number;
	affinityVerifiedThreads: number;
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
		await new Promise((r) => setTimeout(r, 250));
	}
	throw new Error(`timed out waiting for ${url}`);
}

interface Running {
	baseUrl: string;
	targets: ResourceTargets;
	/** Component name -> root PID, each verified to run on the target cpuset only. */
	pinned: Record<string, number>;
	recordCacheSize?: number;
}

async function withHarper<T>(
	session: Session,
	target: 'harper' | 'harper-sized' | 'harper-base',
	body: (running: Running) => Promise<T>
): Promise<T> {
	const { createHarperContext, setupHarperWithFixture, teardownHarper } =
		await import('@harperfast/integration-testing');
	const { options } = session;
	const bin = target === 'harper-base' ? session.baseHarperBin! : session.harperBin;
	const recordCacheSize =
		target === 'harper-sized' || (session.cache === 'cold' && target === 'harper')
			? session.recordCacheSize
			: undefined;
	const ctx = createHarperContext(`ycsb-vs-pg-${target}`);
	console.log(
		`\n=== ${target}: starting ${bin} (threads.count=${options.threads}` +
			`${recordCacheSize ? `, HARPER_RECORD_CACHE_SIZE=${recordCacheSize}` : ''}) ===`
	);
	// setupHarperWithFixture releases what it allocated if it fails; teardown owns it after.
	const started = await setupHarperWithFixture(ctx, HARPER_APP_DIR, {
		harperBinPath: bin,
		config: {
			threads: { count: options.threads },
			analytics: { aggregatePeriod: -1 },
			logging: { level: 'warn' },
		},
		env: {
			HARPER_STORAGE_ENGINE: options.engine,
			...(session.uws ? { HARPER_UWS_HTTP: '1' } : {}),
			...(recordCacheSize ? { HARPER_RECORD_CACHE_SIZE: String(recordCacheSize) } : {}),
		},
		startupTimeoutMs: options.startupTimeoutMs,
	});
	try {
		const { httpURL } = started.harper;
		await waitForRoute(`${httpURL}/${options.config.table}/`, 30_000);
		const pid = (started.harper as unknown as { process: { pid: number } }).process.pid;
		console.log(`${target} ready at ${httpURL} (pid ${pid})`);
		return await body({
			baseUrl: httpURL,
			targets: { processes: { harper: pid }, cgroups: {} },
			pinned: { harper: pid },
			recordCacheSize,
		});
	} finally {
		await teardownHarper(started);
	}
}

async function withPgStack<T>(
	session: Session,
	target: 'pg-redis' | 'pg-only',
	body: (running: Running) => Promise<T>
): Promise<T> {
	const { options } = session;
	const useCache = target === 'pg-redis';
	console.log(`\n=== ${target}: starting (fastify workers=${options.threads}, cache=${useCache}) ===`);
	const stack = await startPgStack({
		workers: options.threads,
		useCache,
		fields: options.config.fieldCount,
		poolSize: Math.max(4, Math.ceil(options.config.concurrency / options.threads) + 4),
		serverCpus: session.serverCpus,
	});
	try {
		await waitForRoute(`${stack.baseUrl}/${options.config.table}/`, 30_000);
		console.log(`${target} ready at ${stack.baseUrl}`);
		return await body({
			baseUrl: stack.baseUrl,
			targets: {
				processes: { fastify: stack.appPid },
				cgroups: useCache ? stack.cgroups : { postgres: stack.cgroups.postgres },
				redisExec: useCache ? stack.redisExec : undefined,
			},
			pinned: { fastify: stack.appPid },
		});
	} finally {
		await stack.stop();
	}
}

async function cpuSecondsOf(pids: number[]): Promise<number> {
	let total = 0;
	for (const pid of pids) {
		try {
			const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
			const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
			total += (Number(fields[11]) + Number(fields[12])) / 100;
		} catch {
			// exited
		}
	}
	return total;
}

function assertNoErrors(phase: string, result: PhaseResult): void {
	if (result.errors > 0) throw new Error(`${phase}: ${result.errors} failed requests — sample invalid`);
}

/**
 * One sample: a freshly started target, a fresh dataset, a pass reading every key once, then ONE
 * measured run of the workload. Never amortized across workloads or reps — sharing a server let
 * each run inherit the last one's record cache and compaction backlog, enough to reorder results.
 */
async function measureSample(
	session: Session,
	target: TargetName,
	workload: string,
	rep: number,
	position: number
): Promise<Sample> {
	const { config } = session.options;
	const keyWidth = Math.max(10, String(config.records + config.opsPerWorkload).length);
	const spec = WORKLOADS[workload];
	const distribution = (config.distribution ?? spec.distribution) as DistributionName;

	const body = async (running: Running): Promise<Sample> => {
		let affinityVerifiedThreads = 0;
		for (const [name, pid] of Object.entries(running.pinned)) {
			affinityVerifiedThreads += verifyAffinity(name, pid, session.serverCpus);
		}
		const driver = await startDriver({
			baseUrl: running.baseUrl,
			table: config.table,
			records: config.records,
			opsPerWorkload: config.opsPerWorkload,
			concurrency: config.concurrency,
			shards: session.shards,
			shape: { fieldCount: config.fieldCount, fieldLength: config.fieldLength },
			keyWidth,
			maxScanLength: config.maxScanLength,
		});
		try {
			for (const pid of driver.pids) verifyAffinity('generator', pid, session.driverCpus);
			assertNoErrors('load', driver.load);
			console.log(`  [load] ${driver.load.throughput.toFixed(0)} records/sec`);
			// Every key exactly once: leaves Redis holding the whole dataset (warm) and pays
			// Postgres' post-bulk-load hint-bit rewrite before measuring, in both modes.
			const warm = await driver.readAll();
			assertNoErrors('read-all pass', warm);
			if (warm.ops !== config.records) throw new Error(`read-all pass read ${warm.ops} of ${config.records} keys`);
			console.log(`  [read-all] ${warm.ops.toLocaleString()} keys at ${warm.throughput.toFixed(0)} reads/sec`);

			const memory = new MemoryPeakSampler(running.targets);
			const clock = new ClockProbe(session.serverCpus);
			const before = await sampleResources(running.targets);
			const generatorBefore = await cpuSecondsOf(driver.pids);
			memory.start();
			clock.start();
			const result = await driver.runWorkload(workload, distribution);
			const meanClockGHz = clock.stop();
			const peaks = await memory.stop();
			const after = await sampleResources(running.targets);
			const generatorCpuSeconds = (await cpuSecondsOf(driver.pids)) - generatorBefore;
			assertNoErrors(`workload ${workload}`, result);

			const resources = {
				...diffResources(before, after),
				meanClockGHz,
				peakMemoryBytes: peaks.peakBytes,
				peakTotalMemoryBytes: peaks.peakTotalBytes,
			};
			const lookups = resources.redisHits + resources.redisMisses;
			let redisHitRate: number | undefined;
			if (running.targets.redisExec) {
				const pointReads = (spec.mix.read ?? 0) + (spec.mix.rmw ?? 0) > 0;
				if (pointReads && lookups === 0) throw new Error(`workload ${workload}: no Redis lookups recorded`);
				if (lookups > 0) redisHitRate = resources.redisHits / lookups;
				if (session.cache === 'warm' && redisHitRate !== undefined && redisHitRate < 0.99) {
					throw new Error(
						`workload ${workload}: Redis hit rate ${(redisHitRate * 100).toFixed(2)}% < 99% in warm mode ` +
							`(${resources.redisEvictions} evictions) — the cache is not holding the dataset`
					);
				}
			}
			const cpuMicrosPerOp = (resources.totalCpuSeconds * 1e6) / result.ops;
			console.log(
				`  [${workload} rep ${rep + 1}] ${result.throughput.toFixed(0)} ops/sec, ` +
					`${cpuMicrosPerOp.toFixed(1)} server CPU µs/op @ ${meanClockGHz.toFixed(2)} GHz, ` +
					`peak ${(peaks.peakTotalBytes / 1048576).toFixed(0)} MiB` +
					(redisHitRate !== undefined ? `, cache-hit ${(redisHitRate * 100).toFixed(2)}%` : '')
			);
			if (peaks.peakTotalBytes > MEMORY_BUDGET_BYTES) {
				console.log(`  WARNING: peak memory exceeds the ${MEMORY_BUDGET_BYTES / 1024 ** 3} GiB budget`);
			}
			return {
				rep,
				position,
				target,
				workload,
				shards: driver.shardsUsed(workload),
				load: driver.load,
				warm,
				result,
				resources,
				generatorCpuSeconds,
				cpuMicrosPerOp,
				redisHitRate,
				recordCacheSize: running.recordCacheSize,
				affinityVerifiedThreads,
			};
		} finally {
			driver.close();
		}
	};

	console.log(`\n--- rep ${rep + 1} #${position} ${target} / workload ${workload} (${spec.description}) ---`);
	return target === 'pg-redis' || target === 'pg-only'
		? withPgStack(session, target, body)
		: withHarper(session, target, body);
}

/** Rep `r` runs the targets forward on even reps and reversed on odd ones. */
export function targetOrder<T>(targets: readonly T[], rep: number): T[] {
	return rep % 2 === 0 ? [...targets] : [...targets].reverse();
}

function median<T>(items: T[], by: (item: T) => number): T {
	const sorted = [...items].sort((a, b) => by(a) - by(b));
	return sorted[Math.floor((sorted.length - 1) / 2)];
}

/** The latency block of a workload's primary operation (reads, else scans, else the first). */
function primaryLatency(result: PhaseResult): LatencyStats | undefined {
	return result.latency.read ?? result.latency.scan ?? (Object.values(result.latency)[0] as LatencyStats | undefined);
}

interface Summary {
	target: TargetName;
	workload: string;
	throughputs: number[];
	median: Sample;
}

function summarize(samples: Sample[], targets: TargetName[], workloads: string[]): Summary[] {
	const out: Summary[] = [];
	for (const workload of workloads) {
		for (const target of targets) {
			const mine = samples.filter((s) => s.target === target && s.workload === workload);
			if (mine.length === 0) continue;
			out.push({
				target,
				workload,
				throughputs: mine.map((s) => s.result.throughput),
				median: median(mine, (s) => s.result.throughput),
			});
		}
	}
	return out;
}

function printComparison(summaries: Summary[], session: Session): void {
	const width = 132;
	const out: string[] = ['', '='.repeat(width)];
	out.push(
		`Equal CPU budget: every target on cpus ${session.serverCpus.join(',')} (${session.serverCpus.length} cores); ` +
			`generator on ${session.driverCpus.join(',')}; cache=${session.cache}`
	);
	out.push('Median of reps by throughput; CPU µs/op, memory, hit rate and latency are from that median rep.');
	for (const target of new Set(summaries.map((s) => s.target)))
		out.push(`  ${target.padEnd(14)} ${TARGET_LABELS[target]}`);
	out.push('='.repeat(width));
	const head = [
		'workload'.padEnd(10),
		'target'.padEnd(14),
		'ops/s'.padStart(10),
		'reps (ops/s)'.padStart(26),
		'CPU µs/op'.padStart(10),
		'peak MiB'.padStart(9),
		'hit %'.padStart(7),
		'p50 ms'.padStart(8),
		'p99 ms'.padStart(8),
		'GHz'.padStart(6),
	];
	out.push(head.join(''));
	out.push('-'.repeat(width));
	for (const s of summaries) {
		const m = s.median;
		const lat = primaryLatency(m.result);
		out.push(
			[
				m.workload.padEnd(10),
				m.target.padEnd(14),
				m.result.throughput.toFixed(0).padStart(10),
				s.throughputs
					.map((t) => t.toFixed(0))
					.join('/')
					.padStart(26),
				m.cpuMicrosPerOp.toFixed(1).padStart(10),
				(m.resources.peakTotalMemoryBytes / 1048576).toFixed(0).padStart(9),
				(m.redisHitRate === undefined ? '-' : (m.redisHitRate * 100).toFixed(2)).padStart(7),
				(lat?.p50 ?? 0).toFixed(2).padStart(8),
				(lat?.p99 ?? 0).toFixed(2).padStart(8),
				m.resources.meanClockGHz.toFixed(2).padStart(6),
			].join('')
		);
	}
	out.push('');
	out.push('server CPU-seconds and peak MiB by component (median rep)');
	out.push('-'.repeat(width));
	for (const s of summaries) {
		const m = s.median;
		const cpu = Object.entries(m.resources.byComponent)
			.map(([k, v]) => `${k} ${v.toFixed(1)}s`)
			.join('  ');
		const mem = Object.entries(m.resources.peakMemoryBytes)
			.map(([k, v]) => `${k} ${(v / 1048576).toFixed(0)}`)
			.join('  ');
		out.push(
			`  ${`${m.target}/${m.workload}`.padEnd(20)} cpu: ${cpu}   peak MiB: ${mem}   generator ${m.generatorCpuSeconds.toFixed(1)}s`
		);
	}
	out.push('='.repeat(width));
	process.stdout.write(out.join('\n') + '\n');
}

/**
 * Puts both engines' data on one real filesystem and proves they share it.
 *
 * On tmpfs an fsync costs nothing, so Postgres gets `synchronous_commit=on` for free while
 * Harper still pays real RocksDB compaction — every write-bearing workload is then measuring
 * the asymmetry, not the engines. Same device, real disk, or the comparison is void.
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

/** HEAD of a checkout, or the REVISION file an exported (git archive) tree carries instead. */
function gitRevision(root: string): string {
	try {
		return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: 'pipe' }).trim();
	} catch {
		return readSysfs(join(root, 'REVISION')) ?? 'unknown';
	}
}

function readSysfs(path: string): string | undefined {
	try {
		return readFileSync(path, 'utf8').trim();
	} catch {
		return undefined;
	}
}

async function main(): Promise<void> {
	const argv = process.argv.slice(2);
	const extract = (flag: string): string | undefined =>
		argv.find((a) => a.startsWith(`${flag}=`))?.slice(flag.length + 1);
	const targets = (extract('--targets')?.split(',') ?? ['harper', 'pg-redis']).map((t) => t.trim()) as TargetName[];
	for (const target of targets) {
		if (!ALL_TARGETS.includes(target))
			throw new Error(`unknown target "${target}" (expected ${ALL_TARGETS.join(', ')})`);
	}
	const cache = (extract('--cache') ?? 'warm') as CacheMode;
	if (cache !== 'warm' && cache !== 'cold') throw new Error(`--cache must be warm or cold, got ${cache}`);
	if (cache === 'cold') {
		// Cold Postgres is pg-only. harper-sized is the warm configuration by definition, and the
		// base build ignores HARPER_RECORD_CACHE_SIZE, so it cannot be run with a minimal cache.
		const refused = targets.filter((t) => t === 'pg-redis' || t === 'harper-sized' || t === 'harper-base');
		if (refused.length > 0) throw new Error(`--cache=cold does not support ${refused.join(', ')}`);
	}
	const baseHarperArg = extract('--base-harper');
	if (targets.includes('harper-base') && !baseHarperArg)
		throw new Error('harper-base needs --base-harper=<path to dist/bin/harper.js>');
	const baseHarperBin = baseHarperArg ? resolve(baseHarperArg) : undefined;
	const harperBin = join(REPO_ROOT, 'dist', 'bin', 'harper.js');
	for (const bin of [harperBin, baseHarperBin])
		if (bin && !existsSync(bin)) throw new Error(`${bin} not found — build it first`);

	const topology = readTopology();
	const serverArg = extract('--serverCpus');
	const driverArg = extract('--driverCpus');
	let serverCpus: number[];
	let driverCpus: number[];
	if (serverArg || driverArg) {
		if (!serverArg || !driverArg) throw new Error('--serverCpus and --driverCpus go together');
		serverCpus = parseCpuList(serverArg);
		driverCpus = parseCpuList(driverArg);
	} else {
		({ server: serverCpus, driver: driverCpus } = chooseCpuSets(topology, Number(extract('--target-cpus') ?? 4)));
	}
	assertDisjointCores(topology, serverCpus, driverCpus);

	const passthrough = argv.filter(
		(a) => a !== '--uws' && !/^--(targets|shards|serverCpus|driverCpus|target-cpus|cache|base-harper)=/.test(a)
	);
	// Harper threads and Fastify workers default to one per target core.
	if (!passthrough.some((a) => a.startsWith('--threads'))) passthrough.push(`--threads=${serverCpus.length}`);
	const options = parseOptions(passthrough);

	// This process, and the generator shards it forks, run on the generator cores.
	await pinPid(process.pid, driverCpus);
	process.env.HARPER_RUNTIME = await writePinnedRuntime(RESULTS_DIR, serverCpus);

	const session: Session = {
		options,
		cache,
		shards: Number(extract('--shards') ?? 4),
		serverCpus,
		driverCpus,
		harperBin,
		baseHarperBin,
		recordCacheSize: cache === 'warm' ? 2 ** Math.ceil(Math.log2(options.config.records)) : 4,
		uws: argv.includes('--uws'),
	};

	const { base } = await prepareDataDirs();
	console.log(`Data directories under ${base} (real disk, single filesystem)`);
	console.log(`Target cpus ${serverCpus.join(',')}, generator cpus ${driverCpus.join(',')}, cache=${cache}`);

	await mkdir(RESULTS_DIR, { recursive: true });
	const stamp = new Date().toISOString().replace(/[:.]/g, '-');
	const file = join(RESULTS_DIR, `compare-${stamp}.json`);
	const meta = {
		timestamp: stamp,
		nodeVersion: process.version,
		cpus: topology.length,
		cpuModel: /model name\s*:\s*(.*)/.exec(readFileSync('/proc/cpuinfo', 'utf8'))?.[1],
		noTurbo: readSysfs('/sys/devices/system/cpu/intel_pstate/no_turbo'),
		scalingMaxKHz: readSysfs(`/sys/devices/system/cpu/cpu${serverCpus[0]}/cpufreq/scaling_max_freq`),
		governor: readSysfs(`/sys/devices/system/cpu/cpu${serverCpus[0]}/cpufreq/scaling_governor`),
		serverCpus,
		driverCpus,
		memoryBudgetBytes: MEMORY_BUDGET_BYTES,
		memorySplit: {
			'harper': 'measured, not enforced',
			'pg-stack': { ...STACK_MEMORY, fastify: 'remainder, measured, not enforced' },
		},
		cache,
		recordCacheSize: session.recordCacheSize,
		shards: session.shards,
		dataDir: base,
		harper: { bin: harperBin, revision: gitRevision(REPO_ROOT) },
		harperBase: baseHarperBin
			? { bin: baseHarperBin, revision: gitRevision(join(baseHarperBin, '..', '..', '..')) }
			: undefined,
		targetOrderRule: 'forward on even reps, reversed on odd reps',
	};
	const config = { ...options.config, threads: options.threads, engine: options.engine };

	const samples: Sample[] = [];
	const persist = async (summaries?: Summary[]) => {
		const payload = JSON.stringify({ meta, config, targets, samples, summaries }, null, 2);
		await writeFile(file, payload);
		await writeFile(join(RESULTS_DIR, 'compare-latest.json'), payload);
	};
	for (let rep = 0; rep < options.config.reps; rep++) {
		for (const workload of options.config.workloads) {
			const order = targetOrder(targets, rep);
			for (let i = 0; i < order.length; i++) {
				samples.push(await measureSample(session, order[i], workload, rep, i + 1));
				await persist();
			}
		}
	}
	const summaries = summarize(samples, targets, options.config.workloads);
	printComparison(summaries, session);
	await persist(summaries);
	console.log(`\nResults written to ${file}`);
}

if (import.meta.main) {
	main().catch((error) => {
		console.error(error);
		process.exit(1);
	});
}
