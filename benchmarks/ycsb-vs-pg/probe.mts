/**
 * The target side of a measurement, wherever the target runs.
 *
 * A measured window needs readings that only the host running a component can take: its cgroup's
 * CPU and memory, perf counters on its cgroups, its threads' affinity, the rest of that host's load.
 * localProbe takes them with resources.mts and perfProfile.mts on this host (single-host mode, and a
 * target agent for the components it runs); remote.mts proxies the same interface to an agent, and
 * compositeProbe merges several hosts' probes for a target split across hosts. A window's readings
 * are taken in one beginWindow and one endWindow call per host, so nothing crosses the network while
 * the window runs except the load itself.
 */
import {
	ClockProbe,
	MemoryPeakSampler,
	readCgroupMemory,
	sampleResources,
	startHostLoad,
	totalCpuSeconds,
	verifyAffinity,
	type CgroupMemory,
	type HostLoad,
	type MemoryPeaks,
	type ResourceSample,
	type ResourceTargets,
} from './resources.mts';
import { foldPerfScript, startCounters, startRecord, type Counters } from './perfProfile.mts';
import { readRocksdbEvents, type RocksdbEvent } from './rocksdbLog.mts';

export interface WindowOptions {
	/** Hardware counters per component cgroup (true), or over the target cpus as a whole ('host'). */
	counters?: boolean | 'host';
	memory?: boolean;
	clock?: boolean;
	refaults?: boolean;
	/** `perf record` the target's cpus into `<prefix>.perf.data` (a path on the host running the probe). */
	recordPrefix?: string;
	/** Take the CPU baseline once perf is counting (profile windows), not before it starts (measured windows). */
	baselineAfterPerf?: boolean;
}

export interface WindowReading {
	before: ResourceSample;
	after: ResourceSample;
	/** Mean core clock (cpufreq), 0 where the platform has none. */
	meanClockGHz: number;
	memory?: MemoryPeaks;
	/** The rest of the host(s) during the window; with several hosts, otherCores is the busiest one's. */
	host: HostLoad;
	/** Per host, when the target spans hosts. */
	hosts?: Record<string, HostLoad>;
	perf?: Record<string, Counters>;
	refaultFilePages?: Record<string, number>;
	cgroupMemory: Record<string, CgroupMemory>;
}

export interface TargetProbe {
	/** Component names (cgroups) this probe measures. */
	readonly components: string[];
	readonly hasRedis: boolean;
	/** Fails unless every thread of every pinned component runs on its host's target cpus; returns threads checked. */
	verifyPlacement(): Promise<number>;
	sample(): Promise<ResourceSample>;
	cpuSeconds(): Promise<number>;
	cgroupMemory(): Promise<Record<string, CgroupMemory>>;
	beginWindow(options: WindowOptions): Promise<void>;
	/** Closes the open window and stops every instrument it started, also when a reading fails. */
	endWindow(): Promise<WindowReading>;
	/** Folds `<prefix>.perf.data` into `<prefix>.<component>.folded` files; returns samples per component. */
	fold(prefix: string): Promise<Record<string, number>>;
	/** Harper: RocksDB flush and compaction events between two epoch ms. */
	rocksdbEvents?(fromMs: number, toMs: number): Promise<RocksdbEvent[]>;
}

export interface LocalProbeSpec {
	targets: ResourceTargets;
	/** Component name -> root PID whose threads must all run on `cpus`. */
	pinned: Record<string, number>;
	cpus: number[];
	/** perf's control FIFOs go here. */
	workDir: string;
	/** Harper's install directory, whose RocksDB LOGs rocksdbEvents reads. */
	dataRoot?: string;
	/** A target agent: its own cgroup is reported as agentCores, apart from the target and the rest. */
	separateSelf?: boolean;
}

export function localProbe(spec: LocalProbeSpec): TargetProbe {
	const { targets, pinned, cpus, workDir, dataRoot, separateSelf } = spec;
	const cgroupMemory = async () => {
		const out: Record<string, CgroupMemory> = {};
		for (const [name, scope] of Object.entries(targets.cgroups)) out[name] = await readCgroupMemory(scope);
		return out;
	};
	const refaults = async () => {
		const pages: Record<string, number> = {};
		for (const [name, memory] of Object.entries(await cgroupMemory())) pages[name] = memory.workingsetRefaultFile;
		return pages;
	};
	let opening = false;
	let closing = false;
	let open:
		| {
				memory?: MemoryPeakSampler;
				clock?: ClockProbe;
				before: ResourceSample;
				host: ReturnType<typeof startHostLoad>;
				counters?: Awaited<ReturnType<typeof startCounters>>;
				recorder?: Awaited<ReturnType<typeof startRecord>>;
				refaultsBefore?: Record<string, number>;
		  }
		| undefined;
	return {
		components: Object.keys(targets.cgroups),
		hasRedis: Boolean(targets.redisExec),
		async verifyPlacement() {
			let threads = 0;
			for (const [name, pid] of Object.entries(pinned)) threads += verifyAffinity(name, pid, cpus);
			return threads;
		},
		sample: () => sampleResources(targets),
		cpuSeconds: () => totalCpuSeconds(targets),
		cgroupMemory,
		async beginWindow(options) {
			if (open || opening || closing) throw new Error('a measured window is already open');
			opening = true;
			const memory = options.memory ? new MemoryPeakSampler(targets) : undefined;
			const clock = options.clock ? new ClockProbe(cpus) : undefined;
			let counters: Awaited<ReturnType<typeof startCounters>> | undefined;
			let recorder: Awaited<ReturnType<typeof startRecord>> | undefined;
			const startPerf = async () => {
				if (options.counters)
					counters = await startCounters(targets.cgroups, workDir, options.counters === 'host' ? cpus : undefined);
				if (options.recordPrefix) recorder = await startRecord(cpus, `${options.recordPrefix}.perf.data`);
			};
			try {
				let before: ResourceSample;
				let host: ReturnType<typeof startHostLoad>;
				// A profile window's CPU baseline follows perf's start, so the ops it divides by are all counted.
				if (options.baselineAfterPerf) {
					await startPerf();
					before = await sampleResources(targets);
					host = startHostLoad(targets, { separateSelf });
				} else {
					before = await sampleResources(targets);
					host = startHostLoad(targets, { separateSelf });
					await startPerf();
				}
				const refaultsBefore = options.refaults ? await refaults() : undefined;
				memory?.start();
				clock?.start();
				open = { memory, clock, before, host, counters, recorder, refaultsBefore };
			} catch (error) {
				// Nothing of a window that did not open may keep running.
				await counters?.stop().catch(() => {});
				await recorder?.stop().catch(() => {});
				throw error;
			} finally {
				opening = false;
			}
		},
		async endWindow() {
			const window = open;
			if (!window) throw new Error('no measured window is open');
			open = undefined;
			// Until its instruments have stopped, no other window may start (two perf sessions would overlap).
			closing = true;
			try {
				let refaultFilePages: Record<string, number> | undefined;
				let meanClockGHz = 0;
				let after: ResourceSample;
				let perf: Record<string, Counters> | undefined;
				let memory: MemoryPeaks | undefined;
				try {
					if (window.refaultsBefore) {
						refaultFilePages = {};
						for (const [name, pages] of Object.entries(await refaults()))
							refaultFilePages[name] = pages - window.refaultsBefore[name];
					}
					meanClockGHz = window.clock?.stop() ?? 0;
					// CPU first: stopping the sampler can wait out its interval, and background work in that gap
					// would be charged to the run.
					after = await sampleResources(targets);
					if (window.counters) {
						const counters = window.counters;
						window.counters = undefined;
						perf = await counters.stop();
					}
					if (window.recorder) {
						const recorder = window.recorder;
						window.recorder = undefined;
						await recorder.stop();
					}
				} finally {
					window.clock?.stop();
					// A failed window must not leave a system-wide perf running into the next sample.
					await window.counters?.stop().catch(() => {});
					await window.recorder?.stop().catch(() => {});
					memory = await window.memory?.stop();
				}
				return {
					before: window.before,
					after,
					meanClockGHz,
					memory,
					host: await window.host.stop(),
					perf,
					refaultFilePages,
					cgroupMemory: await cgroupMemory(),
				};
			} finally {
				closing = false;
			}
		},
		fold: (prefix) => foldPerfScript(`${prefix}.perf.data`, targets.cgroups, prefix),
		rocksdbEvents: dataRoot ? (fromMs, toMs) => readRocksdbEvents(dataRoot, fromMs, toMs) : undefined,
	};
}

/** Maps of disjoint components (each runs on one host) merged into one. */
function mergeMaps<T>(maps: (Record<string, T> | undefined)[]): Record<string, T> {
	return Object.assign({}, ...maps.filter(Boolean));
}

function mergeSamples(samples: ResourceSample[]): ResourceSample {
	return {
		cpuSeconds: mergeMaps(samples.map((s) => s.cpuSeconds)),
		memoryBytes: mergeMaps(samples.map((s) => s.memoryBytes)),
		redis: samples.find((s) => s.redis)?.redis,
	};
}

/**
 * The highest simultaneous total across hosts sampled on their own timers: at every sample instant,
 * each host contributes its latest reading at or before it (wall clocks, NTP-synced across VMs), so
 * the result is a sum that existed within one sampling interval, never a sum of peaks that did not
 * coincide.
 */
export function alignedPeakTotal(timelines: [number, number][][]): number {
	const series = timelines.filter((t) => t.length > 0).map((t) => [...t].sort((a, b) => a[0] - b[0]));
	const instants = [...new Set(series.flatMap((t) => t.map(([at]) => at)))].sort((a, b) => a - b);
	let peak = 0;
	for (const instant of instants) {
		let total = 0;
		for (const t of series) {
			let latest: number | undefined;
			for (const [at, bytes] of t) {
				if (at > instant) break;
				latest = bytes;
			}
			total += latest ?? t[0][1];
		}
		peak = Math.max(peak, total);
	}
	return peak;
}

function mergeMemory(peaks: MemoryPeaks[]): MemoryPeaks {
	return {
		peakBytes: mergeMaps(peaks.map((p) => p.peakBytes)),
		meanBytes: mergeMaps(peaks.map((p) => p.meanBytes)),
		peakTotalBytes: alignedPeakTotal(peaks.map((p) => p.timeline)),
		timeline: peaks.flatMap((p) => p.timeline).sort((a, b) => a[0] - b[0]),
	};
}

/** The quiet test applies to every host, so the merged load is the busiest host's, with each kept. */
export function mergeHostLoads(byHost: Record<string, HostLoad>): HostLoad {
	const loads = Object.values(byHost);
	const sum = (pick: (l: HostLoad) => number | undefined) => loads.reduce((a, l) => a + (pick(l) ?? 0), 0);
	return {
		loadavg1: Math.max(...loads.map((l) => l.loadavg1)),
		otherCores: Math.max(...loads.map((l) => l.otherCores)),
		ownCores: sum((l) => l.ownCores),
		...(loads.some((l) => l.agentCores !== undefined) ? { agentCores: sum((l) => l.agentCores) } : {}),
	};
}

export function mergeReadings(byHost: Record<string, WindowReading>): WindowReading {
	const readings = Object.values(byHost);
	const clocks = readings.map((r) => r.meanClockGHz).filter((ghz) => ghz > 0);
	const memories = readings.map((r) => r.memory).filter((m): m is MemoryPeaks => m !== undefined);
	const hosts = Object.fromEntries(Object.entries(byHost).map(([name, r]) => [name, r.host]));
	return {
		before: mergeSamples(readings.map((r) => r.before)),
		after: mergeSamples(readings.map((r) => r.after)),
		meanClockGHz: clocks.length ? clocks.reduce((a, b) => a + b, 0) / clocks.length : 0,
		memory: memories.length ? mergeMemory(memories) : undefined,
		host: mergeHostLoads(hosts),
		hosts,
		perf: readings.some((r) => r.perf) ? mergeMaps(readings.map((r) => r.perf)) : undefined,
		refaultFilePages: readings.some((r) => r.refaultFilePages)
			? mergeMaps(readings.map((r) => r.refaultFilePages))
			: undefined,
		cgroupMemory: mergeMaps(readings.map((r) => r.cgroupMemory)),
	};
}

/** One probe over a target whose components run on several hosts (topology b), keyed by host role. */
export function compositeProbe(byHost: Record<string, TargetProbe>): TargetProbe {
	const entries = Object.entries(byHost);
	const all = <T,>(call: (probe: TargetProbe) => Promise<T>) => Promise.all(entries.map(([, probe]) => call(probe)));
	const withRocksdb = entries.find(([, probe]) => probe.rocksdbEvents);
	return {
		components: entries.flatMap(([, probe]) => probe.components),
		hasRedis: entries.some(([, probe]) => probe.hasRedis),
		verifyPlacement: async () => (await all((p) => p.verifyPlacement())).reduce((a, b) => a + b, 0),
		sample: async () => mergeSamples(await all((p) => p.sample())),
		cpuSeconds: async () => (await all((p) => p.cpuSeconds())).reduce((a, b) => a + b, 0),
		cgroupMemory: async () => mergeMaps(await all((p) => p.cgroupMemory())),
		async beginWindow(options) {
			const started = await Promise.allSettled(entries.map(([, probe]) => probe.beginWindow(options)));
			const failed = started.find((s): s is PromiseRejectedResult => s.status === 'rejected');
			if (failed) {
				await Promise.allSettled(
					entries.filter((_, i) => started[i].status === 'fulfilled').map(([, probe]) => probe.endWindow())
				);
				throw failed.reason;
			}
		},
		async endWindow() {
			const ended = await Promise.allSettled(entries.map(([, probe]) => probe.endWindow()));
			const failed = ended.find((s): s is PromiseRejectedResult => s.status === 'rejected');
			if (failed) throw failed.reason;
			return mergeReadings(
				Object.fromEntries(
					entries.map(([name], i) => [name, (ended[i] as PromiseFulfilledResult<WindowReading>).value])
				)
			);
		},
		fold: async (prefix) => mergeMaps(await all((p) => p.fold(prefix))),
		rocksdbEvents: withRocksdb ? (fromMs, toMs) => withRocksdb[1].rocksdbEvents!(fromMs, toMs) : undefined,
	};
}
