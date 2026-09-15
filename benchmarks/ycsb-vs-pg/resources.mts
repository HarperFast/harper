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

export interface ResourceDelta {
	totalCpuSeconds: number;
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
		byComponent,
		redisHits: Math.max(0, (after.redis?.hits ?? 0) - (before.redis?.hits ?? 0)),
		redisMisses: Math.max(0, (after.redis?.misses ?? 0) - (before.redis?.misses ?? 0)),
	};
}
