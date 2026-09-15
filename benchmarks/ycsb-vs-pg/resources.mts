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
 * Host processes are matched from /proc; containers are read from their cgroup,
 * because Postgres backends fork per connection and would otherwise be missed.
 */
import { readFile, readdir } from 'node:fs/promises';
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
	redis?: { hits: number; misses: number };
}

export interface ResourceTargets {
	/** Substrings matched against process cmdlines, keyed by component name. */
	processes: Record<string, string>;
	/** Container cgroup scope paths, keyed by component name. */
	cgroups: Record<string, string>;
	/** Set when the target includes Redis, so hit rate can be sampled. */
	redisExec?: string[];
}

async function processCpuSeconds(pattern: string): Promise<number> {
	let total = 0;
	for (const entry of await readdir('/proc')) {
		if (!/^\d+$/.test(entry)) continue;
		try {
			const cmdline = (await readFile(`/proc/${entry}/cmdline`)).toString().replace(/\0/g, ' ');
			if (!cmdline.includes(pattern)) continue;
			const stat = await readFile(`/proc/${entry}/stat`, 'utf8');
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
 * Pin every thread of the matching processes to `cpuList`.
 *
 * This box is a hybrid i7-12700H: cpu0-11 are hyperthread siblings of 6 P-cores, cpu12-19 are
 * 8 slower E-cores, and it runs thermally throttled. CPU-seconds are therefore not a fixed unit
 * of work — a thread on an E-core, or sharing a physical core with its hyperthread sibling,
 * bills full CPU-seconds for a fraction of the throughput. Left to the scheduler, the same
 * benchmark varied by 3.5x in ops-per-CPU-second purely on placement. Pinning the server and
 * the load generator to disjoint, homogeneous sets makes the unit stable across runs.
 */
export async function pinProcesses(pattern: string, cpuList: string): Promise<number> {
	let pinned = 0;
	for (const entry of await readdir('/proc')) {
		if (!/^\d+$/.test(entry)) continue;
		try {
			const cmdline = (await readFile(`/proc/${entry}/cmdline`)).toString().replace(/\0/g, ' ');
			if (!cmdline.includes(pattern)) continue;
			// -a applies to all current threads; threads created later inherit the parent's affinity.
			await exec('taskset', ['-acp', cpuList, entry]);
			pinned++;
		} catch {
			// process exited mid-scan, or has no threads left to pin
		}
	}
	return pinned;
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

export async function sampleResources(targets: ResourceTargets): Promise<ResourceSample> {
	const cpuSeconds: Record<string, number> = {};
	for (const [name, pattern] of Object.entries(targets.processes)) {
		cpuSeconds[name] = await processCpuSeconds(pattern);
	}
	for (const [name, scope] of Object.entries(targets.cgroups)) {
		cpuSeconds[name] = await cgroupCpuSeconds(scope);
	}

	let redis: ResourceSample['redis'];
	if (targets.redisExec) {
		try {
			const { stdout } = await exec(targets.redisExec[0], targets.redisExec.slice(1));
			const hits = /keyspace_hits:(\d+)/.exec(stdout);
			const misses = /keyspace_misses:(\d+)/.exec(stdout);
			redis = { hits: Number(hits?.[1] ?? 0), misses: Number(misses?.[1] ?? 0) };
		} catch {
			// leave undefined; a failed stats read should not abort a benchmark
		}
	}
	return { cpuSeconds, redis };
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
	byComponent: Record<string, number>;
	redisHits: number;
	redisMisses: number;
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
	return {
		totalCpuSeconds,
		meanClockGHz: 0,
		byComponent,
		redisHits: Math.max(0, (after.redis?.hits ?? 0) - (before.redis?.hits ?? 0)),
		redisMisses: Math.max(0, (after.redis?.misses ?? 0) - (before.redis?.misses ?? 0)),
	};
}
