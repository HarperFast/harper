/**
 * Server-side resource accounting.
 *
 * Throughput alone can't answer "which stack is more efficient" when the two
 * sides have different numbers of moving parts: the conventional stack runs
 * Fastify workers *plus* Postgres backends *plus* a Redis process, so it can buy
 * throughput with cores that Harper never spends. This attributes CPU to the
 * server components only — the load generator's own cores are excluded, since
 * they are an artifact of measuring, not of serving — which lets the comparison
 * be stated per core-second rather than per machine.
 *
 * Host processes are the process trees of PIDs the harness spawned; containers are read from their cgroup,
 * because Postgres backends fork per connection and would otherwise be missed.
 */
import { readFile, writeFile, mkdir, chmod } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { readFileSync, readdirSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

/** Seconds systemd gives a stopping scope before SIGKILL. */
const SCOPE_STOP_TIMEOUT_S = 30;

/** CLOCK_TICKS per second; 100 on every Linux this benchmark targets. */
const USER_HZ = 100;

export interface ResourceSample {
	/** Server-side CPU seconds consumed, by component. Excludes the load generator. */
	cpuSeconds: Record<string, number>;
	/** Redis hit/miss counters, when a Redis is part of the target. */
	redis?: { hits: number; misses: number; evictions: number; usedMemoryBytes: number; keys: number };
	/** Resident bytes by component. Proportional set size, so shared pages are counted once. */
	memoryBytes: Record<string, number>;
}

export interface ResourceTargets {
	/** Root PIDs the harness owns, keyed by component name; each root's whole process tree is counted. */
	processes: Record<string, number>;
	/** Container cgroup scope paths, keyed by component name. */
	cgroups: Record<string, string>;
	/** Set when the target includes Redis, so hit rate can be sampled. */
	redisExec?: string[];
}

/** `root` and every live descendant, from the ppid links in /proc. */
export function processTree(root: number): number[] {
	const children = new Map<number, number[]>();
	for (const entry of readdirSync('/proc')) {
		if (!/^\d+$/.test(entry)) continue;
		try {
			const stat = readFileSync(`/proc/${entry}/stat`, 'utf8');
			const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
			let list = children.get(ppid);
			if (!list) children.set(ppid, (list = []));
			list.push(Number(entry));
		} catch {
			// exited mid-scan
		}
	}
	const tree: number[] = [];
	const pending = [root];
	while (pending.length > 0) {
		const pid = pending.pop()!;
		tree.push(pid);
		pending.push(...(children.get(pid) ?? []));
	}
	return tree;
}

async function processCpuSeconds(root: number): Promise<number> {
	let total = 0;
	for (const pid of processTree(root)) {
		try {
			const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
			// Fields after the comm field, which is parenthesized and may contain spaces.
			const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
			total += (Number(fields[11]) + Number(fields[12])) / USER_HZ;
		} catch {
			// process exited mid-scan; it cannot have used meaningful CPU since the last sample
		}
	}
	return total;
}

/**
 * Fails unless every thread of every process in `root`'s tree is allowed exactly `cpus`.
 *
 * Affinity is set at creation (taskset wrappers, compose cpuset), never repaired afterwards; this
 * proves it took. A process that escaped would make "equal K-core budget" a label, not a fact.
 */
export function verifyAffinity(component: string, root: number, cpus: number[]): number {
	const expected = cpus.join(',');
	let threads = 0;
	for (const pid of processTree(root)) {
		let tids: string[];
		try {
			tids = readdirSync(`/proc/${pid}/task`);
		} catch {
			continue; // exited
		}
		for (const tid of tids) {
			let status: string;
			try {
				status = readFileSync(`/proc/${pid}/task/${tid}/status`, 'utf8');
			} catch {
				continue;
			}
			const allowed = parseCpuList(/^Cpus_allowed_list:\s*(\S+)/m.exec(status)![1]).join(',');
			if (allowed !== expected) {
				throw new Error(`${component}: pid ${pid} tid ${tid} is allowed cpus ${allowed}, expected ${expected}`);
			}
			threads++;
		}
	}
	if (threads === 0) throw new Error(`${component}: no live threads under pid ${root}`);
	return threads;
}

/** Fails unless a container's effective cpuset is exactly `cpus`. */
export async function verifyCgroupCpuset(component: string, scopePath: string, cpus: number[]): Promise<void> {
	const effective = parseCpuList((await readFile(`${scopePath}/cpuset.cpus.effective`, 'utf8')).trim()).join(',');
	if (effective !== cpus.join(',')) {
		throw new Error(`${component}: cgroup cpuset is ${effective}, expected ${cpus.join(',')}`);
	}
}

export interface CpuTopology {
	cpu: number;
	/** Logical CPUs sharing this CPU's physical core, including itself. */
	siblings: number[];
	maxKHz: number;
}

/**
 * Rated clock that identifies a CPU's core class: base_frequency (unaffected by turbo state and
 * by Turbo Boost Max favored cores) where intel_pstate exposes it, else cpuinfo_max_freq, else 0.
 */
function cpuClassKHz(base: string): number {
	for (const file of ['base_frequency', 'cpuinfo_max_freq']) {
		try {
			return Number(readFileSync(`${base}/cpufreq/${file}`, 'utf8'));
		} catch {
			// not exposed on this platform
		}
	}
	return 0;
}

export function readTopology(): CpuTopology[] {
	const allowed = new Set(
		parseCpuList(/^Cpus_allowed_list:\s*(\S+)/m.exec(readFileSync('/proc/self/status', 'utf8'))![1])
	);
	return onlineCpus()
		.filter((cpu) => allowed.has(cpu))
		.map((cpu) => {
			const base = `/sys/devices/system/cpu/cpu${cpu}`;
			return {
				cpu,
				siblings: parseCpuList(readFileSync(`${base}/topology/core_cpus_list`, 'utf8').trim()),
				maxKHz: cpuClassKHz(base),
			};
		});
}

/**
 * Splits the machine into a target set of `k` CPUs and a disjoint generator set.
 *
 * One logical CPU per physical core, taken from the fastest core class (P-cores on a hybrid
 * part), so every target gets the same execution resources and no target thread shares a
 * physical core with anything. The SMT siblings of target CPUs are left idle; the generator gets
 * every CPU on any other physical core.
 */
export function chooseCpuSets(topology: CpuTopology[], k: number): { server: number[]; driver: number[] } {
	if (!Number.isInteger(k) || k < 1) throw new Error(`--target-cpus must be a positive integer, got ${k}`);
	const cores = new Map<string, CpuTopology[]>();
	for (const t of topology) {
		const key = t.siblings.join(',');
		if (!cores.has(key)) cores.set(key, []);
		cores.get(key)!.push(t);
	}
	const ranked = [...cores.values()].sort((a, b) => b[0].maxKHz - a[0].maxKHz || a[0].cpu - b[0].cpu);
	if (ranked.length <= k) throw new Error(`need more than ${k} physical cores, have ${ranked.length}`);
	const fastest = ranked[0][0].maxKHz;
	const chosen = ranked.slice(0, k);
	if (chosen.some((core) => core[0].maxKHz !== fastest)) {
		throw new Error(`fewer than ${k} physical cores in the fastest class (${fastest} kHz); lower --target-cpus`);
	}
	const server = chosen.map((core) => core[0].cpu).sort((a, b) => a - b);
	const driver = ranked
		.slice(k)
		.flat()
		.map((t) => t.cpu)
		.sort((a, b) => a - b);
	return { server, driver };
}

/** Fails if the two sets overlap or share a physical core (SMT contention between target and generator). */
export function assertDisjointCores(topology: CpuTopology[], server: number[], driver: number[]): void {
	const byCpu = new Map(topology.map((t) => [t.cpu, t]));
	const serverCores = new Set<string>();
	for (const cpu of server) {
		const t = byCpu.get(cpu);
		if (!t) throw new Error(`server cpu ${cpu} is not online/allowed`);
		serverCores.add(t.siblings.join(','));
	}
	for (const cpu of driver) {
		const t = byCpu.get(cpu);
		if (!t) throw new Error(`driver cpu ${cpu} is not online/allowed`);
		if (serverCores.has(t.siblings.join(','))) {
			throw new Error(`driver cpu ${cpu} shares a physical core with the server set`);
		}
	}
}

/**
 * Writes a runtime wrapper that execs node under `taskset`, so Harper's main thread and every
 * worker thread it creates start on `cpus`. @harperfast/integration-testing spawns
 * `HARPER_RUNTIME` (read when it is first imported) in place of `node`.
 *
 * Per launch, through the environment Harper is started with:
 * - `YCSB_SCOPE_UNIT` runs it in its own user systemd scope, capped at `YCSB_MEMORY_MAX` (bytes or
 *   `infinity`) with swap off. The scope exists before node does, so nothing is ever charged elsewhere.
 * - `YCSB_RESTORE_FROM` / `YCSB_RESTORE_TO` copy a dataset snapshot into the install directory first,
 *   inside that scope: the restored files' page cache is charged to the Harper that reads them.
 */
export async function writePinnedRuntime(dir: string, cpus: number[]): Promise<string> {
	const path = join(dir, '.pinned-node.sh');
	const inner = join(dir, '.pinned-node-inner.sh');
	await mkdir(dir, { recursive: true });
	await writeFile(
		inner,
		'#!/bin/sh\nset -e\n' +
			'if [ -n "$YCSB_RESTORE_FROM" ]; then cp -a "$YCSB_RESTORE_FROM/." "$YCSB_RESTORE_TO/"; fi\n' +
			`exec taskset -c ${cpus.join(',')} ${JSON.stringify(process.execPath)} "$@"\n`
	);
	await writeFile(
		path,
		'#!/bin/sh\n' +
			'if [ -n "$YCSB_SCOPE_UNIT" ]; then\n' +
			'\texec systemd-run --user --scope --quiet --collect --expand-environment=no --unit="$YCSB_SCOPE_UNIT" ' +
			`-p MemoryMax="\${YCSB_MEMORY_MAX:-infinity}" -p MemorySwapMax=0 -p TimeoutStopSec=${SCOPE_STOP_TIMEOUT_S} -- ${JSON.stringify(inner)} "$@"\n` +
			'fi\n' +
			`exec ${JSON.stringify(inner)} "$@"\n`
	);
	await chmod(inner, 0o755);
	await chmod(path, 0o755);
	return path;
}

/** Argv prefix that runs a command in its own capped, swap-off user scope (`exec`s, so the PID is kept). */
export function scopedCommand(unit: string, memoryMaxBytes: number): string[] {
	return [
		'systemd-run',
		'--user',
		'--scope',
		'--quiet',
		'--collect',
		'--expand-environment=no',
		`--unit=${unit}`,
		'-p',
		`MemoryMax=${Number.isFinite(memoryMaxBytes) ? memoryMaxBytes : 'infinity'}`,
		'-p',
		'MemorySwapMax=0',
		'-p',
		`TimeoutStopSec=${SCOPE_STOP_TIMEOUT_S}`,
		'--',
	];
}

/**
 * Stops a user scope (killing anything left in it) and fails unless it is gone. A sample must not
 * start while a previous one's workers still hold its cores, memory or ports.
 */
export async function stopScope(unit: string): Promise<void> {
	// systemd SIGKILLs the scope at its TimeoutStopSec, well inside this command's own timeout.
	await exec('systemctl', ['--user', 'stop', `${unit}.scope`], { timeout: (SCOPE_STOP_TIMEOUT_S + 60) * 1000 }).catch(
		() => {}
	);
	const { stdout } = await exec('systemctl', ['--user', 'show', '-P', 'ActiveState', `${unit}.scope`], {
		timeout: 30_000,
	});
	if (!['inactive', 'failed', ''].includes(stdout.trim())) {
		throw new Error(`scope ${unit} is still ${stdout.trim()} after stop`);
	}
}

export function processCgroup(pid: number): string {
	const line = readFileSync(`/proc/${pid}/cgroup`, 'utf8')
		.split('\n')
		.find((l) => l.startsWith('0::'));
	if (!line) throw new Error(`pid ${pid} has no cgroup v2 membership`);
	return `/sys/fs/cgroup${line.slice(3)}`;
}

function readLimit(path: string): number {
	const value = readFileSync(path, 'utf8').trim();
	return value === 'max' ? Infinity : Number(value);
}

export interface MemoryLimit {
	memoryMaxBytes: number;
	swapMaxBytes: number;
	/** Tightest memory.max on any ancestor; a cap there would silently shrink the budget. */
	ancestorMaxBytes: number;
}

/**
 * Fails unless `scope` is capped at exactly `expectedBytes` with swap off, and no ancestor caps it
 * below `minimumBytes` (an uncapped scope still needs the budget's worth of room).
 */
export function verifyMemoryLimit(
	component: string,
	scope: string,
	expectedBytes: number,
	minimumBytes = expectedBytes
): MemoryLimit {
	const memoryMaxBytes = readLimit(`${scope}/memory.max`);
	const swapMaxBytes = readLimit(`${scope}/memory.swap.max`);
	if (memoryMaxBytes !== expectedBytes) {
		throw new Error(`${component}: memory.max is ${memoryMaxBytes}, expected ${expectedBytes}`);
	}
	if (swapMaxBytes !== 0) throw new Error(`${component}: memory.swap.max is ${swapMaxBytes}, expected 0`);
	let ancestorMaxBytes = Infinity;
	for (let dir = dirname(scope); dir.startsWith('/sys/fs/cgroup/'); dir = dirname(dir)) {
		try {
			ancestorMaxBytes = Math.min(ancestorMaxBytes, readLimit(`${dir}/memory.max`));
		} catch {
			// the root cgroup has no memory.max
		}
	}
	if (ancestorMaxBytes < minimumBytes) {
		throw new Error(`${component}: an ancestor cgroup caps memory at ${ancestorMaxBytes}, below ${minimumBytes}`);
	}
	return { memoryMaxBytes, swapMaxBytes, ancestorMaxBytes };
}

export interface CgroupMemory {
	currentBytes: number;
	anonBytes: number;
	/** Page cache charged to the cgroup, shared memory (Postgres shared_buffers) included. */
	fileBytes: number;
	shmemBytes: number;
	/** Lifetime high-water mark, load and restore included. */
	peakBytes: number;
	/** memory.events counters: low, high, max, oom, oom_kill, oom_group_kill. */
	events: Record<string, number>;
}

function keyedCounters(text: string): Record<string, number> {
	const out: Record<string, number> = {};
	for (const line of text.trim().split('\n')) {
		const [key, value] = line.split(' ');
		out[key] = Number(value);
	}
	return out;
}

export async function readCgroupMemory(scope: string): Promise<CgroupMemory> {
	const stat = keyedCounters(await readFile(`${scope}/memory.stat`, 'utf8'));
	return {
		currentBytes: Number(await readFile(`${scope}/memory.current`, 'utf8')),
		anonBytes: stat.anon,
		fileBytes: stat.file,
		shmemBytes: stat.shmem,
		peakBytes: Number(await readFile(`${scope}/memory.peak`, 'utf8')),
		events: keyedCounters(await readFile(`${scope}/memory.events`, 'utf8')),
	};
}

async function totalCpuSeconds(targets: ResourceTargets): Promise<number> {
	let total = 0;
	for (const root of Object.values(targets.processes)) total += await processCpuSeconds(root);
	for (const scope of Object.values(targets.cgroups)) total += await cgroupCpuSeconds(scope);
	return total;
}

/**
 * Waits until the target uses less than `cores` of CPU over a `windowMs` window: compaction after a
 * bulk load, or a checkpoint, must not land in a measured run. Returns how long it waited, and
 * whether it got quiet before `maxMs`.
 */
export async function waitForQuiet(
	targets: ResourceTargets,
	{ cores = 0.1, windowMs = 5000, maxMs = 30 * 60_000 } = {}
): Promise<{ waitedMs: number; quiet: boolean }> {
	const start = Date.now();
	let previous = await totalCpuSeconds(targets);
	while (Date.now() - start < maxMs) {
		await new Promise((r) => setTimeout(r, windowMs));
		const now = await totalCpuSeconds(targets);
		const used = (now - previous) / (windowMs / 1000);
		previous = now;
		if (used < cores) return { waitedMs: Date.now() - start, quiet: true };
	}
	return { waitedMs: Date.now() - start, quiet: false };
}

/** Host-wide busy CPU seconds (user, nice, system, irq, softirq, steal) from /proc/stat. */
async function hostBusyCpuSeconds(): Promise<number> {
	const fields = (await readFile('/proc/stat', 'utf8')).split('\n', 1)[0].trim().split(/\s+/).slice(1).map(Number);
	const [user, nice, system, , , irq, softirq, steal] = fields;
	return (user + nice + system + irq + softirq + steal) / USER_HZ;
}

/**
 * PIDs in `procs` that are neither `self`, an ancestor of it, nor a descendant: processes sharing
 * this run's cgroup without being part of it. `parentOf` is undefined for a process that has exited.
 */
export function foreignPids(procs: number[], self: number, parentOf: (pid: number) => number | undefined): number[] {
	const ancestors = new Set<number>();
	for (let p: number | undefined = self; p !== undefined && p > 0; p = parentOf(p)) ancestors.add(p);
	return procs.filter((pid) => {
		if (ancestors.has(pid) || parentOf(pid) === undefined) return false;
		for (let p: number | undefined = pid; p !== undefined && p > 0; p = parentOf(p)) if (p === self) return false;
		return true;
	});
}

function parentPid(pid: number): number | undefined {
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
		return Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
	} catch {
		return undefined;
	}
}

/**
 * The host gate counts everything in this process's cgroup as the run's own CPU, so it needs a cgroup
 * holding only this run, as bench-run gives. Other processes there (a login or tmux session's jobs)
 * need an explicit `--allow-shared-cgroup`, and every output row then carries `sharedCgroup`.
 */
export function checkOwnCgroup(argv: string[], foreign: string[]): { argv: string[]; sharedCgroup: boolean } {
	const allowed = argv.includes('--allow-shared-cgroup');
	if (foreign.length > 0 && !allowed) {
		throw new Error(
			`this run's cgroup also holds ${foreign.slice(0, 5).join(', ')}${foreign.length > 5 ? ', ...' : ''}, ` +
				"whose CPU the host gate would count as the run's own; run under bench-run, or add " +
				'--allow-shared-cgroup to run anyway (every row is then marked sharedCgroup)'
		);
	}
	return { argv: argv.filter((a) => a !== '--allow-shared-cgroup'), sharedCgroup: foreign.length > 0 };
}

/**
 * @harperfast/integration-testing's detached instance monitor, which an earlier run in the same scope
 * started and which idles on for a minute after that run. It only rescans a registry file every 2 s.
 */
export const isInstanceMonitor = (cmdline: string) =>
	cmdline.includes('/@harperfast/integration-testing/dist/harperMonitor.js');

/** Processes in this process's cgroup that are not part of this run (see foreignPids), as "pid (comm)". */
export function foreignProcessesInOwnCgroup(): string[] {
	const procs = readFileSync(join(processCgroup(process.pid), 'cgroup.procs'), 'utf8')
		.split('\n')
		.filter(Boolean)
		.map(Number);
	const cmdline = (pid: number) => {
		try {
			return readFileSync(`/proc/${pid}/cmdline`, 'utf8');
		} catch {
			return '';
		}
	};
	return foreignPids(procs, process.pid, parentPid)
		.filter((pid) => !isInstanceMonitor(cmdline(pid)))
		.map((pid) => {
			let comm = '?';
			try {
				comm = readFileSync(`/proc/${pid}/comm`, 'utf8').trim();
			} catch {
				// exited
			}
			return `${pid} (${comm})`;
		});
}

export interface HostLoad {
	loadavg1: number;
	/** Mean cores busy over the window outside this run (its own cgroup and the target's). */
	otherCores: number;
	/** Mean cores busy inside this run over the window. */
	ownCores: number;
}

/**
 * Splits host CPU over a window into this run's and everyone else's. Other agents on the host run
 * CPU-heavy work outside the bench lock, which lands on the target cores' SMT siblings and shared
 * caches; this is the measure of that, not the load average, which counts the run itself.
 */
export function startHostLoad(targets?: ResourceTargets): { stop(): Promise<HostLoad> } {
	// This process's cgroup holds, under bench-run, the orchestrator and the load generator's shards.
	const own = async () =>
		(targets ? await totalCpuSeconds(targets) : 0) + (await cgroupCpuSeconds(processCgroup(process.pid)));
	const begin = Promise.all([hostBusyCpuSeconds(), own(), Date.now()]);
	// Observed by stop(); until then a failed read must not be an unhandled rejection.
	begin.catch(() => {});
	return {
		async stop() {
			const [hostBefore, ownBefore, startMs] = await begin;
			const [hostAfter, ownAfter] = await Promise.all([hostBusyCpuSeconds(), own()]);
			const seconds = Math.max(1e-3, (Date.now() - startMs) / 1000);
			const ownCores = (ownAfter - ownBefore) / seconds;
			return {
				loadavg1: Number((await readFile('/proc/loadavg', 'utf8')).split(' ')[0]),
				otherCores: Math.max(0, (hostAfter - hostBefore) / seconds - ownCores),
				ownCores,
			};
		},
	};
}

/**
 * Waits until the rest of the host has used under `maxOtherCores` over a `windowMs` window, for at
 * most `maxMs`; then the sample runs anyway and is marked not quiet.
 */
export async function waitForQuietHost({ maxOtherCores = 1, windowMs = 30_000, maxMs = 20 * 60_000 } = {}): Promise<{
	waitedMs: number;
	quiet: boolean;
	last: HostLoad;
}> {
	const start = Date.now();
	for (;;) {
		const probe = startHostLoad();
		await new Promise((r) => setTimeout(r, windowMs));
		const last = await probe.stop();
		const waitedMs = Date.now() - start;
		if (last.otherCores < maxOtherCores) return { waitedMs, quiet: true, last };
		if (waitedMs >= maxMs) return { waitedMs, quiet: false, last };
		console.log(`  [host] ${last.otherCores.toFixed(1)} cores busy outside the run; waiting`);
	}
}

/** Pins every thread of `pid` (and threads it creates later) to `cpus`. */
export async function pinPid(pid: number, cpus: number[]): Promise<void> {
	await exec('taskset', ['-acp', cpus.join(','), String(pid)]);
}

/**
 * Resident bytes for `root`'s process tree, summed as proportional set size.
 *
 * PSS rather than RSS because both multi-process targets share pages heavily — the Fastify
 * cluster shares its code and V8 pages across six workers, and summing RSS would count those
 * once per worker and overstate the stack by gigabytes.
 */
async function processMemoryBytes(root: number): Promise<number> {
	let total = 0;
	for (const pid of processTree(root)) {
		try {
			const rollup = await readFile(`/proc/${pid}/smaps_rollup`, 'utf8');
			const pss = /^Pss:\s+(\d+) kB/m.exec(rollup);
			if (pss) total += Number(pss[1]) * 1024;
		} catch {
			// process exited mid-scan, or smaps_rollup is unreadable
		}
	}
	return total;
}

/** Current charged bytes for a container, which counts shared pages once by construction. */
async function cgroupMemoryBytes(scopePath: string): Promise<number> {
	return Number(await readFile(`${scopePath}/memory.current`, 'utf8'));
}

async function cgroupCpuSeconds(scopePath: string): Promise<number> {
	const usage = /usage_usec (\d+)/.exec(await readFile(`${scopePath}/cpu.stat`, 'utf8'));
	if (!usage) throw new Error(`${scopePath}/cpu.stat has no usage_usec`);
	return Number(usage[1]) / 1e6;
}

export async function sampleMemory(targets: ResourceTargets): Promise<Record<string, number>> {
	const memoryBytes: Record<string, number> = {};
	for (const [name, root] of Object.entries(targets.processes)) {
		memoryBytes[name] = await processMemoryBytes(root);
	}
	for (const [name, scope] of Object.entries(targets.cgroups)) {
		memoryBytes[name] = await cgroupMemoryBytes(scope);
	}
	return memoryBytes;
}

/**
 * Peak resident memory per component across a measurement window, sampled every `intervalMs`.
 * An endpoint reading misses a spike that GC or eviction released before the window closed.
 */
export class MemoryPeakSampler {
	private peak: Record<string, number> = {};
	private peakTotal = 0;
	private sum: Record<string, number> = {};
	private samples = 0;
	private running?: Promise<void>;
	private stopped = false;
	private wake?: () => void;
	private error: unknown;

	private targets: ResourceTargets;
	private intervalMs: number;

	constructor(targets: ResourceTargets, intervalMs = 2000) {
		this.targets = targets;
		this.intervalMs = intervalMs;
	}

	start(): void {
		this.running = (async () => {
			while (!this.stopped) {
				const sample = await sampleMemory(this.targets);
				if (this.stopped) break; // a reading taken after the run ended is not part of it
				let total = 0;
				for (const [name, bytes] of Object.entries(sample)) {
					this.peak[name] = Math.max(this.peak[name] ?? 0, bytes);
					this.sum[name] = (this.sum[name] ?? 0) + bytes;
					total += bytes;
				}
				this.samples++;
				this.peakTotal = Math.max(this.peakTotal, total);
				await new Promise<void>((resolve) => {
					this.wake = resolve;
					setTimeout(resolve, this.intervalMs).unref();
				});
			}
		})().catch((error) => {
			// Held for stop(): an unhandled rejection here would exit before teardown runs.
			this.error = error;
		});
	}

	/** `meanBytes` is the steady level: the mean of the window's samples, per component. */
	async stop(): Promise<{
		peakBytes: Record<string, number>;
		peakTotalBytes: number;
		meanBytes: Record<string, number>;
	}> {
		this.stopped = true;
		this.wake?.();
		await this.running;
		if (this.error) throw this.error;
		const meanBytes: Record<string, number> = {};
		for (const [name, sum] of Object.entries(this.sum)) meanBytes[name] = sum / this.samples;
		return { peakBytes: this.peak, peakTotalBytes: this.peakTotal, meanBytes };
	}
}

export async function sampleResources(targets: ResourceTargets): Promise<ResourceSample> {
	const cpuSeconds: Record<string, number> = {};
	for (const [name, root] of Object.entries(targets.processes)) {
		cpuSeconds[name] = await processCpuSeconds(root);
	}
	for (const [name, scope] of Object.entries(targets.cgroups)) {
		cpuSeconds[name] = await cgroupCpuSeconds(scope);
	}

	let redis: ResourceSample['redis'];
	if (targets.redisExec) {
		// Fail closed: a missing snapshot would make the hit-rate delta include setup traffic.
		const { stdout } = await exec(targets.redisExec[0], targets.redisExec.slice(1), { timeout: 60_000 });
		const field = (name: string): number => {
			const match = new RegExp(`^${name}:(\\d+)`, 'm').exec(stdout);
			if (!match) throw new Error(`redis INFO has no ${name}`);
			return Number(match[1]);
		};
		redis = {
			hits: field('keyspace_hits'),
			misses: field('keyspace_misses'),
			evictions: field('evicted_keys'),
			usedMemoryBytes: field('used_memory'),
			keys: Number(/^db0:keys=(\d+)/m.exec(stdout)?.[1] ?? 0),
		};
	}
	return { cpuSeconds, redis, memoryBytes: await sampleMemory(targets) };
}

/**
 * Mean core clock over a measurement window, in GHz.
 *
 * ops-per-CPU-second is not comparable across runs on a machine whose clock moves. A
 * CPU-second is time on-core, not work done: this i7-12700H drops from ~3.4 GHz to ~0.9 GHz
 * when its turbo budget expires, which changes ops-per-CPU-second by 4x with no software
 * change at all — measured, not assumed (the CPU profile's cost mix is identical before,
 * during and after such an episode). Multiplying CPU-seconds by the mean clock gives
 * CPU-cycles, which is frequency-invariant and therefore comparable across runs and targets.
 */
export class ClockProbe {
	private readings: number[] = [];
	private timer?: ReturnType<typeof setInterval>;
	private cpus: number[];

	/** @param cpus CPUs the server runs on; pass onlineCpus() for the whole machine. */
	constructor(cpus: number[]) {
		this.cpus = cpus;
	}

	start(): void {
		this.readings = [];
		this.take();
		this.timer = setInterval(() => this.take(), 200);
		this.timer.unref();
	}

	/** Mean GHz across the window, or 0 when the platform exposes no cpufreq. */
	stop(): number {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
		if (this.readings.length === 0) return 0;
		return this.readings.reduce((a, b) => a + b, 0) / this.readings.length;
	}

	private take(): void {
		let sum = 0;
		let n = 0;
		for (const cpu of this.cpus) {
			try {
				const khz = Number(readFileSync(`/sys/devices/system/cpu/cpu${cpu}/cpufreq/scaling_cur_freq`, 'utf8'));
				if (khz > 0) {
					sum += khz / 1e6;
					n++;
				}
			} catch {
				// no cpufreq for this CPU (offline, or a platform without the sysfs interface)
			}
		}
		if (n > 0) this.readings.push(sum / n);
	}
}

/** Every CPU the kernel exposes a cpufreq interface for. */
export function onlineCpus(): number[] {
	return readdirSync('/sys/devices/system/cpu')
		.filter((e) => /^cpu\d+$/.test(e))
		.map((e) => Number(e.slice(3)))
		.sort((a, b) => a - b);
}

/** Expands a taskset-style CPU list ("0-5", "0,2,4", "0-3,8") to CPU numbers. */
export function parseCpuList(list: string): number[] {
	const cpus: number[] = [];
	for (const part of list.split(',')) {
		const range = /^(\d+)(?:-(\d+))?$/.exec(part.trim());
		if (!range || Number(range[2] ?? range[1]) < Number(range[1])) throw new Error(`bad CPU list "${list}"`);
		const from = Number(range[1]);
		const to = Number(range[2] ?? range[1]);
		for (let cpu = from; cpu <= to; cpu++) cpus.push(cpu);
	}
	return [...new Set(cpus)].sort((a, b) => a - b);
}

export interface ResourceDelta {
	totalCpuSeconds: number;
	/**
	 * Mean core clock over the window, GHz. totalCpuSeconds * meanClockGHz is CPU-gigacycles,
	 * which — unlike CPU-seconds — means the same thing across runs on a machine that throttles.
	 * 0 when the platform exposes no cpufreq, in which case callers fall back to CPU-seconds.
	 */
	meanClockGHz: number;
	/**
	 * Resident bytes by component at the end of the window. A level rather than a delta: what
	 * matters is how much memory each architecture holds to sustain the workload.
	 */
	memoryBytes: Record<string, number>;
	totalMemoryBytes: number;
	byComponent: Record<string, number>;
	redisHits: number;
	redisMisses: number;
	redisEvictions: number;
}

export function diffResources(before: ResourceSample, after: ResourceSample): ResourceDelta {
	const byComponent: Record<string, number> = {};
	let totalCpuSeconds = 0;
	for (const name of Object.keys(after.cpuSeconds)) {
		// Harper and the Fastify cluster are restarted per workload, so a counter can
		// legitimately move backwards between targets; clamp rather than go negative.
		const delta = Math.max(0, (after.cpuSeconds[name] ?? 0) - (before.cpuSeconds[name] ?? 0));
		byComponent[name] = delta;
		totalCpuSeconds += delta;
	}
	const memoryBytes = after.memoryBytes ?? {};
	return {
		totalCpuSeconds,
		meanClockGHz: 0,
		memoryBytes,
		totalMemoryBytes: Object.values(memoryBytes).reduce((a, b) => a + b, 0),
		byComponent,
		redisHits: Math.max(0, (after.redis?.hits ?? 0) - (before.redis?.hits ?? 0)),
		redisMisses: Math.max(0, (after.redis?.misses ?? 0) - (before.redis?.misses ?? 0)),
		redisEvictions: Math.max(0, (after.redis?.evictions ?? 0) - (before.redis?.evictions ?? 0)),
	};
}
