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
import { join } from 'node:path';
import { readFileSync, readdirSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

/** CLOCK_TICKS per second; 100 on every Linux this benchmark targets. */
const USER_HZ = 100;

export interface ResourceSample {
	/** Server-side CPU seconds consumed, by component. Excludes the load generator. */
	cpuSeconds: Record<string, number>;
	/** Redis hit/miss counters, when a Redis is part of the target. */
	redis?: { hits: number; misses: number; evictions: number };
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
				maxKHz: Number(readFileSync(`${base}/cpufreq/cpuinfo_max_freq`, 'utf8')),
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
 */
export async function writePinnedRuntime(dir: string, cpus: number[]): Promise<string> {
	const path = join(dir, '.pinned-node.sh');
	await mkdir(dir, { recursive: true });
	await writeFile(path, `#!/bin/sh\nexec taskset -c ${cpus.join(',')} ${JSON.stringify(process.execPath)} "$@"\n`);
	await chmod(path, 0o755);
	return path;
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
	try {
		return Number(await readFile(`${scopePath}/memory.current`, 'utf8'));
	} catch {
		return 0;
	}
}

async function cgroupCpuSeconds(scopePath: string): Promise<number> {
	try {
		const stat = await readFile(`${scopePath}/cpu.stat`, 'utf8');
		const usage = /usage_usec (\d+)/.exec(stat);
		return usage ? Number(usage[1]) / 1e6 : 0;
	} catch {
		return 0;
	}
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
	private running?: Promise<void>;
	private stopped = false;

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
				let total = 0;
				for (const [name, bytes] of Object.entries(sample)) {
					this.peak[name] = Math.max(this.peak[name] ?? 0, bytes);
					total += bytes;
				}
				this.peakTotal = Math.max(this.peakTotal, total);
				await new Promise((resolve) => setTimeout(resolve, this.intervalMs).unref());
			}
		})();
	}

	async stop(): Promise<{ peakBytes: Record<string, number>; peakTotalBytes: number }> {
		this.stopped = true;
		await this.running;
		return { peakBytes: this.peak, peakTotalBytes: this.peakTotal };
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
		const { stdout } = await exec(targets.redisExec[0], targets.redisExec.slice(1));
		const field = (name: string): number => {
			const match = new RegExp(`^${name}:(\\d+)`, 'm').exec(stdout);
			if (!match) throw new Error(`redis INFO has no ${name}`);
			return Number(match[1]);
		};
		redis = { hits: field('keyspace_hits'), misses: field('keyspace_misses'), evictions: field('evicted_keys') };
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
		const [from, to] = part.split('-').map(Number);
		for (let cpu = from; cpu <= (to ?? from); cpu++) cpus.push(cpu);
	}
	return cpus;
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
