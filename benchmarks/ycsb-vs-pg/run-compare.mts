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
import { readFile, writeFile, mkdir, rename, rm, statfs } from 'node:fs/promises';
import { statSync, existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import { join, resolve, dirname } from 'node:path';
import { parseOptions } from '../ycsb/harness.mts';
import { WORKLOADS } from '../ycsb/workload.mts';
import type { DistributionName, LatencyStats, PhaseResult } from '../ycsb/workload.mts';
import { startDriver, type DriverRun } from './shardedDriver.mts';
import { startPgStack, dataDir, WARM_STACK_MEMORY, type StackMemory } from './pgStack.mts';
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
	verifyMemoryLimit,
	readCgroupMemory,
	processCgroup,
	stopScope,
	pinPid,
	writePinnedRuntime,
	startHostLoad,
	waitForQuietHost,
	checkOwnCgroup,
	foreignProcessesInOwnCgroup,
	type HostLoad,
	type ResourceTargets,
	type ResourceDelta,
	type MemoryLimit,
	type CgroupMemory,
} from './resources.mts';
import {
	PERF_NODE_OPTIONS,
	foldPerfScript,
	removePerfMaps,
	perfAvailable,
	startCounters,
	startRecord,
	sumCounters,
	type Counters,
} from './perfProfile.mts';

const REPO_ROOT = join(import.meta.dirname, '..', '..');
const HARPER_APP_DIR = join(REPO_ROOT, 'benchmarks', 'ycsb', 'app');
export const RESULTS_DIR = join(import.meta.dirname, 'results');

type HarperTarget = { kind: 'harper'; uws: boolean; sized: boolean; base: boolean; label: string };
type StackTarget = { kind: 'stack'; cache: boolean; label: string };

/** What each target is. Launch settings derive from this, never from the name. */
export const TARGETS = {
	'harper': { kind: 'harper', uws: false, sized: false, base: false, label: 'Harper, Node HTTP, stock record cache' },
	'harper-sized': {
		kind: 'harper',
		uws: false,
		sized: true,
		base: false,
		label: 'Harper, Node HTTP, HARPER_RECORD_CACHE_SIZE >= record count',
	},
	'harper-uws': { kind: 'harper', uws: true, sized: false, base: false, label: 'Harper, uWS HTTP, stock record cache' },
	'harper-uws-sized': {
		kind: 'harper',
		uws: true,
		sized: true,
		base: false,
		label: 'Harper, uWS HTTP, HARPER_RECORD_CACHE_SIZE >= record count',
	},
	'harper-base': {
		kind: 'harper',
		uws: false,
		sized: false,
		base: true,
		label: 'Harper (--base-harper build), Node HTTP, stock record cache',
	},
	'pg-redis': { kind: 'stack', cache: true, label: 'Fastify + Postgres + Redis (cache-aside)' },
	'pg-only': { kind: 'stack', cache: false, label: 'Fastify + Postgres (no cache)' },
} satisfies Record<string, HarperTarget | StackTarget>;
export type TargetName = keyof typeof TARGETS;
const ALL_TARGETS = Object.keys(TARGETS) as TargetName[];

export function parseTargets(list: string): TargetName[] {
	const targets = list.split(',').map((t) => t.trim()) as TargetName[];
	for (const target of targets) {
		if (!ALL_TARGETS.includes(target))
			throw new Error(`unknown target "${target}" (expected ${ALL_TARGETS.join(', ')})`);
	}
	return targets;
}

/** The memory each target is budgeted, summed across all its processes. */
export const MEMORY_BUDGET_BYTES = 8 * 1024 ** 3;
/** Versioned because what "memory" means changed: cgroup charges incl. page cache, hard caps, swap off. */
const METHODOLOGY = 'v2: every component in its own memory cgroup (hard cap, swap off); cgroup charges reported';

type CacheMode = 'warm' | 'cold';
/** none: Harper serves loopback as its local-trust principal and Fastify checks nothing; token: both verify a bearer JWT. */
export type AuthMode = 'none' | 'token';
type Options = ReturnType<typeof parseOptions>;

export interface Session {
	options: Options;
	cache: CacheMode;
	shards: number;
	serverCpus: number[];
	driverCpus: number[];
	harperBin: string;
	baseHarperBin?: string;
	/** Applied to the sized targets (warm) or every Harper target (cold). */
	recordCacheSize: number;
	/** Harper's cgroup memory.max: the budget, or Infinity with --harper-memory=measured. */
	harperMemoryBytes: number;
	stackMemory: (target: 'pg-redis' | 'pg-only') => StackMemory;
	/** Prefix for this invocation's systemd scope names, so cleanup never touches another run's. */
	unitPrefix: string;
	/** Shared by every copy of the session (memory-sweep makes one per dataset size). */
	units: { count: number };
	/** Hardware counters on every measured window: --perf-counters, or implied by --profile. */
	perfCounters: boolean;
	/** Set by --profile: profiler flags on the targets and a separate sampled-profile window after each measured one. */
	profile?: { dir: string; ops: number };
	auth: AuthMode;
	/** --auth=token: the stack's HS256 secret, generated per session. */
	jwtSecret?: string;
}

interface Sample {
	rep: number;
	/** 1-based position of this target within its rep's order, for drift analysis. */
	position: number;
	target: TargetName;
	workload: string;
	auth: AuthMode;
	/** With --host-quiet-cores: the wait for a quiet host before this sample. */
	hostGate?: { waitedMs: number; quiet: boolean; load: HostLoad };
	/** The gate ran with other processes in this run's cgroup, whose CPU it counted as the run's (see checkOwnCgroup). */
	sharedCgroup?: true;
	shards: number;
	load: PhaseResult;
	warm: PhaseResult;
	measured: MeasuredWindow;
}

async function waitForRoute(url: string, deadlineMs: number, authorization?: string): Promise<void> {
	const deadline = Date.now() + deadlineMs;
	while (Date.now() < deadline) {
		try {
			const res = await fetch(url, {
				signal: AbortSignal.timeout(5000),
				headers: authorization ? { authorization } : {},
			});
			await res.body?.cancel();
			if (res.status >= 200 && res.status < 300) return;
		} catch {
			// not accepting connections yet
		}
		await new Promise((r) => setTimeout(r, 250));
	}
	throw new Error(`timed out waiting for ${url}`);
}

const TOKEN_USER = 'ycsb_reader';

/** An HS256 JWT signed with `secret`: what the stack's clients would hold. */
function mintHs256(secret: string, subject: string): string {
	const part = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
	const body = `${part({ alg: 'HS256', typ: 'JWT' })}.${part({ sub: subject, iat: Math.floor(Date.now() / 1000) })}`;
	return `${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`;
}

/**
 * A non-super-user role that can read and write the benchmark table and nothing else (B updates), a
 * user in it, and that user's operation token. Idempotent, since a restored snapshot may hold them.
 */
async function harperTokenAuthorization(operationsURL: string, admin: string, table: string): Promise<string> {
	const operation = async (body: Record<string, unknown>, tolerate?: RegExp) => {
		const response = await fetch(operationsURL, {
			method: 'POST',
			headers: { 'content-type': 'application/json', 'authorization': admin },
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(60_000),
		});
		const text = await response.text();
		if (response.ok) return JSON.parse(text);
		if (tolerate?.test(text)) return undefined;
		throw new Error(`${body.operation} -> ${response.status}: ${text.slice(0, 300)}`);
	};
	const password = randomBytes(18).toString('base64url');
	await operation(
		{
			operation: 'add_role',
			role: TOKEN_USER,
			permission: {
				super_user: false,
				data: {
					tables: {
						[table]: { read: true, insert: true, update: true, delete: false, attribute_permissions: [] },
					},
				},
			},
		},
		/already exists/i
	);
	const added = await operation(
		{ operation: 'add_user', username: TOKEN_USER, password, role: TOKEN_USER, active: true },
		/already exists/i
	);
	if (!added) await operation({ operation: 'alter_user', username: TOKEN_USER, password, role: TOKEN_USER });
	const tokens = await operation({ operation: 'create_authentication_tokens', username: TOKEN_USER, password });
	if (!tokens?.operation_token) throw new Error('create_authentication_tokens returned no operation_token');
	return `Bearer ${tokens.operation_token}`;
}

/** Proves the target checks the credential: a request without it is refused, one with it is served. */
async function assertCredentialChecked(url: string, authorization: string): Promise<void> {
	const anonymous = await fetch(url, { signal: AbortSignal.timeout(10_000) });
	await anonymous.body?.cancel();
	if (anonymous.status !== 401 && anonymous.status !== 403) {
		throw new Error(`--auth=token: ${url} without a credential answered ${anonymous.status}, not 401/403`);
	}
	const authorized = await fetch(url, { headers: { authorization }, signal: AbortSignal.timeout(10_000) });
	await authorized.body?.cancel();
	if (authorized.status !== 200 && authorized.status !== 404) {
		throw new Error(`--auth=token: ${url} with the token answered ${authorized.status}`);
	}
}

export interface Running {
	baseUrl: string;
	targets: ResourceTargets;
	/** Component name -> root PID, each verified to run on the target cpuset only. */
	pinned: Record<string, number>;
	memoryLimits: Record<string, MemoryLimit>;
	recordCacheSize?: number;
	/** Harper's install directory (its RocksDB info LOGs are under it). */
	dataRoot?: string;
	/** Milliseconds from launch to accepting requests; a restore's copy is part of it. */
	startupMs: number;
	/** --auth=token: the Authorization header every generated request carries. */
	authorization?: string;
	afterLoad?: () => Promise<void>;
	checkpoints?: () => Promise<number>;
	/**
	 * Stops the server cleanly and keeps its dataset as `snapshot` (a name for pg, a directory for
	 * Harper). Harper's install records absolute paths, so it returns the install directory a restore
	 * must recreate.
	 */
	snapshot(snapshot: string): Promise<string | void>;
}

export interface LaunchOptions {
	/** Start from this snapshot instead of an empty dataset. */
	restore?: string;
	/** Harper: the install directory the snapshot was taken from, recreated for the restore. */
	restoreRoot?: string;
	/** Harper's record count when sized; defaults to the session's. */
	recordCacheSize?: number;
}

function nextUnit(session: Session, component: string): string {
	return `${session.unitPrefix}-${++session.units.count}-${component}`;
}

async function withHarper<T>(
	session: Session,
	target: TargetName,
	body: (running: Running) => Promise<T>,
	launch: LaunchOptions = {}
): Promise<T> {
	const { createHarperContext, setupHarperWithFixture, startHarper, killHarper, teardownHarper } =
		await import('@harperfast/integration-testing');
	const spec = TARGETS[target] as HarperTarget;
	const { options } = session;
	const bin = spec.base ? session.baseHarperBin! : session.harperBin;
	const recordCacheSize =
		spec.sized || session.cache === 'cold' ? (launch.recordCacheSize ?? session.recordCacheSize) : undefined;
	const unit = nextUnit(session, 'harper');
	const ctx = createHarperContext(`ycsb-vs-pg-${target}`);
	console.log(
		`\n=== ${target}: starting ${bin} (threads.count=${options.threads}, memory.max=${session.harperMemoryBytes}` +
			`${recordCacheSize ? `, HARPER_RECORD_CACHE_SIZE=${recordCacheSize}` : ''}` +
			`${launch.restore ? `, restoring ${launch.restore}` : ''}) ===`
	);
	const env: Record<string, string> = {
		HARPER_STORAGE_ENGINE: options.engine,
		YCSB_SCOPE_UNIT: unit,
		YCSB_MEMORY_MAX: Number.isFinite(session.harperMemoryBytes) ? String(session.harperMemoryBytes) : 'infinity',
		...(spec.uws ? { HARPER_UWS_HTTP: '1' } : {}),
		...(recordCacheSize ? { HARPER_RECORD_CACHE_SIZE: String(recordCacheSize) } : {}),
		...(session.profile ? { NODE_OPTIONS: PERF_NODE_OPTIONS } : {}),
	};
	const harperOptions = {
		harperBinPath: bin,
		config: {
			threads: { count: options.threads },
			analytics: { aggregatePeriod: -1 },
			logging: { level: 'warn' },
			...(session.auth === 'token' ? { authentication: { authorizeLocal: false } } : {}),
		},
		env,
		startupTimeoutMs: options.startupTimeoutMs,
	};
	const launchedAt = Date.now();
	let started: Awaited<ReturnType<typeof startHarper>>;
	try {
		if (launch.restore) {
			// The copy runs inside Harper's scope before node starts (see writePinnedRuntime), silently,
			// so neither startup timer may fire during it.
			const root = launch.restoreRoot!;
			// Fails if it exists: a leftover from an earlier sample must never be reused.
			await mkdir(root);
			ctx.harper = { dataRootDir: root };
			env.YCSB_RESTORE_FROM = launch.restore;
			env.YCSB_RESTORE_TO = root;
			started = await startHarper(ctx, { ...harperOptions, startupTimeoutMs: 3_600_000, startupMaxMs: 3_600_000 });
		} else {
			// setupHarperWithFixture releases what it allocated if it fails; teardown owns it after.
			started = await setupHarperWithFixture(ctx, HARPER_APP_DIR, harperOptions);
		}
	} catch (error) {
		// Scope first: a copy or a Harper still running in it would race the delete.
		await stopScope(unit);
		if (launch.restore && ctx.harper?.dataRootDir) await rm(ctx.harper.dataRootDir, { recursive: true, force: true });
		throw error;
	}
	try {
		const { httpURL, operationsAPIURL, admin } = started.harper;
		let authorization: string | undefined;
		if (session.auth === 'token') {
			const adminBasic = `Basic ${Buffer.from(`${admin.username}:${admin.password}`).toString('base64')}`;
			await waitForRoute(`${httpURL}/${options.config.table}/`, 30_000, adminBasic);
			authorization = await harperTokenAuthorization(operationsAPIURL, adminBasic, options.config.table);
			await assertCredentialChecked(`${httpURL}/${options.config.table}/auth-probe`, authorization);
		} else {
			await waitForRoute(`${httpURL}/${options.config.table}/`, 30_000);
		}
		const pid = started.harper.process.pid!;
		const cgroup = processCgroup(pid);
		console.log(`${target} ready at ${httpURL} (pid ${pid}, ${cgroup})`);
		return await body({
			baseUrl: httpURL,
			targets: { processes: {}, cgroups: { harper: cgroup } },
			pinned: { harper: pid },
			memoryLimits: {
				harper: verifyMemoryLimit('harper', cgroup, session.harperMemoryBytes, MEMORY_BUDGET_BYTES),
			},
			recordCacheSize,
			authorization,
			dataRoot: started.harper.dataRootDir,
			startupMs: Date.now() - launchedAt,
			async snapshot(dir: string): Promise<string> {
				// Long grace: RocksDB flushes its memtables on a clean shutdown.
				await killHarper(started, { graceMs: 300_000 });
				const { exitCode, signalCode } = started.harper.process;
				// Harper's SIGTERM handler exits 0; dying of the signal means it never ran.
				if (exitCode !== 0) {
					throw new Error(`Harper stopped with ${exitCode ?? signalCode}, not cleanly; snapshot not taken`);
				}
				await mkdir(dirname(dir), { recursive: true });
				await rename(started.harper.dataRootDir, dir);
				return started.harper.dataRootDir;
			},
		});
	} finally {
		await teardownHarper(started);
		await stopScope(unit);
		// teardownHarper swallows a failed delete; a leftover restore root would fail every later restore.
		await rm(started.harper.dataRootDir, { recursive: true, force: true });
	}
}

async function withPgStack<T>(
	session: Session,
	target: TargetName,
	body: (running: Running) => Promise<T>,
	launch: LaunchOptions = {}
): Promise<T> {
	const { options } = session;
	const useCache = (TARGETS[target] as StackTarget).cache;
	const memory = session.stackMemory(target as 'pg-redis' | 'pg-only');
	console.log(
		`\n=== ${target}: starting (fastify workers=${options.threads}, cache=${useCache}` +
			`${launch.restore ? `, restoring ${launch.restore}` : ''}) ===`
	);
	const stack = await startPgStack({
		workers: options.threads,
		useCache,
		fields: options.config.fieldCount,
		poolSize: Math.max(4, Math.ceil(options.config.concurrency / options.threads) + 4),
		serverCpus: session.serverCpus,
		memory,
		fastifyUnit: nextUnit(session, 'fastify'),
		restore: launch.restore,
		nodeOptions: session.profile ? PERF_NODE_OPTIONS : undefined,
		jwtSecret: session.jwtSecret,
	});
	try {
		const authorization = session.jwtSecret ? `Bearer ${mintHs256(session.jwtSecret, TOKEN_USER)}` : undefined;
		await waitForRoute(`${stack.baseUrl}/${options.config.table}/`, 30_000, authorization);
		if (authorization)
			await assertCredentialChecked(`${stack.baseUrl}/${options.config.table}/auth-probe`, authorization);
		console.log(`${target} ready at ${stack.baseUrl}`);
		return await body({
			baseUrl: stack.baseUrl,
			targets: {
				processes: {},
				cgroups: useCache ? stack.cgroups : { fastify: stack.cgroups.fastify, postgres: stack.cgroups.postgres },
				redisExec: useCache ? stack.redisExec : undefined,
			},
			pinned: { fastify: stack.appPid },
			memoryLimits: stack.memoryLimits,
			authorization,
			startupMs: stack.startupMs,
			afterLoad: stack.vacuum,
			checkpoints: stack.checkpoints,
			snapshot: stack.snapshot,
		});
	} finally {
		await stack.stop();
	}
}

export async function withTarget<T>(
	session: Session,
	target: TargetName,
	body: (running: Running) => Promise<T>,
	launch?: LaunchOptions
): Promise<T> {
	try {
		return TARGETS[target].kind === 'stack'
			? await withPgStack(session, target, body, launch)
			: await withHarper(session, target, body, launch);
	} finally {
		if (session.profile) await removePerfMaps();
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

export function assertNoErrors(phase: string, result: PhaseResult): void {
	if (result.errors > 0) throw new Error(`${phase}: ${result.errors} failed requests — sample invalid`);
}

function verifyPlacement(session: Session, running: Running, driver: DriverRun): number {
	let threads = 0;
	for (const [name, pid] of Object.entries(running.pinned)) threads += verifyAffinity(name, pid, session.serverCpus);
	for (const pid of driver.pids) verifyAffinity('generator', pid, session.driverCpus);
	return threads;
}

export interface MeasuredWindow {
	result: PhaseResult;
	resources: ResourceDelta & {
		peakMemoryBytes: Record<string, number>;
		peakTotalMemoryBytes: number;
		meanMemoryBytes: Record<string, number>;
	};
	/** Each component's cgroup memory at the end of the window (anon/file split, lifetime peak, events). */
	cgroupMemory: Record<string, CgroupMemory>;
	memoryLimits: Record<string, MemoryLimit>;
	overBudget: boolean;
	generatorCpuSeconds: number;
	cpuMicrosPerOp: number;
	redisHitRate?: number;
	redisUsedMemoryBytes?: number;
	redisKeys?: number;
	checkpoints?: number;
	recordCacheSize?: number;
	affinityVerifiedThreads: number;
	/** Wall clock of the measured run, epoch ms. */
	window: { startMs: number; endMs: number };
	/** CPU busy on the host outside this run during the window, and the 1-min load average at its end. */
	host: HostLoad;
	/** With --perf-counters or --profile: hardware counters over the measured window, per component and summed. */
	perf?: { byComponent: Record<string, Counters>; total: Counters };
	/** With --profile: a separate window of `ops` under `perf record`, folded per component. */
	profile?: ProfiledWindow;
}

export interface ProfiledWindow {
	/** Prefix of the folded-stack files: `<prefix>.<component>.folded`; perf.data at `<prefix>.perf.data`. */
	prefix: string;
	ops: number;
	throughput: number;
	cpuMicrosPerOp: number;
	byComponentCpuSeconds: Record<string, number>;
	samples: Record<string, number>;
	/** CPU busy on the host outside this run during the recorded window. */
	host: HostLoad;
	/**
	 * Counters over the `ops` just before the recorded ones, without sampling: steady state, unlike a
	 * measured window that can still carry JIT warmup when the profiler flags are on.
	 */
	steady: {
		ops: number;
		throughput: number;
		cpuMicrosPerOp: number;
		perf: { byComponent: Record<string, Counters>; total: Counters };
	};
}

/**
 * Runs `ops` more of the workload under hardware counters only, then `ops` more under `perf record`
 * on the target cores. Kept apart from the measured window so sampling and its unwinding never touch
 * the published numbers.
 */
async function profileWindow(
	session: Session,
	running: Running,
	driver: DriverRun,
	workload: string,
	distribution: DistributionName,
	label: string
): Promise<ProfiledWindow> {
	const { dir, ops } = session.profile!;
	const prefix = join(dir, label);
	// CPU is read inside each perf window, so perf's own start and stop are not charged to the ops.
	const counters = await startCounters(running.targets.cgroups, RESULTS_DIR);
	let steadyResult: PhaseResult;
	let byComponent: Record<string, Counters>;
	let steadyDelta: ResourceDelta;
	try {
		const steadyBefore = await sampleResources(running.targets);
		steadyResult = await driver.runWorkload(workload, distribution, ops);
		steadyDelta = diffResources(steadyBefore, await sampleResources(running.targets));
	} finally {
		byComponent = await counters.stop();
	}
	assertNoErrors(`steady ${workload}`, steadyResult);
	const steady = {
		ops: steadyResult.ops,
		throughput: steadyResult.throughput,
		cpuMicrosPerOp: (steadyDelta.totalCpuSeconds * 1e6) / steadyResult.ops,
		perf: { byComponent, total: sumCounters(byComponent) },
	};
	const t = steady.perf.total;
	console.log(
		`  [steady ${label}] ${steady.throughput.toFixed(0)} ops/sec, ${steady.cpuMicrosPerOp.toFixed(1)} CPU µs/op, ` +
			`${((t.instructionsUser + t.instructionsKernel) / steady.ops / 1000).toFixed(1)}k instructions/op, ` +
			`IPC ${((t.instructionsUser + t.instructionsKernel) / (t.cyclesUser + t.cyclesKernel)).toFixed(2)}`
	);
	const recorder = await startRecord(session.serverCpus, `${prefix}.perf.data`);
	let result: PhaseResult;
	let delta: ResourceDelta;
	let host: HostLoad;
	try {
		const before = await sampleResources(running.targets);
		const hostLoad = startHostLoad(running.targets);
		result = await driver.runWorkload(workload, distribution, ops);
		host = await hostLoad.stop();
		delta = diffResources(before, await sampleResources(running.targets));
	} finally {
		await recorder.stop();
	}
	assertNoErrors(`profiled ${workload}`, result);
	// Folded while the target still runs: symbols come from its live JIT maps and container roots.
	const samples = await foldPerfScript(`${prefix}.perf.data`, running.targets.cgroups, prefix);
	const cpuMicrosPerOp = (delta.totalCpuSeconds * 1e6) / result.ops;
	console.log(
		`  [profile ${label}] ${result.throughput.toFixed(0)} ops/sec, ${cpuMicrosPerOp.toFixed(1)} CPU µs/op, ` +
			Object.entries(samples)
				.map(([k, v]) => `${k} ${v} samples`)
				.join(', ')
	);
	return {
		prefix,
		ops: result.ops,
		throughput: result.throughput,
		cpuMicrosPerOp,
		byComponentCpuSeconds: delta.byComponent,
		samples,
		host,
		steady,
	};
}

/**
 * Runs `ops` of `workload` and measures it: server CPU and clock, per-component cgroup memory (2 s
 * peak and mean, end-of-window detail), Redis counters and Postgres checkpoints. A component that hit
 * an OOM kill during the window invalidates it, since a recovered worker would still post numbers.
 */
export async function measureWindow(
	session: Session,
	running: Running,
	driver: DriverRun,
	workload: string,
	distribution: DistributionName,
	ops?: number,
	label = workload
): Promise<MeasuredWindow> {
	const affinityVerifiedThreads = verifyPlacement(session, running, driver);
	const checkpointsBefore = await running.checkpoints?.();
	const memory = new MemoryPeakSampler(running.targets);
	const clock = new ClockProbe(session.serverCpus);
	const before = await sampleResources(running.targets);
	const generatorBefore = await cpuSecondsOf(driver.pids);
	const host = startHostLoad(running.targets);
	const counters = session.perfCounters ? await startCounters(running.targets.cgroups, RESULTS_DIR) : undefined;
	const startMs = Date.now();
	memory.start();
	clock.start();
	let result: PhaseResult;
	let meanClockGHz: number;
	let after: Awaited<ReturnType<typeof sampleResources>>;
	let generatorCpuSeconds: number;
	let peaks: Awaited<ReturnType<MemoryPeakSampler['stop']>>;
	let perf: MeasuredWindow['perf'];
	let countersStopped = false;
	try {
		try {
			result = await driver.runWorkload(workload, distribution, ops);
		} finally {
			meanClockGHz = clock.stop();
		}
		// CPU first: stopping the sampler can wait out its interval, and background work in
		// that gap would be charged to the run.
		after = await sampleResources(running.targets);
		generatorCpuSeconds = (await cpuSecondsOf(driver.pids)) - generatorBefore;
		if (counters) {
			countersStopped = true;
			const byComponent = await counters.stop();
			perf = { byComponent, total: sumCounters(byComponent) };
		}
	} finally {
		// A failed window must not leave a system-wide perf running into the next sample.
		if (counters && !countersStopped) await counters.stop().catch(() => {});
		peaks = await memory.stop();
	}
	const window = { startMs, endMs: Date.now() };
	const hostLoad = await host.stop();
	const cgroupMemory: Record<string, CgroupMemory> = {};
	for (const [name, scope] of Object.entries(running.targets.cgroups)) {
		cgroupMemory[name] = await readCgroupMemory(scope);
		// Every component's cgroup is created for this sample, so any kill belongs to it.
		const kills = cgroupMemory[name].events.oom_kill ?? 0;
		if (kills > 0) throw new Error(`${name}: ${kills} OOM kill(s) during this sample — sample invalid`);
	}
	const checkpointsAfter = await running.checkpoints?.();
	assertNoErrors(`workload ${workload}`, result);

	const resources = {
		...diffResources(before, after),
		meanClockGHz,
		peakMemoryBytes: peaks.peakBytes,
		peakTotalMemoryBytes: peaks.peakTotalBytes,
		meanMemoryBytes: peaks.meanBytes,
	};
	if (
		before.redis &&
		after.redis &&
		(after.redis.hits < before.redis.hits || after.redis.misses < before.redis.misses)
	) {
		throw new Error('Redis counters went backwards during the measured run (restart?) — sample invalid');
	}
	let redisHitRate: number | undefined;
	if (running.targets.redisExec) {
		const spec = WORKLOADS[workload];
		const lookups = resources.redisHits + resources.redisMisses;
		const pointReads = (spec.mix.read ?? 0) + (spec.mix.rmw ?? 0) > 0;
		if (pointReads && lookups === 0) throw new Error(`workload ${workload}: no Redis lookups recorded`);
		if (lookups > 0) redisHitRate = resources.redisHits / lookups;
	}
	const cpuMicrosPerOp = (resources.totalCpuSeconds * 1e6) / result.ops;
	const overBudget = peaks.peakTotalBytes > MEMORY_BUDGET_BYTES;
	console.log(
		`  [${workload}] ${result.throughput.toFixed(0)} ops/sec, ` +
			`${cpuMicrosPerOp.toFixed(1)} server CPU µs/op @ ${meanClockGHz.toFixed(2)} GHz, ` +
			`peak ${(peaks.peakTotalBytes / 1048576).toFixed(0)} MiB` +
			(redisHitRate !== undefined ? `, cache-hit ${(redisHitRate * 100).toFixed(2)}%` : '')
	);
	if (overBudget) console.log(`  WARNING: peak memory exceeds the ${MEMORY_BUDGET_BYTES / 1024 ** 3} GiB budget`);
	if (perf) {
		const t = perf.total;
		const instructions = t.instructionsUser + t.instructionsKernel;
		const cycles = t.cyclesUser + t.cyclesKernel;
		console.log(
			`  [perf] ${(instructions / result.ops / 1000).toFixed(1)}k instructions/op, ` +
				`${(cycles / result.ops / 1000).toFixed(1)}k cycles/op, IPC ${(instructions / cycles).toFixed(2)}`
		);
	}
	const profile = session.profile
		? await profileWindow(session, running, driver, workload, distribution, label)
		: undefined;
	return {
		result,
		resources,
		cgroupMemory,
		memoryLimits: running.memoryLimits,
		overBudget,
		generatorCpuSeconds,
		cpuMicrosPerOp,
		redisHitRate,
		redisUsedMemoryBytes: after.redis?.usedMemoryBytes,
		redisKeys: after.redis?.keys,
		checkpoints:
			checkpointsBefore === undefined || checkpointsAfter === undefined
				? undefined
				: checkpointsAfter - checkpointsBefore,
		recordCacheSize: running.recordCacheSize,
		affinityVerifiedThreads,
		window,
		host: hostLoad,
		perf,
		profile,
	};
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

	console.log(`\n--- rep ${rep + 1} #${position} ${target} / workload ${workload} (${spec.description}) ---`);
	return withTarget(session, target, async (running) => {
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
			authorization: running.authorization,
		});
		try {
			assertNoErrors('load', driver.load);
			console.log(`  [load] ${driver.load.throughput.toFixed(0)} records/sec`);
			await running.afterLoad?.();
			// Every key exactly once, through the target's own read path: Redis ends up holding
			// the whole dataset, and first-touch costs land before measuring.
			const warm = await driver.readAll();
			assertNoErrors('read-all pass', warm);
			if (warm.ops !== config.records) throw new Error(`read-all pass read ${warm.ops} of ${config.records} keys`);
			console.log(`  [read-all] ${warm.ops.toLocaleString()} keys at ${warm.throughput.toFixed(0)} reads/sec`);

			const measured = await measureWindow(
				session,
				running,
				driver,
				workload,
				distribution,
				undefined,
				`${target}-${workload}-${session.cache}-rep${rep + 1}`
			);
			if (session.cache === 'warm' && measured.redisHitRate !== undefined && measured.redisHitRate < 0.99) {
				throw new Error(
					`workload ${workload}: Redis hit rate ${(measured.redisHitRate * 100).toFixed(2)}% < 99% in warm mode ` +
						`(${measured.resources.redisEvictions} evictions) — the cache is not holding the dataset`
				);
			}
			return {
				rep,
				position,
				target,
				workload,
				auth: session.auth,
				shards: driver.shardsUsed(workload),
				load: driver.load,
				warm,
				measured,
			};
		} finally {
			await driver.close();
		}
	});
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
export function primaryLatency(result: PhaseResult): LatencyStats | undefined {
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
				throughputs: mine.map((s) => s.measured.result.throughput),
				median: median(mine, (s) => s.measured.result.throughput),
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
		out.push(`  ${target.padEnd(16)} ${TARGETS[target].label}`);
	out.push('='.repeat(width));
	const head = [
		'workload'.padEnd(10),
		'target'.padEnd(16),
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
		const m = s.median.measured;
		const lat = primaryLatency(m.result);
		out.push(
			[
				s.workload.padEnd(10),
				s.target.padEnd(16),
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
		const m = s.median.measured;
		const cpu = Object.entries(m.resources.byComponent)
			.map(([k, v]) => `${k} ${v.toFixed(1)}s`)
			.join('  ');
		const mem = Object.entries(m.resources.peakMemoryBytes)
			.map(([k, v]) => `${k} ${(v / 1048576).toFixed(0)}`)
			.join('  ');
		out.push(
			`  ${`${s.target}/${s.workload}`.padEnd(22)} cpu: ${cpu}   peak MiB: ${mem}   generator ${m.generatorCpuSeconds.toFixed(1)}s`
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

/** Writes through a temp file and a rename, so a kill mid-write never truncates hours of results. */
export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
	const tmp = `${path}.tmp-${process.pid}`;
	await writeFile(tmp, JSON.stringify(value, null, 2));
	await rename(tmp, path);
}

export const argValue = (argv: string[], flag: string): string | undefined =>
	argv.find((a) => a.startsWith(`${flag}=`))?.slice(flag.length + 1);

/**
 * Everything a comparison session shares: target validation, CPU placement, Harper's launch
 * wrapper, a clean inherited environment, the data directories and the recorded conditions.
 * `ownFlags` are the caller's own flags, kept away from the YCSB option parser.
 */
export async function createSession(
	argv: string[],
	{
		targets,
		cache,
		stackMemory,
		ownFlags = [],
	}: {
		targets: TargetName[];
		cache: CacheMode;
		stackMemory: (target: 'pg-redis' | 'pg-only') => StackMemory;
		ownFlags?: string[];
	}
): Promise<{ session: Session; meta: Record<string, unknown> }> {
	if (argv.includes('--uws')) {
		throw new Error('--uws is gone: the HTTP backend is part of the target (harper-uws, harper-uws-sized)');
	}
	if (cache === 'cold') {
		// Cold Postgres is pg-only. A sized target is the warm configuration by definition, and a
		// base build need not read HARPER_RECORD_CACHE_SIZE (6d725818 does not).
		const refused = targets.filter((t) => {
			const spec = TARGETS[t];
			return spec.kind === 'stack' ? spec.cache : spec.sized || spec.base;
		});
		if (refused.length > 0) throw new Error(`--cache=cold does not support ${refused.join(', ')}`);
	}
	const auth = (argValue(argv, '--auth') ?? 'none') as AuthMode;
	if (auth !== 'none' && auth !== 'token') throw new Error(`--auth must be none or token, got ${auth}`);
	const harperMemory = argValue(argv, '--harper-memory') ?? 'capped';
	if (harperMemory !== 'capped' && harperMemory !== 'measured') {
		throw new Error(`--harper-memory must be capped or measured, got ${harperMemory}`);
	}
	const baseHarperArg = argValue(argv, '--base-harper');
	if (targets.includes('harper-base') && !baseHarperArg)
		throw new Error('harper-base needs --base-harper=<path to dist/bin/harper.js>');
	const baseHarperBin = baseHarperArg ? resolve(baseHarperArg) : undefined;
	const harperBin = join(REPO_ROOT, 'dist', 'bin', 'harper.js');
	for (const bin of [harperBin, baseHarperBin])
		if (bin && !existsSync(bin)) throw new Error(`${bin} not found — build it first`);

	const topology = readTopology();
	const serverArg = argValue(argv, '--serverCpus');
	const driverArg = argValue(argv, '--driverCpus');
	let serverCpus: number[];
	let driverCpus: number[];
	if (serverArg || driverArg) {
		if (!serverArg || !driverArg) throw new Error('--serverCpus and --driverCpus go together');
		serverCpus = parseCpuList(serverArg);
		driverCpus = parseCpuList(driverArg);
	} else {
		({ server: serverCpus, driver: driverCpus } = chooseCpuSets(
			topology,
			Number(argValue(argv, '--target-cpus') ?? 4)
		));
	}
	assertDisjointCores(topology, serverCpus, driverCpus);

	const sessionFlags = [
		'targets',
		'shards',
		'serverCpus',
		'driverCpus',
		'target-cpus',
		'cache',
		'base-harper',
		'harper-memory',
		'profile',
		'profile-ops',
		'auth',
	];
	const passthrough = argv.filter((a) => {
		if (a === '--perf-counters') return false;
		const name = /^--([^=]+)=/.exec(a)?.[1];
		return !name || ![...sessionFlags, ...ownFlags].includes(name);
	});
	// Harper threads and Fastify workers default to one per target core.
	if (!passthrough.some((a) => a.startsWith('--threads'))) passthrough.push(`--threads=${serverCpus.length}`);
	const options = parseOptions(passthrough);
	const sizesCache = targets.some((t) => {
		const spec = TARGETS[t];
		return spec.kind === 'harper' && (spec.sized || cache === 'cold');
	});
	if (sizesCache && options.engine !== 'rocksdb') {
		throw new Error(`HARPER_RECORD_CACHE_SIZE only applies to the rocksdb engine, not ${options.engine}`);
	}

	// Harper inherits this environment: an exported value would silently retune or re-back a target.
	// Core treats any non-empty HARPER_UWS_HTTP as on, "0" included.
	for (const name of [
		'HARPER_RECORD_CACHE_SIZE',
		'HARPER_UWS_HTTP',
		'HARPER_UWS_UDS',
		'YCSB_SCOPE_UNIT',
		'YCSB_MEMORY_MAX',
		'YCSB_RESTORE_FROM',
		'YCSB_RESTORE_TO',
		'YCSB_PG_RESTORE',
		'JWT_SECRET',
		'AUTHENTICATION_AUTHORIZELOCAL',
	])
		delete process.env[name];
	// This process, and the generator shards it forks, run on the generator cores.
	await pinPid(process.pid, driverCpus);
	process.env.HARPER_RUNTIME = await writePinnedRuntime(RESULTS_DIR, serverCpus);

	const profileDir = argValue(argv, '--profile');
	const perfCounters = Boolean(profileDir) || argv.includes('--perf-counters');
	if (perfCounters) await perfAvailable();
	let profile: Session['profile'];
	if (profileDir) {
		const ops = Number(argValue(argv, '--profile-ops') ?? 1_000_000);
		if (!Number.isInteger(ops) || ops < 1) throw new Error(`--profile-ops must be a positive integer, got ${ops}`);
		// One subdirectory per session: results files reference these artifacts by path.
		profile = { dir: join(resolve(profileDir), new Date().toISOString().replace(/[:.]/g, '-')), ops };
		await mkdir(profile.dir, { recursive: true });
		// The profiler flags also make V8 write isolate-*-v8.log files into each target's working
		// directory, which it inherits from here; every path this harness uses is absolute.
		process.chdir(profile.dir);
	}
	const stamp = new Date().toISOString().replace(/[:.]/g, '-');
	const session: Session = {
		options,
		cache,
		shards: Number(argValue(argv, '--shards') ?? 4),
		serverCpus,
		driverCpus,
		harperBin,
		baseHarperBin,
		recordCacheSize: cache === 'warm' ? 2 ** Math.ceil(Math.log2(options.config.records)) : 4,
		harperMemoryBytes: harperMemory === 'capped' ? MEMORY_BUDGET_BYTES : Infinity,
		stackMemory,
		unitPrefix: `ycsb-vs-pg-${process.pid}`,
		units: { count: 0 },
		perfCounters,
		profile,
		auth,
		jwtSecret: auth === 'token' ? randomBytes(32).toString('base64url') : undefined,
	};

	const { base } = await prepareDataDirs();
	// The loopback pool keeps its registry in tmpdir() and indexes it by slot, so neither the file nor
	// the addresses may be shared with Harper tests elsewhere on the host: a shared file with another
	// range mis-maps slots, and a private file with the default range lets a test co-bind our ports.
	// Set before @harperfast/integration-testing is first imported (withHarper), which reads both.
	process.env.TMPDIR = join(base, 'tmp');
	await mkdir(process.env.TMPDIR, { recursive: true });
	process.env.HARPER_INTEGRATION_TEST_LOOPBACK_POOL_START = '240';
	process.env.HARPER_INTEGRATION_TEST_LOOPBACK_POOL_COUNT = '8';
	console.log(`Data directories under ${base} (real disk, single filesystem)`);
	console.log(`Target cpus ${serverCpus.join(',')}, generator cpus ${driverCpus.join(',')}, cache=${cache}`);
	await mkdir(RESULTS_DIR, { recursive: true });

	const meta = {
		timestamp: stamp,
		methodology: METHODOLOGY,
		nodeVersion: process.version,
		cpus: topology.length,
		cpuModel: /model name\s*:\s*(.*)/.exec(readFileSync('/proc/cpuinfo', 'utf8'))?.[1],
		noTurbo: readSysfs('/sys/devices/system/cpu/intel_pstate/no_turbo'),
		scalingMaxKHz: readSysfs(`/sys/devices/system/cpu/cpu${serverCpus[0]}/cpufreq/scaling_max_freq`),
		governor: readSysfs(`/sys/devices/system/cpu/cpu${serverCpus[0]}/cpufreq/scaling_governor`),
		hostMemoryBytes: Number(/^MemTotal:\s+(\d+) kB/m.exec(readFileSync('/proc/meminfo', 'utf8'))?.[1]) * 1024,
		serverCpus,
		driverCpus,
		memoryBudgetBytes: MEMORY_BUDGET_BYTES,
		memorySplit: {
			harper: harperMemory === 'capped' ? { memoryMaxBytes: MEMORY_BUDGET_BYTES } : 'measured, not capped',
			...Object.fromEntries(
				targets
					.filter((t) => TARGETS[t].kind === 'stack')
					.map((t) => {
						const split = stackMemory(t as 'pg-redis' | 'pg-only');
						// A test knob composeEnv honors over every split, so the split records what applied.
						const override = process.env.YCSB_REDIS_MAXMEMORY;
						if (!override) return [t, split];
						const effective: Record<string, unknown> = { ...split, redisMaxmemory: override };
						delete effective.redisMaxmemoryMiB;
						return [t, effective];
					})
			),
		},
		cache,
		recordCacheSize: sizesCache ? session.recordCacheSize : undefined,
		shards: session.shards,
		dataDir: base,
		harper: { bin: harperBin, revision: gitRevision(REPO_ROOT) },
		harperBase: baseHarperBin
			? { bin: baseHarperBin, revision: gitRevision(join(baseHarperBin, '..', '..', '..')) }
			: undefined,
		config: { ...options.config, threads: options.threads, engine: options.engine },
		perfCounters,
		profile: profile && { ...profile, nodeOptions: PERF_NODE_OPTIONS },
		auth:
			auth === 'token'
				? {
						mode: auth,
						harper: `authentication.authorizeLocal false; role ${TOKEN_USER} (not super_user; read/insert/update on ${options.config.table} only); create_authentication_tokens operation token (RS256)`,
						stack:
							'@fastify/jwt (fast-jwt) HS256, verified in an onRequest hook on every request, no verified-token cache',
					}
				: { mode: auth },
	};
	return { session, meta };
}

async function main(): Promise<void> {
	const argv = process.argv.slice(2);
	const targets = parseTargets(argValue(argv, '--targets') ?? 'harper,pg-redis');
	const cache = (argValue(argv, '--cache') ?? 'warm') as CacheMode;
	if (cache !== 'warm' && cache !== 'cold') throw new Error(`--cache must be warm or cold, got ${cache}`);
	const hostQuietArg = argValue(argv, '--host-quiet-cores');
	const hostQuietCores = hostQuietArg === undefined ? undefined : Number(hostQuietArg);
	const hostQuietMaxMin = Number(argValue(argv, '--host-quiet-max-min') ?? 20);
	for (const [flag, value] of Object.entries({ hostQuietCores, hostQuietMaxMin })) {
		if (value !== undefined && !(value >= 0)) throw new Error(`${flag} must be a non-negative number, got ${value}`);
	}
	const { argv: sessionArgv, sharedCgroup } =
		hostQuietCores === undefined ? { argv, sharedCgroup: false } : checkOwnCgroup(argv, foreignProcessesInOwnCgroup());
	const { session, meta } = await createSession(sessionArgv, {
		targets,
		cache,
		stackMemory: (target) => WARM_STACK_MEMORY[target],
		ownFlags: ['host-quiet-cores', 'host-quiet-max-min'],
	});
	const { options } = session;
	const file = join(RESULTS_DIR, `compare-${meta.timestamp}.json`);
	const runMeta = { ...meta, targetOrderRule: 'forward on even reps, reversed on odd reps' };

	const samples: Sample[] = [];
	const persist = async (summaries?: Summary[]) => {
		const payload = { meta: runMeta, targets, samples, summaries };
		await writeJsonAtomic(file, payload);
		await writeJsonAtomic(join(RESULTS_DIR, 'compare-latest.json'), payload);
	};
	for (let rep = 0; rep < options.config.reps; rep++) {
		for (const workload of options.config.workloads) {
			const order = targetOrder(targets, rep);
			for (let i = 0; i < order.length; i++) {
				// Before the sample, not the measured run: a gate between warmup and measuring would cool the target.
				const gate =
					hostQuietCores === undefined
						? undefined
						: await waitForQuietHost({ maxOtherCores: hostQuietCores, maxMs: hostQuietMaxMin * 60_000 });
				if (gate) {
					console.log(
						`  [host] ${gate.last.otherCores.toFixed(2)} cores busy elsewhere` +
							(gate.quiet ? '' : ' — not quiet, running anyway') +
							` (waited ${(gate.waitedMs / 1000).toFixed(0)} s)`
					);
				}
				const sample = await measureSample(session, order[i], workload, rep, i + 1);
				if (gate) {
					sample.hostGate = { waitedMs: gate.waitedMs, quiet: gate.quiet, load: gate.last };
					if (sharedCgroup || foreignProcessesInOwnCgroup().length > 0) sample.sharedCgroup = true;
				}
				samples.push(sample);
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
