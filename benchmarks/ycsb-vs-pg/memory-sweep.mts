/**
 * Read throughput as the dataset outgrows memory, at an equal CPU and memory budget.
 *
 * A Redis holding the whole dataset is the cache-aside stack's upper bound, not a realistic app.
 * Here nothing forces a hit rate: every target gets the same 4 cores and the same 8 GiB (hard caps,
 * page cache included, swap off), the dataset is sized as a multiple of that budget, and the hit
 * rate is whatever the stack's memory split yields under the zipfian key distribution.
 *
 *   node benchmarks/ycsb-vs-pg/memory-sweep.mts --ratios=0.5,2,8 --targets=harper-uws,harper,pg-redis,pg-only
 *   node benchmarks/ycsb-vs-pg/memory-sweep.mts --targets=harper-uws,harper-uws-sized,pg-redis --sized-ratios=0.5
 *
 * Each dataset size is loaded once per engine (REST, the same generator as run-compare) into a
 * quiesced snapshot. Every (target, workload) sample then restores that snapshot inside its own
 * capped cgroup — so the restored files' page cache is charged to the sample — warms up on the
 * workload's own distribution until throughput (and Redis hit rate) settle, and measures one run.
 */
import { rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { WORKLOADS, formatKey } from '../ycsb/workload.mts';
import type { PhaseResult } from '../ycsb/workload.mts';
import { startDriver, type DriverRun } from './shardedDriver.mts';
import { SWEEP_STACK_MEMORY, removePgSnapshots, dataDir } from './pgStack.mts';
import { sampleResources, waitForQuiet, readCgroupMemory } from './resources.mts';
import {
	TARGETS,
	MEMORY_BUDGET_BYTES,
	RESULTS_DIR,
	argValue,
	assertNoErrors,
	createSession,
	measureWindow,
	parseTargets,
	primaryLatency,
	targetOrder,
	withTarget,
	writeJsonAtomic,
	type MeasuredWindow,
	type Running,
	type Session,
	type TargetName,
} from './run-compare.mts';

const exec = promisify(execFile);

/** Records whose logical payload (fields × field length) is `ratio` × the memory budget. */
export function recordsForRatio(ratio: number, budgetBytes: number, recordBytes: number): number {
	if (!Number.isFinite(ratio) || ratio <= 0) throw new Error(`dataset ratio must be a positive number, got ${ratio}`);
	const records = Math.floor((ratio * budgetBytes) / recordBytes);
	if (records < 1) throw new Error(`ratio ${ratio} gives no records`);
	return records;
}

export interface WarmupChunk {
	throughput: number;
	hitRate?: number;
}

/**
 * Whether the last `window` chunks agree as a window — max-min spread of throughput within
 * `throughputTolerance` of its mean (5%, this host's rep-to-rep noise), and of hit rate within
 * `hitRateTolerance` — rather than pairwise, which would admit a slow drift.
 */
export function warmupConverged(
	chunks: WarmupChunk[],
	{ window = 3, throughputTolerance = 0.05, hitRateTolerance = 0.005 } = {}
): boolean {
	if (chunks.length < window) return false;
	const last = chunks.slice(-window);
	const throughputs = last.map((c) => c.throughput);
	const mean = throughputs.reduce((a, b) => a + b, 0) / window;
	if (mean <= 0 || (Math.max(...throughputs) - Math.min(...throughputs)) / mean > throughputTolerance) return false;
	const hitRates = last.map((c) => c.hitRate).filter((h): h is number => h !== undefined);
	return hitRates.length < window || Math.max(...hitRates) - Math.min(...hitRates) <= hitRateTolerance;
}

interface Snapshot {
	/** Harper: a directory; Postgres: a name under the data dir's snapshots/. */
	restore: string;
	/** Harper: the install directory to recreate on restore. */
	restoreRoot?: string;
	load: PhaseResult;
	quiesceMs: number;
	quiet: boolean;
	diskBytes: number;
}

interface PointResult {
	ratio: number;
	records: number;
	logicalBytes: number;
	snapshots: Partial<Record<'harper' | 'pg', Snapshot>>;
}

interface SweepSample {
	ratio: number;
	records: number;
	target: TargetName;
	workload: string;
	position: number;
	status: 'ok' | 'failed';
	failure?: { phase: string; error: string };
	startupMs?: number;
	quiesceMs?: number;
	/** False when the target was still busy when the quiesce wait ran out. */
	quiet?: boolean;
	warmup?: WarmupChunk[];
	converged?: boolean;
	measured?: MeasuredWindow;
}

const engineOf = (target: TargetName): 'harper' | 'pg' => (TARGETS[target].kind === 'stack' ? 'pg' : 'harper');

async function diskBytes(path: string): Promise<number> {
	// PGDATA belongs to the container's postgres uid, so measure as root in a throwaway container.
	const { stdout } = await exec(
		'docker',
		['run', '--rm', '-v', `${dataDir()}:/host-data:ro`, 'alpine:latest', 'du', '-sb', `/host-data/${path}`],
		{ timeout: 10 * 60_000 }
	);
	return Number(stdout.split('\t')[0]);
}

/** Loads one dataset size over REST through a capped `harper` or `pg-only`, quiesces it, and keeps it. */
async function prepareSnapshot(session: Session, engine: 'harper' | 'pg', keyWidth: number): Promise<Snapshot> {
	const { config } = session.options;
	const name = `${engine}-${config.records}`;
	const restore = engine === 'harper' ? join(dataDir(), 'snapshots', name) : name;
	const target: TargetName = engine === 'harper' ? 'harper' : 'pg-only';
	console.log(`\n### snapshot ${name}: loading ${config.records.toLocaleString()} records through ${target}`);
	return withTarget(session, target, async (running) => {
		const driver = await startDriver(driverConfig(session, running, keyWidth, true));
		let load: PhaseResult;
		try {
			load = driver.load;
		} finally {
			driver.close();
		}
		assertNoErrors('load', load);
		if (load.ops !== config.records) throw new Error(`load inserted ${load.ops} of ${config.records} records`);
		console.log(`  [load] ${load.throughput.toFixed(0)} records/sec, ${(load.elapsedMs / 60_000).toFixed(1)} min`);
		await running.afterLoad?.();
		const { waitedMs, quiet } = await waitForQuiet(running.targets, { maxMs: 60 * 60_000 });
		console.log(`  [quiesce] ${(waitedMs / 1000).toFixed(0)} s${quiet ? '' : ' (did not get quiet)'}`);
		for (const [component, scope] of Object.entries(running.targets.cgroups)) {
			const kills = (await readCgroupMemory(scope)).events.oom_kill ?? 0;
			if (kills > 0) throw new Error(`${component}: ${kills} OOM kill(s) while loading; snapshot not taken`);
		}
		const restoreRoot = (await running.snapshot(restore)) || undefined;
		return { restore, restoreRoot, load, quiesceMs: waitedMs, quiet, diskBytes: await diskBytes(`snapshots/${name}`) };
	});
}

function driverConfig(session: Session, running: Running, keyWidth: number, load: boolean) {
	const { config } = session.options;
	return {
		baseUrl: running.baseUrl,
		table: config.table,
		records: config.records,
		opsPerWorkload: config.opsPerWorkload,
		concurrency: config.concurrency,
		shards: session.shards,
		shape: { fieldCount: config.fieldCount, fieldLength: config.fieldLength },
		keyWidth,
		maxScanLength: config.maxScanLength,
		load,
	};
}

/** Fails unless the first and last loaded records came back with the restore, intact. */
async function verifyRestoredData(running: Running, session: Session, keyWidth: number): Promise<void> {
	const { config } = session.options;
	for (const index of [0, config.records - 1]) {
		const key = formatKey(index, keyWidth);
		const response = await fetch(`${running.baseUrl}/${config.table}/${key}`, { signal: AbortSignal.timeout(30_000) });
		const record = response.ok ? ((await response.json()) as Record<string, string>) : undefined;
		if (record?.field0?.length !== config.fieldLength) {
			throw new Error(`restored dataset is missing ${key} (HTTP ${response.status})`);
		}
	}
}

async function warmUp(
	running: Running,
	driver: DriverRun,
	workload: string,
	chunkOps: number,
	maxChunks: number
): Promise<{ chunks: WarmupChunk[]; converged: boolean }> {
	const chunks: WarmupChunk[] = [];
	while (chunks.length < maxChunks) {
		const before = running.targets.redisExec ? await sampleResources(running.targets) : undefined;
		const result = await driver.runWorkload(workload, 'zipfian', chunkOps);
		assertNoErrors(`warmup ${workload}`, result);
		const chunk: WarmupChunk = { throughput: result.throughput };
		if (before?.redis) {
			const after = (await sampleResources(running.targets)).redis!;
			const lookups = after.hits - before.redis.hits + (after.misses - before.redis.misses);
			if (lookups > 0) chunk.hitRate = (after.hits - before.redis.hits) / lookups;
		}
		chunks.push(chunk);
		console.log(
			`  [warmup ${chunks.length}] ${chunk.throughput.toFixed(0)} ops/sec` +
				(chunk.hitRate !== undefined ? `, cache-hit ${(chunk.hitRate * 100).toFixed(2)}%` : '')
		);
		if (warmupConverged(chunks)) return { chunks, converged: true };
	}
	return { chunks, converged: false };
}

/**
 * True when none of this invocation's scopes and none of the compose project's containers are
 * running. A failed sample is survivable only if it left nothing behind to compete with the next.
 */
async function nothingLeftRunning(session: Session): Promise<boolean> {
	const { stdout: units } = await exec(
		'systemctl',
		[
			'--user',
			'list-units',
			'--plain',
			'--no-legend',
			'--state=active,activating,deactivating,reloading',
			`${session.unitPrefix}-*`,
		],
		{ timeout: 30_000 }
	);
	const { stdout: containers } = await exec(
		'docker',
		['ps', '-q', '--filter', 'label=com.docker.compose.project=ycsb-vs-pg'],
		{ timeout: 60_000 }
	);
	return units.trim() === '' && containers.trim() === '';
}

async function measureSweepSample(
	session: Session,
	target: TargetName,
	workload: string,
	snapshot: Snapshot,
	keyWidth: number,
	sample: SweepSample,
	{ chunkOps, maxChunks, measureOps }: { chunkOps: number; maxChunks: number; measureOps: number }
): Promise<void> {
	let phase = 'start';
	const spec = TARGETS[target];
	const launch = {
		restore: snapshot.restore,
		restoreRoot: snapshot.restoreRoot,
		recordCacheSize: spec.kind === 'harper' && spec.sized ? 2 ** Math.ceil(Math.log2(sample.records)) : undefined,
	};
	try {
		await withTarget(
			session,
			target,
			async (running) => {
				sample.startupMs = running.startupMs;
				phase = 'verify';
				const driver = await startDriver(driverConfig(session, running, keyWidth, false));
				try {
					await verifyRestoredData(running, session, keyWidth);
					phase = 'quiesce';
					const { waitedMs, quiet } = await waitForQuiet(running.targets, { maxMs: 10 * 60_000 });
					sample.quiesceMs = waitedMs;
					sample.quiet = quiet;
					phase = 'warmup';
					const { chunks, converged } = await warmUp(running, driver, workload, chunkOps, maxChunks);
					sample.warmup = chunks;
					sample.converged = converged;
					phase = 'measure';
					sample.measured = await measureWindow(session, running, driver, workload, 'zipfian', measureOps);
					sample.status = 'ok';
				} finally {
					driver.close();
				}
			},
			launch
		);
	} catch (error) {
		sample.status = 'failed';
		sample.failure = { phase, error: (error as Error).stack ?? String(error) };
		console.log(`  FAILED in ${phase}: ${(error as Error).message}`);
	}
}

function printSweep(points: PointResult[], samples: SweepSample[]): void {
	const out: string[] = ['', '='.repeat(150)];
	out.push(
		`Equal budget per target: 4 cores, ${MEMORY_BUDGET_BYTES / 1024 ** 3} GiB (hard caps, page cache included, swap off)`
	);
	out.push(
		[
			'ratio'.padEnd(6),
			'records'.padStart(11),
			' wl'.padEnd(4),
			'target'.padEnd(18),
			'ops/s'.padStart(8),
			'p50 ms'.padStart(8),
			'p99 ms'.padStart(8),
			'CPU µs/op'.padStart(10),
			'hit %'.padStart(7),
			'warmup'.padStart(7),
			'  memory MiB: peak per component',
		].join('')
	);
	out.push('-'.repeat(150));
	for (const point of points) {
		for (const s of samples.filter((x) => x.ratio === point.ratio)) {
			const m = s.measured;
			const lat = m ? primaryLatency(m.result) : undefined;
			const memory = m
				? Object.entries(m.resources.peakMemoryBytes)
						.map(([k, v]) => `${k} ${(v / 1048576).toFixed(0)}`)
						.join('  ')
				: '';
			out.push(
				[
					String(point.ratio).padEnd(6),
					point.records.toLocaleString().padStart(11),
					` ${s.workload}`.padEnd(4),
					s.target.padEnd(18),
					(s.status === 'ok' ? m!.result.throughput.toFixed(0) : 'FAILED').padStart(8),
					(lat ? lat.p50.toFixed(2) : '-').padStart(8),
					(lat ? lat.p99.toFixed(2) : '-').padStart(8),
					(m ? m.cpuMicrosPerOp.toFixed(1) : '-').padStart(10),
					(m?.redisHitRate === undefined ? '-' : (m.redisHitRate * 100).toFixed(2)).padStart(7),
					(s.warmup ? `${s.warmup.length}${s.converged && s.quiet ? '' : '!'}` : '-').padStart(7),
					`  ${memory}${m?.overBudget ? '  OVER BUDGET' : ''}${s.failure ? `  (${s.failure.phase})` : ''}`,
				].join('')
			);
		}
	}
	out.push(
		"warmup = 1M-op chunks until 3 agree; '!' = no plateau within the chunk ceiling, or never quiet before warmup (not settled)"
	);
	out.push('='.repeat(150));
	process.stdout.write(out.join('\n') + '\n');
}

async function removeSnapshots(): Promise<void> {
	await removePgSnapshots();
	await rm(join(dataDir(), 'snapshots'), { recursive: true, force: true });
}

async function main(): Promise<void> {
	const argv = process.argv.slice(2);
	const targets = parseTargets(argValue(argv, '--targets') ?? 'harper-uws,harper,pg-redis,pg-only');
	const ratios = (argValue(argv, '--ratios') ?? '0.5,2,8').split(',').map(Number);
	// A record cache sized to the dataset is only plausible at the smallest point, so that is the default.
	const sizedRatios = argValue(argv, '--sized-ratios')?.split(',').map(Number) ?? [Math.min(...ratios)];
	for (const ratio of sizedRatios) {
		if (!ratios.includes(ratio)) throw new Error(`--sized-ratios: ${ratio} is not one of --ratios ${ratios.join(',')}`);
	}
	const chunkOps = Number(argValue(argv, '--warmup-chunk') ?? 1_000_000);
	const maxChunks = Number(argValue(argv, '--warmup-max-chunks') ?? 12);
	for (const [flag, value] of Object.entries({ chunkOps, maxChunks })) {
		if (!Number.isInteger(value) || value < 1) throw new Error(`${flag} must be a positive integer, got ${value}`);
	}
	const { session, meta } = await createSession(argv, {
		targets,
		cache: 'warm',
		stackMemory: (target) => SWEEP_STACK_MEMORY[target],
		ownFlags: ['ratios', 'sized-ratios', 'warmup-chunk', 'warmup-max-chunks'],
	});
	const { config } = session.options;
	const workloads = argv.some((a) => a.startsWith('--workloads=')) ? config.workloads : ['C', 'B'];
	for (const w of workloads)
		if (WORKLOADS[w].mix.insert) throw new Error(`workload ${w} inserts; the sweep restores fixed datasets`);
	const measureOps = argv.some((a) => a.startsWith('--ops=')) ? config.opsPerWorkload : 1_000_000;
	const recordBytes = config.fieldCount * config.fieldLength;
	const pointRecords = ratios.map((ratio) => recordsForRatio(ratio, MEMORY_BUDGET_BYTES, recordBytes));

	const file = join(RESULTS_DIR, `memory-sweep-${meta.timestamp}.json`);
	const runMeta = {
		...meta,
		sweep: {
			ratios,
			sizedRatios,
			workloads,
			distribution: 'zipfian',
			measureOps,
			warmup: { chunkOps, maxChunks, window: 3, throughputTolerance: 0.05, hitRateTolerance: 0.005 },
			recordBytes,
			targetOrderRule: 'forward on even points, reversed on odd points',
			pageCache:
				'charged to the cgroup of the process that first touches a page; each sample writes its own dataset copy from inside its own cgroup',
		},
	};
	const points: PointResult[] = [];
	const samples: SweepSample[] = [];
	const persist = async () => {
		const payload = { meta: runMeta, targets, points, samples };
		await writeJsonAtomic(file, payload);
		await writeJsonAtomic(join(RESULTS_DIR, 'memory-sweep-latest.json'), payload);
	};

	await removeSnapshots();
	try {
		for (let p = 0; p < ratios.length; p++) {
			const records = pointRecords[p];
			const pointSession: Session = { ...session, options: { ...session.options, config: { ...config, records } } };
			const keyWidth = Math.max(10, String(records).length);
			const point: PointResult = { ratio: ratios[p], records, logicalBytes: records * recordBytes, snapshots: {} };
			points.push(point);
			console.log(`\n######## point ${ratios[p]}x: ${records.toLocaleString()} records ########`);
			const order = targetOrder(
				targets.filter((t) => {
					const spec = TARGETS[t];
					return spec.kind === 'stack' || !spec.sized || sizedRatios.includes(ratios[p]);
				}),
				p
			);
			for (const engine of new Set(order.map(engineOf))) {
				point.snapshots[engine] = await prepareSnapshot(pointSession, engine, keyWidth);
				await persist();
			}
			for (const workload of workloads) {
				for (let i = 0; i < order.length; i++) {
					const target = order[i];
					const sample: SweepSample = {
						ratio: ratios[p],
						records,
						target,
						workload,
						position: i + 1,
						status: 'failed',
					};
					console.log(`\n--- ${ratios[p]}x #${i + 1} ${target} / workload ${workload} ---`);
					await measureSweepSample(
						pointSession,
						target,
						workload,
						point.snapshots[engineOf(target)]!,
						keyWidth,
						sample,
						{
							chunkOps,
							maxChunks,
							measureOps,
						}
					);
					samples.push(sample);
					await persist();
					if (sample.status === 'failed' && !(await nothingLeftRunning(session))) {
						throw new Error('a failed sample left processes or containers running; aborting the session');
					}
				}
			}
			await removeSnapshots();
		}
	} finally {
		await removeSnapshots().catch(() => {});
	}
	printSweep(points, samples);
	console.log(`\nResults written to ${file}`);
}

if (import.meta.main) {
	main().catch((error) => {
		console.error(error);
		process.exit(1);
	});
}
