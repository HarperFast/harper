/**
 * Remote-target mode: the orchestrator and load generator run here, every target component runs on
 * a target host under a target agent (targetAgent.mts) reached over SSH.
 *
 * A hosts file (`--hosts`, written by gcp/provision.sh) names the host for each role: `harper` runs
 * Harper targets, `stack` runs the conventional stack, and topology b (`pg-redis@b`) moves its Redis
 * and Postgres to the `redis` and `postgres` hosts. Each agent launches its part with the same code
 * single-host mode runs and takes the target-side readings there; this module turns the agents' parts
 * into one `Running` for run-compare and memory-sweep.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { randomBytes } from 'node:crypto';
import { RpcClient } from './rpc.mts';
import { compositeProbe, mergeHostLoads, type TargetProbe } from './probe.mts';
import { pingPong, startEchoServer, type RttStats } from './rtt.mts';
import { assertDisjointCores, parseCpuList, type CpuTopology, type HostLoad, type MemoryLimit } from './resources.mts';
import {
	TARGETS,
	assertCredentialChecked,
	parseTargets,
	waitForRoute,
	type AuthMode,
	type HarperSettings,
	type LaunchOptions,
	type Running,
	type Session,
	type TargetName,
} from './run-compare.mts';

export type Topology = 'a' | 'b';
export type Role = 'harper' | 'stack' | 'redis' | 'postgres';
const ROLES: Role[] = ['harper', 'stack', 'redis', 'postgres'];

/** What every topology b row says about itself. */
export const B_TOPOLOGY_NOTE =
	'topology b: Fastify, Redis and Postgres each on its own target-shaped VM (3x the cores of a), same per-component ' +
	'memory caps; a deployment comparison, not an equal budget, and not the cost of the network hops alone';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

export interface PlacedTarget {
	/** `pg-redis@b` for topology b, else the target's name. */
	name: string;
	target: TargetName;
	topology: Topology;
}

/** `harper-uws,pg-redis,pg-redis@b`: topology b only for stack targets, and only in remote mode. */
export function parsePlacedTargets(list: string, { remote }: { remote: boolean }): PlacedTarget[] {
	const placed = list.split(',').map((item): PlacedTarget => {
		const name = item.trim();
		const [base, topology = 'a', extra] = name.split('@');
		if (extra !== undefined || (topology !== 'a' && topology !== 'b')) {
			throw new Error(`target "${name}": the topology after @ is a or b`);
		}
		const [target] = parseTargets(base);
		if (topology === 'b') {
			if (!remote) throw new Error(`${name}: topology b needs --hosts (remote mode)`);
			if (TARGETS[target].kind !== 'stack') {
				throw new Error(`${name}: topology b splits the stack's services across hosts; ${target} is one process`);
			}
		}
		return { name: topology === 'b' ? `${target}@b` : target, target, topology };
	});
	const names = placed.map((p) => p.name);
	const repeated = names.find((n, i) => names.indexOf(n) !== i);
	if (repeated) throw new Error(`target ${repeated} is listed twice`);
	return placed;
}

/** A path under the target host's own data dir, which only its agent knows: `@data/snapshots/harper-17179869`. */
export const AGENT_DATA_PREFIX = '@data/';

export const placedName = (row: { target: string; topology?: Topology }): string =>
	row.topology === 'b' ? `${row.target}@b` : row.target;

export interface HostSpec {
	/** `[user@]host`: the agent runs as `ssh <ssh> -- cd <repoDir> && exec node .../targetAgent.mts`. */
	ssh?: string;
	/** The agent's argv instead of ssh (tests, or a local validation on a host without sshd). */
	command?: string[];
	/** Where the target listens and other hosts reach it; unset keeps single-host loopback addresses. */
	address?: string;
	repoDir?: string;
	/** YCSB_VS_PG_DATA_DIR on that host. */
	dataDir?: string;
	/** The data dir must sit on this mount (the VM's local SSD); the agent refuses to start otherwise. */
	requireMount?: string;
	/** The target's cpus there, instead of the agent's choice (a CPU list). */
	serverCpus?: string;
}

export interface HostsFile {
	roles: Partial<Record<Role, HostSpec>>;
	repoDir?: string;
	/** Extra ssh arguments for every agent (identity file, known_hosts). */
	sshOptions?: string[];
	/** Copied into every results file: machine types, zone, disk, placement (gcp/provision.sh). */
	meta?: Record<string, unknown>;
}

export function parseHostsFile(text: string): HostsFile {
	const parsed = JSON.parse(text) as HostsFile;
	if (!parsed || typeof parsed !== 'object' || !parsed.roles || typeof parsed.roles !== 'object') {
		throw new Error('hosts file: needs a "roles" object');
	}
	for (const [role, spec] of Object.entries(parsed.roles)) {
		if (!ROLES.includes(role as Role))
			throw new Error(`hosts file: unknown role "${role}" (expected ${ROLES.join(', ')})`);
		if (!spec || typeof spec !== 'object') throw new Error(`hosts file: role ${role} is not an object`);
		if (Boolean(spec.ssh) === Boolean(spec.command))
			throw new Error(`hosts file: role ${role} needs exactly one of ssh, command`);
		if (
			spec.command &&
			!(Array.isArray(spec.command) && spec.command.length > 0 && spec.command.every((a) => typeof a === 'string'))
		) {
			throw new Error(`hosts file: role ${role} command must be a non-empty array of strings`);
		}
		for (const key of ['ssh', 'address', 'repoDir', 'dataDir', 'requireMount', 'serverCpus'] as const) {
			if (spec[key] !== undefined && typeof spec[key] !== 'string')
				throw new Error(`hosts file: role ${role} ${key} must be a string`);
		}
		if (spec.serverCpus) parseCpuList(spec.serverCpus);
		if (spec.ssh && !spec.repoDir && !parsed.repoDir) throw new Error(`hosts file: role ${role} needs a repoDir`);
	}
	if (
		parsed.sshOptions !== undefined &&
		!(Array.isArray(parsed.sshOptions) && parsed.sshOptions.every((a) => typeof a === 'string'))
	) {
		throw new Error('hosts file: sshOptions must be an array of strings');
	}
	return parsed;
}

/** The roles a placed target occupies, its front (where the generator sends requests) first. */
export function rolesFor(placed: PlacedTarget): Role[] {
	const spec = TARGETS[placed.target];
	if (spec.kind === 'harper') return ['harper'];
	if (placed.topology === 'a') return ['stack'];
	return spec.cache ? ['stack', 'redis', 'postgres'] : ['stack', 'postgres'];
}

const isLoopback = (address: string | undefined): boolean =>
	address === undefined || address === 'localhost' || address === '::1' || address.startsWith('127.');

export const hostKey = (spec: HostSpec): string =>
	spec.command ? `command:${JSON.stringify(spec.command)}` : `ssh:${spec.ssh}`;

/** Refuses a placement that cannot run, before anything connects. */
export function checkPlacement(hosts: HostsFile, placed: PlacedTarget[], auth: AuthMode): void {
	for (const p of placed) {
		const roles = rolesFor(p);
		for (const role of roles)
			if (!hosts.roles[role]) throw new Error(`${p.name} needs a "${role}" host in the hosts file`);
		if (p.topology === 'b') {
			const keys = roles.map((role) => hostKey(hosts.roles[role]!));
			if (new Set(keys).size !== keys.length) {
				throw new Error(
					`${p.name}: topology b runs ${roles.join(', ')} on separate hosts; the hosts file maps two of them to one`
				);
			}
			for (const role of roles) {
				if (isLoopback(hosts.roles[role]!.address))
					throw new Error(`${p.name}: the ${role} host needs an address the other hosts reach`);
			}
		}
		if (auth === 'none' && TARGETS[p.target].kind === 'harper' && !isLoopback(hosts.roles.harper!.address)) {
			throw new Error(
				'--auth=none serves Harper as its local-trust principal, which covers loopback peers only; a generator on ' +
					'another host would be refused. Use --auth=token.'
			);
		}
	}
}

const shellQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

export function agentCommand(spec: HostSpec, hosts: HostsFile): string[] {
	if (spec.command) return spec.command;
	const repo = spec.repoDir ?? hosts.repoDir!;
	return [
		'ssh',
		'-o',
		'BatchMode=yes',
		'-o',
		'ServerAliveInterval=15',
		'-o',
		'ServerAliveCountMax=4',
		...(hosts.sshOptions ?? []),
		spec.ssh!,
		'--',
		`cd ${shellQuote(repo)} && exec node benchmarks/ycsb-vs-pg/targetAgent.mts`,
	];
}

/** What an agent reports about its host at init (the results file's per-host record). */
export interface HostInfo {
	hostname: string;
	bootId: string;
	kernel: string;
	cpuModel?: string;
	cpus: number;
	physicalCores: number;
	serverCpus: number[];
	agentCpus: number[];
	hostMemoryBytes: number;
	node: string;
	pmu: string;
	dataDir: string;
	dataMount?: { target: string; source: string; fstype: string };
	revision: string;
	digests: Record<string, string>;
	gcp?: Record<string, unknown>;
	/** Processes sharing the agent's cgroup (whose CPU the host gate would count as the agent's). */
	foreign: string[];
}

/** What a started part reports back: plain data, the agent keeps the live state. */
export interface PartDescriptor {
	baseUrl: string;
	authorization?: string;
	callerAuthorizations?: Record<string, string>;
	startupMs: number;
	recordCacheSize?: number;
	harperSettings?: HarperSettings;
	memoryLimits: Record<string, MemoryLimit>;
	components: string[];
	hasRedis: boolean;
	hasPostgres: boolean;
	hasRocksdb: boolean;
}

export class Agent {
	readonly name: string;
	readonly roles: Role[];
	readonly address: string;
	readonly rpc: RpcClient;
	info!: HostInfo;
	rttPort?: number;

	constructor(roles: Role[], spec: HostSpec, hosts: HostsFile) {
		this.roles = roles;
		this.name = roles.join('+');
		this.address = spec.address ?? '127.0.0.1';
		this.rpc = new RpcClient(this.name, agentCommand(spec, hosts));
	}

	call<T = unknown>(method: string, params: unknown, timeoutMs: number): Promise<T> {
		return this.rpc.call<T>(method, params, timeoutMs);
	}
}

/** Round trips from Fastify's host to the Redis and Postgres hosts (topology b). */
export interface BackendRtt {
	redis?: RttStats;
	postgres?: RttStats;
}

export interface RemoteSession {
	meta: Record<string, unknown>;
	redisPassword: string;
	describe(): string;
	agentFor(role: Role): Agent;
	address(role: Role): string;
	agents(): Agent[];
	backendRtt(): Promise<BackendRtt>;
	waitForQuietHosts(
		placed: PlacedTarget | undefined,
		gate: { maxOtherCores: number; maxMs: number },
		local: () => Promise<{ waitedMs: number; quiet: boolean; last: HostLoad }>
	): Promise<{
		waitedMs: number;
		quiet: boolean;
		last: HostLoad;
		byHost: Record<string, HostLoad>;
		sharedCgroup?: true;
	}>;
	close(): Promise<void>;
}

const bootId = (): string => {
	try {
		return readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
	} catch {
		return 'unknown';
	}
};

/**
 * Starts one agent per distinct host the targets need, initializes each with this session's settings,
 * and measures the round trips the rows report. Any failure closes every agent it started.
 */
export async function connectRemote(
	session: Session,
	hostsPath: string,
	placed: PlacedTarget[],
	{
		targetCpus,
		baseHarperBin,
		generatorTopology,
	}: { targetCpus: number; baseHarperBin?: string; generatorTopology: CpuTopology[] }
): Promise<RemoteSession> {
	const hosts = parseHostsFile(await readFile(hostsPath, 'utf8'));
	checkPlacement(hosts, placed, session.auth);
	const used = ROLES.filter((role) => placed.some((p) => rolesFor(p).includes(role)));
	const byKey = new Map<string, Role[]>();
	for (const role of used) {
		const key = hostKey(hosts.roles[role]!);
		byKey.set(key, [...(byKey.get(key) ?? []), role]);
	}
	const agents = [...byKey.values()].map((roles) => new Agent(roles, hosts.roles[roles[0]]!, hosts));
	const roleAgent = new Map(agents.flatMap((agent) => agent.roles.map((role) => [role, agent] as const)));
	const closeAll = () => Promise.all(agents.map((agent) => agent.rpc.close().catch(() => {})));
	const redisPassword = randomBytes(18).toString('base64url');
	try {
		await Promise.all(
			agents.map(async (agent) => {
				const spec = hosts.roles[agent.roles[0]]!;
				agent.info = await agent.call<HostInfo>(
					'init',
					{
						options: {
							engine: session.options.engine,
							threads: session.options.threads,
							startupTimeoutMs: session.options.startupTimeoutMs,
							config: session.options.config,
						},
						cache: session.cache,
						recordCacheSize: session.recordCacheSize,
						harperMemoryBytes: session.harperMemoryBytes,
						stackMemory: { 'pg-redis': session.stackMemory('pg-redis'), 'pg-only': session.stackMemory('pg-only') },
						profileOps: session.profile?.ops,
						perfCounters: session.perfCounters,
						auth: session.auth,
						jwtSecret: session.jwtSecret,
						targetCpus,
						serverCpus: spec.serverCpus
							? parseCpuList(spec.serverCpus)
							: session.serverCpus.length > 0
								? session.serverCpus
								: undefined,
						bind: isLoopback(spec.address) ? undefined : spec.address,
						dataDir: spec.dataDir,
						requireMount: spec.requireMount,
						baseHarperBin,
					},
					15 * MINUTE
				);
				// The local validation runs both "hosts" on one machine: then they must not share a core either.
				if (agent.info.bootId === bootId()) {
					assertDisjointCores(generatorTopology, agent.info.serverCpus, session.driverCpus);
				}
				agent.rttPort = (await agent.call<{ port: number }>('rttServer', {}, MINUTE)).port;
			})
		);
		const loopback = await startEchoServer('127.0.0.1');
		const loopbackFloor = await pingPong('127.0.0.1', loopback.port).finally(() => loopback.close());
		const generatorTo: Record<string, RttStats> = {};
		for (const agent of agents) generatorTo[agent.name] = await pingPong(agent.address, agent.rttPort!);
		const remote: RemoteSession = {
			meta: {},
			redisPassword,
			describe: () =>
				agents.map((a) => `${a.name}=${a.info.hostname} (${a.address}) cpus ${a.info.serverCpus.join(',')}`).join('; '),
			agentFor(role) {
				const agent = roleAgent.get(role);
				if (!agent) throw new Error(`no ${role} host in this session`);
				return agent;
			},
			address: (role) => remote.agentFor(role).address,
			agents: () => agents,
			async backendRtt() {
				const out: BackendRtt = {};
				const stack = roleAgent.get('stack');
				if (!stack) return out;
				for (const role of ['redis', 'postgres'] as const) {
					const backend = roleAgent.get(role);
					if (!backend || backend === stack) continue;
					out[role] = await stack.call<RttStats>(
						'rttProbe',
						{ host: backend.address, port: backend.rttPort },
						2 * MINUTE
					);
				}
				return out;
			},
			async waitForQuietHosts(target, gate, local) {
				const roles = target ? rolesFor(target) : used;
				const gated = [...new Set(roles.map((role) => roleAgent.get(role)!))];
				const [mine, ...theirs] = await Promise.all([
					local(),
					...gated.map((agent) =>
						agent.call<{ waitedMs: number; quiet: boolean; last: HostLoad; foreign: string[] }>(
							'waitForQuietHost',
							gate,
							gate.maxMs + 10 * MINUTE
						)
					),
				]);
				const byHost: Record<string, HostLoad> = { generator: mine.last };
				gated.forEach((agent, i) => (byHost[agent.name] = theirs[i].last));
				return {
					waitedMs: Math.max(mine.waitedMs, ...theirs.map((t) => t.waitedMs)),
					quiet: mine.quiet && theirs.every((t) => t.quiet),
					last: mergeHostLoads(byHost),
					byHost,
					...(theirs.some((t) => t.foreign.length > 0) ? { sharedCgroup: true as const } : {}),
				};
			},
			close: async () => {
				await closeAll();
			},
		};
		remote.meta = {
			hostsFile: hosts.meta,
			hosts: Object.fromEntries(agents.map((a) => [a.name, { address: a.address, ...a.info }])),
			rtt: {
				method: 'TCP one-byte ping-pong, Node on both ends; loopbackFloor is the same probe on this host',
				loopbackFloor,
				generatorTo,
				backends: await remote.backendRtt(),
			},
		};
		return remote;
	} catch (error) {
		await closeAll();
		throw error;
	}
}

function remoteProbe(agent: Agent, handle: number, part: PartDescriptor): TargetProbe {
	const call = <T,>(method: string, params: Record<string, unknown> = {}, timeoutMs = 2 * MINUTE) =>
		agent.call<T>(method, { handle, ...params }, timeoutMs);
	return {
		components: part.components,
		hasRedis: part.hasRedis,
		verifyPlacement: () => call('verifyPlacement'),
		sample: () => call('sample'),
		cpuSeconds: () => call('cpuSeconds'),
		cgroupMemory: () => call('cgroupMemory'),
		// The agent keeps profile files in its own directory, under the same label.
		beginWindow: (options) =>
			call(
				'beginWindow',
				{ options: { ...options, recordPrefix: options.recordPrefix && basename(options.recordPrefix) } },
				5 * MINUTE
			),
		endWindow: () => call('endWindow', {}, 10 * MINUTE),
		async fold(prefix) {
			const { samples, files } = await call<{ samples: Record<string, number>; files: Record<string, string> }>(
				'fold',
				{ label: basename(prefix) },
				2 * HOUR
			);
			for (const [component, text] of Object.entries(files)) await writeFile(`${prefix}.${component}.folded`, text);
			return samples;
		},
		rocksdbEvents: part.hasRocksdb ? (fromMs, toMs) => call('rocksdbEvents', { fromMs, toMs }, 10 * MINUTE) : undefined,
	};
}

interface Part {
	role: Role;
	agent: Agent;
	launch: LaunchOptions;
	front: boolean;
}

/**
 * Starts the target's parts on their hosts (backends first, so Fastify finds Postgres and Redis up),
 * runs `body` against them as one target, and stops every part it started, front first, whether the
 * start, the body or another part failed.
 */
export async function withRemoteTarget<T>(
	session: Session,
	target: TargetName,
	body: (running: Running) => Promise<T>,
	launch: LaunchOptions = {}
): Promise<T> {
	const remote = session.remote!;
	const { topology = 'a', ...rest } = launch;
	const spec = TARGETS[target];
	const parts: Part[] = [];
	if (spec.kind === 'harper') {
		parts.push({ role: 'harper', agent: remote.agentFor('harper'), launch: rest, front: true });
	} else if (topology === 'a') {
		parts.push({ role: 'stack', agent: remote.agentFor('stack'), launch: rest, front: true });
	} else {
		// Only Postgres restores a snapshot; Fastify and Redis start empty.
		const unrestored = { ...rest, restore: undefined, restoreRoot: undefined };
		parts.push({
			role: 'postgres',
			agent: remote.agentFor('postgres'),
			launch: { ...rest, stack: { services: ['postgres'] } },
			front: false,
		});
		if (spec.cache) {
			parts.push({
				role: 'redis',
				agent: remote.agentFor('redis'),
				launch: { ...unrestored, stack: { services: ['redis'], redisPassword: remote.redisPassword } },
				front: false,
			});
		}
		parts.push({
			role: 'stack',
			agent: remote.agentFor('stack'),
			launch: {
				...unrestored,
				stack: {
					services: ['fastify'],
					pgUrl: `postgres://ycsb:ycsb@${remote.address('postgres')}:5433/ycsb`,
					redisUrl: spec.cache
						? `redis://:${encodeURIComponent(remote.redisPassword)}@${remote.address('redis')}:6380`
						: undefined,
				},
			},
			front: true,
		});
	}
	const started: { part: Part; handle: number; descriptor: PartDescriptor }[] = [];
	const start = async (part: Part) => {
		const reply = await part.agent.call<{ handle: number; descriptor: PartDescriptor }>(
			'startTarget',
			{ target, launch: part.launch },
			3 * HOUR
		);
		started.push({ part, ...reply });
	};
	const stopAll = async () => {
		let first: unknown;
		for (const { part, handle } of [...started].sort((a, b) => Number(b.part.front) - Number(a.part.front))) {
			try {
				await part.agent.call('stopTarget', { handle }, 30 * MINUTE);
			} catch (error) {
				first ??= error;
			}
		}
		started.length = 0;
		if (first) throw first;
	};
	try {
		const settled = await Promise.allSettled(parts.filter((p) => !p.front).map(start));
		const failed = settled.find((s): s is PromiseRejectedResult => s.status === 'rejected');
		if (failed) throw failed.reason;
		await start(parts.find((p) => p.front)!);
	} catch (error) {
		await stopAll().catch((stopError) =>
			console.error(`stopping a partly started ${target} failed too: ${(stopError as Error).message}`)
		);
		throw error;
	}
	try {
		const front = started.find((s) => s.part.front)!;
		const { baseUrl, authorization, callerAuthorizations } = front.descriptor;
		const table = session.options.config.table;
		// From the generator: the route answers over the network, and refuses a request without the credential.
		await waitForRoute(`${baseUrl}/${table}/`, MINUTE, authorization);
		if (authorization) await assertCredentialChecked(`${baseUrl}/${table}/auth-probe`, authorization);
		const probes = Object.fromEntries(
			started.map((s) => [s.part.role, remoteProbe(s.part.agent, s.handle, s.descriptor)])
		);
		const postgres = started.find((s) => s.descriptor.hasPostgres);
		const owner = spec.kind === 'harper' ? front : postgres;
		return await body({
			baseUrl,
			probe: started.length === 1 ? probes[front.part.role] : compositeProbe(probes),
			memoryLimits: Object.assign({}, ...started.map((s) => s.descriptor.memoryLimits)),
			recordCacheSize: front.descriptor.recordCacheSize,
			harperSettings: front.descriptor.harperSettings,
			startupMs: Math.max(...started.map((s) => s.descriptor.startupMs)),
			authorization,
			callerAuthorizations,
			afterLoad: postgres
				? async () => {
						await postgres.part.agent.call('afterLoad', { handle: postgres.handle }, 5 * HOUR);
					}
				: undefined,
			checkpoints: postgres
				? () => postgres.part.agent.call<number>('checkpoints', { handle: postgres.handle }, 2 * MINUTE)
				: undefined,
			async snapshot(name) {
				const restoreRoot = await owner!.part.agent.call<string | null>(
					'snapshot',
					{ handle: owner!.handle, name },
					4 * HOUR
				);
				return restoreRoot ?? undefined;
			},
		});
	} finally {
		await stopAll();
	}
}
