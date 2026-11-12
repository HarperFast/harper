/**
 * Target agent: runs on a target host in remote mode (remote.mts) and does everything there that
 * single-host mode does in-process, with the same code: `withTarget` launches a part (Harper, the
 * whole stack, or some of its services) in its capped scopes and containers, and its probe takes the
 * part's readings. The orchestrator drives it over stdio (rpc.mts), normally through ssh.
 *
 * One agent per host (a lock under the system tmpdir), and it owns that host's benchmark processes:
 * at init it stops scopes and containers an earlier agent left, and when the channel closes or it is
 * signalled it stops every part it started before exiting.
 *
 *   node benchmarks/ycsb-vs-pg/targetAgent.mts      (stdin: requests, stdout: response frames)
 */
import { readFile, rm, mkdir } from 'node:fs/promises';
import { readFileSync, existsSync } from 'node:fs';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { hostname, release, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { serveRpc } from './rpc.mts';
import { pingPong, startEchoServer } from './rtt.mts';
import {
	RESULTS_DIR,
	TARGETS,
	buildDigests,
	gitRevision,
	prepareTargetHost,
	withTarget,
	type AuthMode,
	type LaunchOptions,
	type Running,
	type Session,
	type TargetName,
} from './run-compare.mts';
import {
	foreignProcessesInOwnCgroup,
	pinPid,
	readTopology,
	targetHostCpus,
	waitForQuietHost,
	type CpuTopology,
} from './resources.mts';
import { detectPmu, perfAvailable } from './perfProfile.mts';
import {
	composeDownProject,
	dataDirBytes,
	removePgSnapshots,
	runningProjectContainers,
	dataDir,
	type StackMemory,
} from './pgStack.mts';
import type { WindowOptions } from './probe.mts';
import { AGENT_DATA_PREFIX, type HostInfo, type PartDescriptor } from './remote.mts';

const exec = promisify(execFile);
const REPO_ROOT = join(import.meta.dirname, '..', '..');
/** Read before prepareTargetHost points TMPDIR into the data dir: every agent on a host must lock the same file. */
const LOCK_PATH = join(tmpdir(), 'ycsb-vs-pg-agent.lock');
const UNIT_PREFIX = 'ycsb-vs-pg-agent-';

interface AgentInit {
	options: Session['options'];
	cache: Session['cache'];
	recordCacheSize: number;
	harperMemoryBytes: number;
	stackMemory: Record<'pg-redis' | 'pg-only', StackMemory>;
	profileOps?: number;
	perfCounters: boolean;
	auth: AuthMode;
	jwtSecret?: string;
	targetCpus: number;
	serverCpus?: number[];
	bind?: string;
	dataDir?: string;
	requireMount?: string;
	baseHarperBin?: string;
}

export interface Parked<R> {
	running: R;
	/** Releases the parked body and waits for the launch's own teardown. */
	stop(): Promise<void>;
}

/**
 * Starts `launch` with a body that parks until stop(): the launch's setup, and later its teardown,
 * are exactly what they are in single-host mode. Rejects if the launch fails before it is ready.
 */
export async function park<R>(launch: (body: (running: R) => Promise<void>) => Promise<unknown>): Promise<Parked<R>> {
	let release!: () => void;
	const released = new Promise<void>((resolve) => (release = resolve));
	let ready!: (running: R) => void;
	const readied = new Promise<R>((resolve) => (ready = resolve));
	const done = launch(async (running) => {
		ready(running);
		await released;
	});
	const running = await Promise.race([
		readied,
		done.then(() => {
			throw new Error('the target stopped before it was ready');
		}),
	]);
	let stopping: Promise<void> | undefined;
	return {
		running,
		stop() {
			release();
			return (stopping ??= done.then(() => {}));
		},
	};
}

/** Runs lifecycle changes one at a time, in order, whatever the previous one did. */
export function serialQueue(): <T>(task: () => Promise<T>) => Promise<T> {
	let tail: Promise<unknown> = Promise.resolve();
	return (task) => {
		const run = tail.then(task, task);
		tail = run.catch(() => {});
		return run;
	};
}

function cpusOffCores(topology: CpuTopology[], server: number[]): number[] {
	const used = new Set(topology.filter((t) => server.includes(t.cpu)).map((t) => t.siblings.join(',')));
	return topology.filter((t) => !used.has(t.siblings.join(','))).map((t) => t.cpu);
}

async function findMount(path: string): Promise<HostInfo['dataMount']> {
	try {
		const { stdout } = await exec('findmnt', ['-n', '-o', 'TARGET,SOURCE,FSTYPE', '-T', path], { timeout: 30_000 });
		const [target, source, fstype] = stdout.trim().split(/\s+/);
		return { target, source, fstype };
	} catch {
		return undefined;
	}
}

/** Instance facts from the GCP metadata server, absent off GCP. Never `attributes`: they hold the ssh keys. */
async function gcpMetadata(): Promise<Record<string, unknown> | undefined> {
	try {
		const response = await fetch('http://metadata.google.internal/computeMetadata/v1/instance/?recursive=true', {
			headers: { 'Metadata-Flavor': 'Google' },
			signal: AbortSignal.timeout(2000),
		});
		if (!response.ok) return undefined;
		const instance = (await response.json()) as Record<string, any>;
		const last = (path: unknown) => (typeof path === 'string' ? path.slice(path.lastIndexOf('/') + 1) : undefined);
		return {
			name: instance.name,
			id: String(instance.id),
			zone: last(instance.zone),
			machineType: last(instance.machineType),
			cpuPlatform: instance.cpuPlatform,
			scheduling: instance.scheduling,
			disks: (instance.disks ?? []).map((d: Record<string, unknown>) => ({
				deviceName: d.deviceName,
				type: d.type,
				interface: d.interface,
				mode: d.mode,
			})),
			tags: instance.tags,
		};
	} catch {
		return undefined;
	}
}

let lockHolder: ChildProcess | undefined;

/**
 * Holds the host's agent lock for as long as this process lives: `flock` keeps it on the kernel's
 * behalf and exits, releasing it, when this process's end of its stdin closes, however it ends.
 */
async function acquireLock(): Promise<void> {
	const holder = spawn('flock', ['-n', '-E', '75', LOCK_PATH, '-c', 'echo locked; exec cat'], {
		stdio: ['pipe', 'pipe', 'inherit'],
	});
	const outcome = await new Promise<string>((resolve) => {
		holder.stdout!.once('data', (chunk: Buffer) => resolve(chunk.toString().trim()));
		holder.once('exit', (code) => resolve(`exit ${code}`));
		holder.once('error', (error) => resolve(`error ${error.message}`));
	});
	if (outcome !== 'locked') {
		holder.kill();
		throw new Error(
			outcome === 'exit 75'
				? `another target agent holds this host (${LOCK_PATH})`
				: `could not take the agent lock ${LOCK_PATH}: ${outcome}`
		);
	}
	holder.unref();
	lockHolder = holder;
}

function releaseLock(): void {
	lockHolder?.stdin?.end();
	lockHolder = undefined;
}

/** Stops this agent's scopes and the project's containers by name; returns what is still running. */
async function forceCleanup(unitPrefix: string): Promise<string[]> {
	for (const unit of await agentScopes(`${unitPrefix}-`))
		await exec('systemctl', ['--user', 'stop', unit], { timeout: 120_000 }).catch(() => {});
	const docker = hasDocker();
	if (docker && (await runningProjectContainers()).length > 0) await composeDownProject().catch(() => {});
	return [...(await agentScopes(`${unitPrefix}-`)), ...(docker ? await runningProjectContainers() : [])];
}

async function agentScopes(prefix: string, states = 'active,activating,deactivating,reloading'): Promise<string[]> {
	const { stdout } = await exec(
		'systemctl',
		['--user', 'list-units', '--plain', '--no-legend', `--state=${states}`, `${prefix}*`],
		{ timeout: 30_000 }
	);
	return stdout
		.split('\n')
		.map((line) => line.trim().split(/\s+/)[0])
		.filter(Boolean);
}

/** A harper-only host need not have Docker. */
const hasDocker = (): boolean =>
	(process.env.PATH ?? '').split(':').some((dir) => dir && existsSync(join(dir, 'docker')));

/**
 * With the host lock held no other agent runs, so every agent scope and project container is a
 * leftover. Fails unless they are all gone afterwards: a host still running one must not take a sample.
 */
async function cleanupLeftovers(): Promise<string[]> {
	const scopes = await agentScopes(UNIT_PREFIX);
	for (const unit of scopes) await exec('systemctl', ['--user', 'stop', unit], { timeout: 120_000 }).catch(() => {});
	const docker = hasDocker();
	const containers = docker ? await runningProjectContainers() : [];
	if (containers.length > 0) await composeDownProject();
	const left = [...(await agentScopes(UNIT_PREFIX)), ...(docker ? await runningProjectContainers() : [])];
	if (left.length > 0) throw new Error(`leftovers of an earlier agent are still running: ${left.join(', ')}`);
	return [...scopes, ...(containers.length > 0 ? ['compose project ycsb-vs-pg'] : [])];
}

function createAgent() {
	let session: Session | undefined;
	let profileDir: string | undefined;
	let info: HostInfo | undefined;
	const parts = new Map<number, { target: TargetName; parked: Parked<Running> }>();
	let nextHandle = 0;
	const serial = serialQueue();
	let echo: Awaited<ReturnType<typeof startEchoServer>> | undefined;
	let closing = false;
	const underway = new Set<Promise<unknown>>();
	/** Work on a part that shutdown waits for before it stops the parts, and refuses once it has begun. */
	const fenced = <T,>(work: () => Promise<T>): Promise<T> => {
		if (closing) return Promise.reject(new Error('the agent is shutting down'));
		const running = work();
		underway.add(running);
		running.then(
			() => underway.delete(running),
			() => underway.delete(running)
		);
		return running;
	};

	const ready = (): Session => {
		if (!session) throw new Error('the agent is not initialized');
		return session;
	};
	const part = (handle: number) => {
		const found = parts.get(handle);
		if (!found) throw new Error(`no running part ${handle}`);
		return found.parked.running;
	};
	const probe = (handle: number) => part(handle).probe;
	const profilePath = (label: string) => {
		if (!profileDir) throw new Error('the session was not started with --profile');
		if (!/^[\w.@-]+$/.test(label)) throw new Error(`bad profile label ${label}`);
		return join(profileDir, label);
	};

	async function init(params: AgentInit): Promise<HostInfo> {
		if (session) throw new Error('the agent is already initialized');
		await acquireLock();
		if (params.dataDir) process.env.YCSB_VS_PG_DATA_DIR = params.dataDir;
		const topology = readTopology();
		const { server, rest } = params.serverCpus
			? { server: params.serverCpus, rest: cpusOffCores(topology, params.serverCpus) }
			: targetHostCpus(topology, params.targetCpus);
		const agentCpus = rest.length > 0 ? rest : topology.map((t) => t.cpu);
		await pinPid(process.pid, agentCpus);
		if (params.perfCounters || params.profileOps) await perfAvailable();
		const cleaned = await cleanupLeftovers();
		if (cleaned.length > 0) console.error(`stopped leftovers of an earlier agent: ${cleaned.join(', ')}`);
		const base = await prepareTargetHost(server);
		const dataMount = await findMount(base);
		if (params.requireMount && dataMount?.target !== params.requireMount) {
			throw new Error(`${base} is on ${dataMount?.target ?? 'an unknown mount'}, not ${params.requireMount}`);
		}
		const stamp = new Date().toISOString().replace(/[:.]/g, '-');
		if (params.profileOps) {
			profileDir = join(RESULTS_DIR, 'profiles', stamp);
			await mkdir(profileDir, { recursive: true });
		}
		session = {
			options: params.options,
			cache: params.cache,
			shards: 1,
			serverCpus: server,
			driverCpus: [],
			harperBin: join(REPO_ROOT, 'dist', 'bin', 'harper.js'),
			baseHarperBin: params.baseHarperBin ? resolve(params.baseHarperBin) : undefined,
			recordCacheSize: params.recordCacheSize,
			harperMemoryBytes: params.harperMemoryBytes,
			stackMemory: (target) => params.stackMemory[target],
			unitPrefix: `${UNIT_PREFIX}${process.pid}`,
			units: { count: 0 },
			perfCounters: params.perfCounters,
			profile: profileDir ? { dir: profileDir, ops: params.profileOps! } : undefined,
			auth: params.auth,
			jwtSecret: params.jwtSecret,
			bindAddress: params.bind,
			harperAdminPassword: params.bind ? randomBytes(18).toString('base64url') : undefined,
			separateSelf: true,
		};
		const cpuinfo = readFileSync('/proc/cpuinfo', 'utf8');
		info = {
			hostname: hostname(),
			bootId: readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(),
			kernel: release(),
			cpuModel: /model name\s*:\s*(.*)/.exec(cpuinfo)?.[1],
			cpus: topology.length,
			physicalCores: new Set(topology.map((t) => t.siblings.join(','))).size,
			serverCpus: server,
			agentCpus,
			hostMemoryBytes: Number(/^MemTotal:\s+(\d+) kB/m.exec(readFileSync('/proc/meminfo', 'utf8'))?.[1]) * 1024,
			node: process.version,
			pmu: detectPmu(),
			dataDir: base,
			dataMount,
			revision: gitRevision(REPO_ROOT),
			digests: buildDigests(REPO_ROOT),
			gcp: await gcpMetadata(),
			foreign: foreignProcessesInOwnCgroup(),
		};
		console.error(
			`agent ready on ${info.hostname}: target cpus ${server.join(',')}, agent cpus ${agentCpus.join(',')}`
		);
		return info;
	}

	const onThisHost = (path: string) =>
		path.startsWith(AGENT_DATA_PREFIX) ? join(dataDir(), path.slice(AGENT_DATA_PREFIX.length)) : path;

	async function startTarget({ target, launch }: { target: TargetName; launch: LaunchOptions }) {
		const current = ready();
		if (closing) throw new Error('the agent is shutting down');
		if (launch.restore) launch = { ...launch, restore: onThisHost(launch.restore) };
		const spec = TARGETS[target];
		if (spec.kind === 'harper') {
			const bin = spec.base ? current.baseHarperBin : current.harperBin;
			if (!bin || !existsSync(bin))
				throw new Error(`${bin ?? '--base-harper'} not found on ${hostname()} — build it first`);
		}
		const parked = await park<Running>((body) => withTarget(current, target, body, launch));
		const handle = ++nextHandle;
		parts.set(handle, { target, parked });
		const { running } = parked;
		const descriptor: PartDescriptor = {
			baseUrl: running.baseUrl,
			authorization: running.authorization,
			callerAuthorizations: running.callerAuthorizations,
			startupMs: running.startupMs,
			recordCacheSize: running.recordCacheSize,
			harperSettings: running.harperSettings,
			memoryLimits: running.memoryLimits,
			components: running.probe.components,
			hasRedis: running.probe.hasRedis,
			hasPostgres: Boolean(running.checkpoints),
			hasRocksdb: Boolean(running.probe.rocksdbEvents),
		};
		return { handle, descriptor };
	}

	/** Keeps the part until its teardown succeeds, so a failed stop is retried at shutdown, not forgotten. */
	async function stopTarget({ handle }: { handle: number }): Promise<void> {
		const found = parts.get(handle);
		if (!found) return;
		// A window left open by a failed sample would keep a system-wide perf running past the part.
		await found.parked.running.probe.endWindow().catch(() => {});
		await found.parked.stop();
		parts.delete(handle);
	}

	const handlers = {
		ping: () => ({ pid: process.pid }),
		init: (params: AgentInit) => serial(() => init(params)),
		startTarget: (params: { target: TargetName; launch: LaunchOptions }) => serial(() => startTarget(params)),
		stopTarget: (params: { handle: number }) => serial(() => stopTarget(params)),
		snapshot: ({ handle, name }: { handle: number; name: string }) =>
			serial(() => fenced(async () => (await part(handle).snapshot(onThisHost(name))) ?? null)),
		afterLoad: ({ handle }: { handle: number }) => fenced(async () => part(handle).afterLoad?.()),
		checkpoints: ({ handle }: { handle: number }) => part(handle).checkpoints?.(),
		verifyPlacement: ({ handle }: { handle: number }) => probe(handle).verifyPlacement(),
		sample: ({ handle }: { handle: number }) => probe(handle).sample(),
		cpuSeconds: ({ handle }: { handle: number }) => probe(handle).cpuSeconds(),
		cgroupMemory: ({ handle }: { handle: number }) => probe(handle).cgroupMemory(),
		beginWindow: ({ handle, options }: { handle: number; options: WindowOptions }) =>
			fenced(() =>
				probe(handle).beginWindow({
					...options,
					recordPrefix: options.recordPrefix ? profilePath(options.recordPrefix) : undefined,
				})
			),
		endWindow: ({ handle }: { handle: number }) => fenced(() => probe(handle).endWindow()),
		fold: ({ handle, label }: { handle: number; label: string }) =>
			fenced(async () => {
				const prefix = profilePath(label);
				const samples = await probe(handle).fold(prefix);
				const files: Record<string, string> = {};
				for (const component of Object.keys(samples))
					files[component] = await readFile(`${prefix}.${component}.folded`, 'utf8');
				return { samples, files };
			}),
		rocksdbEvents: ({ handle, fromMs, toMs }: { handle: number; fromMs: number; toMs: number }) => {
			const events = probe(handle).rocksdbEvents;
			if (!events) throw new Error(`part ${handle} has no RocksDB log`);
			return events(fromMs, toMs);
		},
		async waitForQuietHost(gate: { maxOtherCores: number; maxMs: number }) {
			ready();
			return { ...(await waitForQuietHost({ ...gate, separateSelf: true })), foreign: foreignProcessesInOwnCgroup() };
		},
		async rttServer() {
			echo ??= await startEchoServer(session?.bindAddress ?? '127.0.0.1');
			return { port: echo.port };
		},
		rttProbe: ({ host, port }: { host: string; port: number }) => pingPong(host, port),
		removeSnapshots: () =>
			serial(() =>
				fenced(async () => {
					ready();
					await removePgSnapshots();
					await rm(join(dataDir(), 'snapshots'), { recursive: true, force: true });
				})
			),
		diskBytes: ({ path }: { path: string }) =>
			fenced(async () => {
				ready();
				if (path.split('/').includes('..')) throw new Error(`bad path ${path}`);
				return dataDirBytes(path);
			}),
		async leftovers() {
			const current = ready();
			const scopes = await agentScopes(`${current.unitPrefix}-`);
			const containers = hasDocker() ? await runningProjectContainers() : [];
			return [...scopes, ...containers.map((id) => `container ${id}`)];
		},
	};

	/**
	 * Refuses new work, lets the launches, windows and snapshots already under way finish (or fail),
	 * then stops every part. Whatever still runs afterwards (a part whose teardown failed, or a launch
	 * that failed before it became a part) is stopped by unit name and container. Resolves false unless
	 * nothing it started still runs.
	 */
	async function shutdown(): Promise<boolean> {
		closing = true;
		await serial(async () => {});
		await Promise.allSettled([...underway]);
		let stopped = true;
		for (const handle of [...parts.keys()]) {
			try {
				await stopTarget({ handle });
			} catch (error) {
				stopped = false;
				console.error(`stopping part ${handle}: ${(error as Error).stack}`);
			}
		}
		await echo?.close();
		if (!session) return stopped;
		const left = await forceCleanup(session.unitPrefix).catch((error) => [
			`cleanup failed: ${(error as Error).message}`,
		]);
		if (left.length > 0) console.error(`still running after shutdown: ${left.join(', ')}`);
		return stopped && left.length === 0;
	}

	return { handlers, shutdown, info: () => info };
}

async function main(): Promise<void> {
	// Only response frames go to stdout; every log line, the agent's and its targets', goes to stderr.
	const writeFrame = process.stdout.write.bind(process.stdout);
	process.stdout.write = process.stderr.write.bind(process.stderr) as typeof process.stdout.write;
	console.log = console.error;
	console.info = console.error;
	const agent = createAgent();
	let exiting = false;
	const exit = async (reason: string, code: number) => {
		if (exiting) return;
		exiting = true;
		console.error(`target agent stopping: ${reason}`);
		const deadline = setTimeout(() => {
			console.error('target agent: shutdown took over 20 minutes; exiting with parts possibly left running');
			releaseLock();
			process.exit(2);
		}, 20 * 60_000);
		let stopped = false;
		try {
			stopped = await agent.shutdown();
		} finally {
			clearTimeout(deadline);
			releaseLock();
			process.exit(stopped ? code : 1);
		}
	};
	for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.on(signal, () => void exit(signal, 1));
	process.on('uncaughtException', (error) => {
		console.error(error);
		void exit('uncaught exception', 1);
	});
	process.on('unhandledRejection', (error) => {
		console.error(error);
		void exit('unhandled rejection', 1);
	});
	serveRpc(agent.handlers, {
		input: process.stdin,
		write: (frame) => writeFrame(frame),
		onEnd: () => void exit('the orchestrator closed the channel', 0),
	});
}

if (import.meta.main) await main();
