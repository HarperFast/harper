/**
 * Hardware counters and sampled CPU profiles of a target's processes, through `perf`.
 *
 * Both work on cgroups rather than PIDs, so every process of a target is covered (the Fastify
 * cluster's workers, Postgres backends forked per connection, Redis in its container) and nothing
 * else on the target cores is. Needs kernel.perf_event_paranoid <= 0 for system-wide events.
 *
 * Instructions per op barely move under SMT contention or preemption from other work on the host,
 * which dominate the rep-to-rep noise of CPU seconds; cycles per op and IPC show what they cost.
 */
import { spawn, execFile } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { open, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';

const exec = promisify(execFile);

/** Flags that make V8 publish JIT symbols (/tmp/perf-<pid>.map) and keep interpreted frames on the native stack. */
export const PERF_NODE_OPTIONS = '--perf-basic-prof --interpreted-frames-native-stack';

// The target cores are P-cores (chooseCpuSets), so the hybrid PMU's cpu_core events cover them.
const COUNTERS = {
	instructionsUser: 'cpu_core/instructions/u',
	instructionsKernel: 'cpu_core/instructions/k',
	cyclesUser: 'cpu_core/cycles/u',
	cyclesKernel: 'cpu_core/cycles/k',
	contextSwitches: 'context-switches',
	cpuMigrations: 'cpu-migrations',
	pageFaults: 'page-faults',
} as const;
export type Counters = Record<keyof typeof COUNTERS, number>;

/** perf names a cgroup by its path under the cgroup2 mount. */
const perfCgroupName = (scopePath: string): string => scopePath.replace(/^\/sys\/fs\/cgroup\/?/, '');

/** Parses `perf stat -x, --for-each-cgroup` output into counters per cgroup path. */
export function parsePerfStat(output: string): Record<string, Counters> {
	const byEvent = Object.fromEntries(Object.entries(COUNTERS).map(([key, event]) => [event, key])) as Record<
		string,
		keyof Counters
	>;
	const out: Record<string, Counters> = {};
	for (const line of output.split('\n')) {
		const [value, , event, cgroup] = line.split(',');
		const key = byEvent[event];
		if (!key || cgroup === undefined) continue;
		if (!/^\d+$/.test(value)) throw new Error(`perf stat could not count ${event} for ${cgroup}: ${line}`);
		(out[cgroup] ??= {} as Counters)[key] = Number(value);
	}
	return out;
}

/**
 * Starts `perf <args>` with its events disabled and enables them through a control FIFO, returning
 * only once perf acknowledges: setup (synthesizing every process on the host) can take a second,
 * which would otherwise be cut out of the start of the window.
 */
async function startEnabled(args: string[], dir: string): Promise<{ stop(): Promise<string> }> {
	const ctl = join(dir, `.perf-ctl-${process.pid}-${++fifoCount}`);
	const ack = `${ctl}-ack`;
	await exec('mkfifo', [ctl, ack]);
	const [command, ...rest] = args;
	const proc = spawn('perf', [command, '-D', '-1', '--control', `fifo:${ctl},${ack}`, ...rest], {
		stdio: ['ignore', 'ignore', 'pipe'],
	});
	let err = '';
	proc.stderr.on('data', (d) => (err += d));
	const exited = new Promise<void>((resolve) => proc.once('close', () => resolve()));
	const cleanup = () => Promise.all([rm(ctl, { force: true }), rm(ack, { force: true })]);
	try {
		// perf opens both FIFOs at startup; until it does, these opens block (on the thread pool).
		const [ctlHandle, ackHandle] = await Promise.race([
			Promise.all([open(ctl, 'w'), open(ack, 'r')]),
			exited.then(() => Promise.reject(new Error(`perf ${command} exited at startup: ${err.slice(0, 400)}`))),
		]);
		try {
			await ctlHandle.write('enable\n');
			const { bytesRead, buffer } = await ackHandle.read(Buffer.alloc(16), 0, 16);
			if (!buffer.toString('utf8', 0, bytesRead).startsWith('ack'))
				throw new Error(`perf ${command} did not ack enable`);
		} finally {
			await ctlHandle.close();
			await ackHandle.close();
		}
	} catch (error) {
		proc.kill('SIGKILL');
		await cleanup();
		throw error;
	}
	return {
		async stop() {
			proc.kill('SIGINT');
			await exited;
			await cleanup();
			return err;
		},
	};
}
let fifoCount = 0;

/** Counts over a window, per component; `dir` holds the control FIFOs. */
export async function startCounters(
	cgroups: Record<string, string>,
	dir: string
): Promise<{ stop(): Promise<Record<string, Counters>> }> {
	const names = Object.entries(cgroups).map(([component, scope]) => [component, perfCgroupName(scope)]);
	const perf = await startEnabled(
		[
			'stat',
			'-a',
			'-x',
			',',
			'-e',
			Object.values(COUNTERS).join(','),
			'--for-each-cgroup',
			names.map(([, name]) => name).join(','),
		],
		dir
	);
	return {
		async stop() {
			const err = await perf.stop();
			const parsed = parsePerfStat(err);
			const out: Record<string, Counters> = {};
			for (const [component, name] of names) {
				const counters = parsed[name];
				if (!counters || Object.keys(counters).length !== Object.keys(COUNTERS).length) {
					throw new Error(`perf stat gave no complete counters for ${component}: ${err.slice(0, 400)}`);
				}
				out[component] = counters;
			}
			return out;
		},
	};
}

export function sumCounters(byComponent: Record<string, Counters>): Counters {
	const total = Object.fromEntries(Object.keys(COUNTERS).map((k) => [k, 0])) as Counters;
	for (const counters of Object.values(byComponent))
		for (const key of Object.keys(total) as (keyof Counters)[]) total[key] += counters[key];
	return total;
}

/** Samples the target cores with call graphs, tagged by cgroup so other work on them can be dropped. */
export async function startRecord(cpus: number[], file: string, frequency = 999): Promise<{ stop(): Promise<void> }> {
	const perf = await startEnabled(
		[
			'record',
			'-C',
			cpus.join(','),
			'-e',
			'cpu_core/cycles/',
			'--all-cgroups',
			'-g',
			'-F',
			String(frequency),
			'-o',
			file,
			'--',
			'sleep',
			'86400',
		],
		dirname(file)
	);
	return {
		async stop() {
			const err = await perf.stop();
			if (!/Captured and wrote/.test(err)) throw new Error(`perf record failed: ${err.slice(0, 400)}`);
		},
	};
}

/**
 * One sample's stack from `perf script -F comm,tid,cgroup,ip,sym,dso` output, root first, each
 * frame "sym (dso basename)". Unknown symbols keep the DSO so native libraries still attribute.
 */
export function frameName(line: string): string {
	const match = /^\s*([0-9a-f]+)\s+(.*?)\s+\(([^)]*)\)\s*$/.exec(line);
	if (!match) return line.trim();
	const [, ip, sym, dso] = match;
	// Kernel symbols are hidden unless kptr_restrict=0; the libc syscall frame above names the call.
	if (sym === '[unknown]' && ip.length === 16 && ip.startsWith('ffff')) return '[kernel]';
	const lib = dso.slice(dso.lastIndexOf('/') + 1);
	// JIT map entries carry the source location after the name; the map file is per-pid noise.
	if (lib.startsWith('perf-') && lib.endsWith('.map')) return sym.replace(/^JS:/, '');
	return sym === '[unknown]' ? `[${lib}]` : `${sym.replace(/\+0x[0-9a-f]+$/, '')} (${lib})`;
}

/**
 * Folds `perf script` output into "frame;frame;... count" lines per component, keeping only
 * samples whose cgroup belongs to the run. Returns the folded text and sample counts.
 */
export async function foldPerfScript(
	perfData: string,
	cgroups: Record<string, string>,
	outPrefix: string
): Promise<Record<string, number>> {
	const byName = new Map(Object.entries(cgroups).map(([component, scope]) => [`/${perfCgroupName(scope)}`, component]));
	// --no-inline: resolving inlined frames runs addr2line per address over node's debug info (minutes).
	const proc = spawn('perf', ['script', '--no-inline', '-i', perfData, '-F', 'comm,tid,cgroup,ip,sym,dso'], {
		stdio: ['ignore', 'pipe', 'ignore'],
	});
	const stacks: Record<string, Map<string, number>> = Object.fromEntries(
		Object.keys(cgroups).map((c) => [c, new Map<string, number>()])
	);
	let component: string | undefined;
	let comm = '';
	let frames: string[] = [];
	const flush = () => {
		if (component && frames.length > 0) {
			const key = [comm, ...frames.reverse()].join(';');
			stacks[component].set(key, (stacks[component].get(key) ?? 0) + 1);
		}
		component = undefined;
		frames = [];
	};
	for await (const line of createInterface({ input: proc.stdout!, crlfDelay: Infinity })) {
		if (line === '') {
			flush();
		} else if (!/^\s/.test(line)) {
			flush();
			// "<comm> <tid> <cgroup>": comm may contain spaces, the cgroup path cannot.
			const parts = line.trim().split(/\s+/);
			component = byName.get(parts[parts.length - 1]);
			// Thread names are per worker ("node-MainThread", "WorkerThread"...); a component's
			// process name is what matters for a stack, the thread kind for the bucket.
			comm = parts
				.slice(0, -2)
				.join(' ')
				.replace(/[;\s]+/g, '_');
		} else if (component) {
			frames.push(frameName(line).replace(/;/g, ','));
		}
	}
	flush();
	await new Promise((resolve) => proc.once('close', resolve));
	const counts: Record<string, number> = {};
	for (const [name, folded] of Object.entries(stacks)) {
		let total = 0;
		const lines: string[] = [];
		for (const [stack, count] of folded) {
			lines.push(`${stack} ${count}`);
			total += count;
		}
		counts[name] = total;
		await writeFile(`${outPrefix}.${name}.folded`, lines.join('\n') + '\n');
	}
	return counts;
}

/** Reads a folded-stack file back. */
export async function readFolded(path: string): Promise<{ stack: string[]; count: number }[]> {
	const out: { stack: string[]; count: number }[] = [];
	for await (const line of createInterface({ input: createReadStream(path), crlfDelay: Infinity })) {
		const at = line.lastIndexOf(' ');
		if (at > 0) out.push({ stack: line.slice(0, at).split(';'), count: Number(line.slice(at + 1)) });
	}
	return out;
}

export async function perfAvailable(): Promise<void> {
	const paranoid = Number(await readFile('/proc/sys/kernel/perf_event_paranoid', 'utf8'));
	if (paranoid > 0) throw new Error(`profiling needs kernel.perf_event_paranoid <= 0 (it is ${paranoid})`);
	await exec('perf', ['--version']);
}
