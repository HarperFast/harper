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
import { writeFile, mkdir, mkdtemp, cp, rename, rm, statfs } from 'node:fs/promises';
import { statSync, existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { join, resolve, dirname, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseOptions } from '../ycsb/harness.mts';
import { WORKLOADS, OWNER_COUNT, formatKey, linkTarget, ownerOf, usesDependentReads } from '../ycsb/workload.mts';
import type { DistributionName, LatencyStats, PhaseResult } from '../ycsb/workload.mts';
import {
	k6Version,
	startDriver as startK6Driver,
	type DriverConfig,
	type DriverRun,
	type PhaseWindow,
} from './k6Driver.mts';
import { startDriver as startNodeDriver } from './shardedDriver.mts';
import { startPgStack, dataDir, WARM_STACK_MEMORY, type StackMemory, type StackService } from './pgStack.mts';
import {
	diffResources,
	parseCpuList,
	readTopology,
	chooseCpuSets,
	assertDisjointCores,
	verifyMemoryLimit,
	processCgroup,
	stopScope,
	pinPid,
	writePinnedRuntime,
	startHostLoad,
	waitForQuietHost,
	checkOwnCgroup,
	foreignProcessesInOwnCgroup,
	type HostLoad,
	type ResourceDelta,
	type MemoryLimit,
	type CgroupMemory,
} from './resources.mts';
import {
	PERF_NODE_OPTIONS,
	detectPmu,
	removePerfMaps,
	perfAvailable,
	sumCounters,
	type Counters,
} from './perfProfile.mts';
import { localProbe, mergeHostLoads, type TargetProbe } from './probe.mts';
import {
	B_TOPOLOGY_NOTE,
	connectRemote,
	parsePlacedTargets,
	placedName,
	withRemoteTarget,
	type BackendRtt,
	type PlacedTarget,
	type RemoteSession,
	type Topology,
} from './remote.mts';

const REPO_ROOT = join(import.meta.dirname, '..', '..');
const HARPER_APP_DIR = join(REPO_ROOT, 'benchmarks', 'ycsb', 'app');
export const RESULTS_DIR = join(import.meta.dirname, 'results');

/** Settings a target fixes for Harper instead of taking its defaults. */
export interface HarperTuning {
	/** storage.recordCacheSize: weak-lru-cache ring positions per thread; a ~1 KiB record takes 2. */
	recordCacheSize?: number;
	/** threads.maxHeapMemory: old-space MB per worker. */
	maxHeapMemoryMb?: number;
	/** storage.rocks.blockCacheSize, bytes. */
	blockCacheBytes?: number;
	/**
	 * rocksdb-js's process-global verification table, pinned by vtPreload.mjs. Left out, Harper sizes it
	 * from storage.recordCacheSize and its thread count.
	 */
	verificationTableEntries?: number;
}

type HarperTarget = {
	kind: 'harper';
	uws: boolean;
	sized: boolean;
	base: boolean;
	/** threads.count, instead of the session's --threads. */
	threads?: number;
	tuning?: HarperTuning;
	label: string;
};
type StackTarget = { kind: 'stack'; cache: boolean; label: string };

const MiB = 1024 ** 2;
const MIN_RECORD_CACHE_SIZE = 4;
const MAX_RECORD_CACHE_SIZE = 16_777_215;

export function sizedRecordCacheSize(records: number): number {
	return Math.max(MIN_RECORD_CACHE_SIZE, Math.min(2 ** Math.ceil(Math.log2(records)), MAX_RECORD_CACHE_SIZE));
}
/**
 * 3 GiB of decoded records in total, Redis's maxmemory in the sweep: 4 threads x 768 MiB or 2 x 1.5 GiB.
 * A cached ~1 KiB record holds 1,965 heap bytes (measured, PROFILE.md "A Redis-sized record cache") and
 * two ring positions, so 768 MiB is 410k records and a cacheSize of 820k. The heap allows the cache plus
 * the ~50 MiB per-thread baseline plus 40% for garbage between major GCs; the block cache gives up
 * 1.5 GiB of its 2 GiB default toward it.
 */
const RC3G = {
	blockCacheBytes: 512 * MiB,
	verificationTableEntries: 2 ** 24,
};
const RC3G_4T: HarperTuning = { ...RC3G, recordCacheSize: 820_000, maxHeapMemoryMb: 1152 };
const RC3G_2T: HarperTuning = { ...RC3G, recordCacheSize: 1_640_000, maxHeapMemoryMb: 2240 };

/** What each target is. Launch settings derive from this, never from the name. */
export const TARGETS = {
	'harper': { kind: 'harper', uws: false, sized: false, base: false, label: 'Harper, Node HTTP, stock record cache' },
	'harper-sized': {
		kind: 'harper',
		uws: false,
		sized: true,
		base: false,
		label: 'Harper, Node HTTP, storage.recordCacheSize >= record count',
	},
	'harper-uws': { kind: 'harper', uws: true, sized: false, base: false, label: 'Harper, uWS HTTP, stock record cache' },
	'harper-uws-sized': {
		kind: 'harper',
		uws: true,
		sized: true,
		base: false,
		label: 'Harper, uWS HTTP, storage.recordCacheSize >= record count',
	},
	'harper-base': {
		kind: 'harper',
		uws: false,
		sized: false,
		base: true,
		label: 'Harper (--base-harper build), Node HTTP, stock record cache',
	},
	'harper-uws-rc3g-4t': {
		kind: 'harper',
		uws: true,
		sized: false,
		base: false,
		threads: 4,
		tuning: RC3G_4T,
		label: 'Harper, uWS HTTP, 4 threads x 768 MiB record cache, 512 MiB block cache, 16M-slot verification table',
	},
	'harper-uws-rc3g-2t': {
		kind: 'harper',
		uws: true,
		sized: false,
		base: false,
		threads: 2,
		tuning: RC3G_2T,
		label: 'Harper, uWS HTTP, 2 threads x 1.5 GiB record cache, 512 MiB block cache, 16M-slot verification table',
	},
	'harper-uws-rc3g-4t-vt128k': {
		kind: 'harper',
		uws: true,
		sized: false,
		base: false,
		threads: 4,
		tuning: { ...RC3G_4T, verificationTableEntries: 131_072 },
		label: 'harper-uws-rc3g-4t with the default 128K-slot verification table',
	},
	'harper-uws-vt16m': {
		kind: 'harper',
		uws: true,
		sized: false,
		base: false,
		tuning: { verificationTableEntries: RC3G.verificationTableEntries },
		label: 'Harper, uWS HTTP, stock record cache, 16M-slot verification table',
	},
	'harper-uws-2t': {
		kind: 'harper',
		uws: true,
		sized: false,
		base: false,
		threads: 2,
		label: 'Harper, uWS HTTP, 2 threads, stock record cache',
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

export type GeneratorName = 'k6' | 'node';

/**
 * k6 where the generator has a host of its own (--hosts), sized for k6's cost per request; the Node driver
 * (shardedDriver.mts) where it shares one with the target, whose spare cores k6 cannot saturate a target from.
 */
export const defaultGenerator = (remote: boolean): GeneratorName => (remote ? 'k6' : 'node');

/** k6 (k6Driver.mts), or the Node driver (shardedDriver.mts, `shards` processes). */
export function startGenerator(generator: GeneratorName, config: DriverConfig, shards = 4): Promise<DriverRun> {
	return generator === 'node' ? startNodeDriver({ ...config, shards }) : startK6Driver(config);
}

export interface Session {
	options: Options;
	cache: CacheMode;
	generator: GeneratorName;
	/** --generator=node: its processes. */
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
	/** Remote mode (--hosts): the target agents, one per target host. */
	remote?: RemoteSession;
	/** On a target agent's host: the address Harper and Fastify listen on instead of loopback. */
	bindAddress?: string;
	/** On a target agent's host: report the agent's own CPU apart from the target's and the rest of the host. */
	separateSelf?: boolean;
}

interface Sample {
	rep: number;
	/** 1-based position of this target within its rep's order, for drift analysis. */
	position: number;
	target: TargetName;
	/** Remote mode: a, every component of the target on one host; b, Fastify, Redis and Postgres on their own. */
	topology?: Topology;
	/** Topology b: what the row compares (B_TOPOLOGY_NOTE) and the round trips between its hosts. */
	note?: string;
	rtt?: BackendRtt;
	workload: string;
	auth: AuthMode;
	/** With --host-quiet-cores: the wait for a quiet host before this sample (in remote mode, per host). */
	hostGate?: { waitedMs: number; quiet: boolean; load: HostLoad; byHost?: Record<string, HostLoad> };
	/** The gate ran with other processes in this run's cgroup, whose CPU it counted as the run's (see checkOwnCgroup). */
	sharedCgroup?: true;
	generator: GeneratorName;
	load: PhaseResult;
	warm: PhaseResult;
	measured: MeasuredWindow;
}

export async function waitForRoute(url: string, deadlineMs: number, authorization?: string): Promise<void> {
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
export function mintHs256(secret: string, subject: string): string {
	const part = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
	const body = `${part({ alg: 'HS256', typ: 'JWT' })}.${part({ sub: subject, iat: Math.floor(Date.now() / 1000) })}`;
	return `${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`;
}

interface Credentials {
	/** The header every generated request carries. */
	authorization: string;
	/** Each record owner's header, which inspect requests carry instead: the caller is the principal. */
	callerAuthorizations: Record<string, string>;
}

const OWNERS = Array.from({ length: OWNER_COUNT }, (_, i) => ownerOf(i));

/**
 * A non-super-user role that can read and write the benchmark table and nothing else (B updates), a
 * user in it and one per record owner, and their operation tokens. Idempotent, since a restored
 * snapshot may hold them.
 */
async function harperTokenCredentials(operationsURL: string, admin: string, table: string): Promise<Credentials> {
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
	const tokenFor = async (username: string): Promise<string> => {
		const password = randomBytes(18).toString('base64url');
		const added = await operation(
			{ operation: 'add_user', username, password, role: TOKEN_USER, active: true },
			/already exists/i
		);
		if (!added) await operation({ operation: 'alter_user', username, password, role: TOKEN_USER });
		const tokens = await operation({ operation: 'create_authentication_tokens', username, password });
		if (!tokens?.operation_token)
			throw new Error(`create_authentication_tokens returned no operation_token for ${username}`);
		return `Bearer ${tokens.operation_token}`;
	};
	const [authorization, ...ownerTokens] = await Promise.all([TOKEN_USER, ...OWNERS].map(tokenFor));
	return { authorization, callerAuthorizations: Object.fromEntries(OWNERS.map((owner, i) => [owner, ownerTokens[i]])) };
}

/** Proves the target checks the credential: a request without it is refused, one with it is served. */
export async function assertCredentialChecked(url: string, authorization: string): Promise<void> {
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

const MALFORMED_KEY = 'zz-malformed-link';

/**
 * Proves the target's dependent-read routes do the declared work before it is measured: chains
 * follow the links stored in the records (computed here independently), inspect answers the owner
 * with the projection and another owner with 403, a record without a link is a 500 that leaves the
 * server serving, and under --auth=token neither route answers an anonymous request.
 */
export async function assertDependentReads(
	running: Running,
	config: { table: string; records: number; fieldCount: number; fieldLength: number },
	keyWidth: number
): Promise<void> {
	const key = (index: number) => formatKey(index, keyWidth);
	const request = async (method: string, path: string, headers: Record<string, string>, body?: unknown) => {
		const response = await fetch(`${running.baseUrl}${path}`, {
			method,
			headers: body === undefined ? headers : { ...headers, 'content-type': 'application/json' },
			body: body === undefined ? undefined : JSON.stringify(body),
			signal: AbortSignal.timeout(10_000),
		});
		const text = await response.text();
		let json: any;
		try {
			json = JSON.parse(text);
		} catch {
			json = undefined;
		}
		return { status: response.status, json, text };
	};
	const defaultHeaders: Record<string, string> = running.authorization ? { authorization: running.authorization } : {};
	const asCaller = (owner: string): Record<string, string> =>
		running.callerAuthorizations ? { authorization: running.callerAuthorizations[owner] } : { 'x-caller': owner };
	const fail = (what: string, got: { status: number; text: string }) => {
		throw new Error(`dependent-read check: ${what} answered ${got.status}: ${got.text.slice(0, 300)}`);
	};
	const isField = (value: unknown) => typeof value === 'string' && value.length === config.fieldLength;

	for (const start of [0, Math.floor(config.records / 2), config.records - 1]) {
		const hops = 4;
		const chainPath = `/chain/${key(start)}?hops=${hops}`;
		const chained = await request('GET', chainPath, defaultHeaders);
		if (chained.status !== 200 || chained.json?.records?.length !== hops + 1) fail(chainPath, chained);
		let index = start;
		for (const record of chained.json.records) {
			const next = linkTarget(index, config.records);
			if (
				record.id !== key(index) ||
				record.owner !== ownerOf(index) ||
				record.next !== key(next) ||
				!isField(record.field1) ||
				!isField(record.field2)
			) {
				fail(
					`${chainPath} (expected ${key(index)} -> ${key(next)} at ${JSON.stringify(record).slice(0, 120)})`,
					chained
				);
			}
			index = next;
		}
		const inspectPath = `/inspect/${key(start)}`;
		const allowed = await request('GET', inspectPath, asCaller(ownerOf(start)));
		const { id, owner, field1, field2 } = allowed.json ?? {};
		if (
			allowed.status !== 200 ||
			id !== key(start) ||
			owner !== ownerOf(start) ||
			!isField(field1) ||
			!isField(field2)
		) {
			fail(`${inspectPath} by its owner`, allowed);
		}
		const denied = await request('GET', inspectPath, asCaller(ownerOf(start + 1)));
		if (denied.status !== 403) fail(`${inspectPath} by another owner`, denied);
	}

	const badHops = await request('GET', `/chain/${key(0)}?hops=x`, defaultHeaders);
	if (badHops.status !== 400) fail('a chain with hops=x', badHops);
	const malformed: Record<string, string> = {};
	for (let i = 0; i < config.fieldCount; i++) malformed[`field${i}`] = 'x'.repeat(config.fieldLength);
	const put = await request('PUT', `/${config.table}/${MALFORMED_KEY}`, defaultHeaders, malformed);
	if (put.status < 200 || put.status >= 300) fail(`PUT of ${MALFORMED_KEY}`, put);
	for (const [path, headers] of [
		[`/chain/${MALFORMED_KEY}?hops=1`, defaultHeaders],
		[`/inspect/${MALFORMED_KEY}`, asCaller(ownerOf(0))],
	] as const) {
		const broken = await request('GET', path, headers);
		if (broken.status !== 500) fail(`${path} (a record without a link)`, broken);
	}
	const after = await request('GET', `/chain/${key(0)}?hops=1`, defaultHeaders);
	if (after.status !== 200) fail('a chain after the malformed record', after);

	if (running.authorization) {
		for (const path of [`/inspect/${key(0)}`, `/chain/${key(0)}?hops=1`]) {
			const anonymous = await request('GET', path, {});
			if (anonymous.status !== 401 && anonymous.status !== 403) fail(`${path} without a credential`, anonymous);
		}
	}
}

export interface Running {
	/** Where the generator sends requests; empty on an agent host that runs only Postgres or Redis. */
	baseUrl: string;
	/** Every reading of the target's own processes, taken on the host(s) they run on. */
	probe: TargetProbe;
	memoryLimits: Record<string, MemoryLimit>;
	recordCacheSize?: number;
	harperSettings?: HarperSettings;
	/** Milliseconds from launch to accepting requests; a restore's copy is part of it. */
	startupMs: number;
	/** --auth=token: the Authorization header every generated request carries. */
	authorization?: string;
	/** --auth=token: each record owner's header, for inspect requests. */
	callerAuthorizations?: Record<string, string>;
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
	/** Remote mode: where the target's components run (default a). */
	topology?: Topology;
	/** The stack's part on this host when its services are split across hosts (an agent's launch). */
	stack?: StackPart;
}

/** Which stack services a host runs, and where Fastify finds the ones it does not. */
export interface StackPart {
	services: StackService[];
	pgUrl?: string;
	redisUrl?: string;
	redisPassword?: string;
}

/** Loaded into Harper's main thread when a target sets the verification table's size. */
const VT_PRELOAD = join(import.meta.dirname, 'vtPreload.mjs');

/** What a Harper launch is configured with; a setting left out takes Harper's default. */
export interface HarperSettings extends HarperTuning {
	threads: number;
}

export function harperSettings(
	spec: HarperTarget,
	session: Pick<Session, 'cache' | 'recordCacheSize'> & { options: { threads: number } },
	launch: LaunchOptions = {}
): HarperSettings {
	const { tuning = {} } = spec;
	const recordCacheSize =
		tuning.recordCacheSize ??
		(spec.sized || session.cache === 'cold' ? (launch.recordCacheSize ?? session.recordCacheSize) : undefined);
	const settings: HarperSettings = { threads: spec.threads ?? session.options.threads };
	if (recordCacheSize !== undefined) settings.recordCacheSize = recordCacheSize;
	for (const key of ['maxHeapMemoryMb', 'blockCacheBytes', 'verificationTableEntries'] as const) {
		if (tuning[key] !== undefined) settings[key] = tuning[key];
	}
	return settings;
}

export function harperConfig(settings: HarperSettings, auth: AuthMode): Record<string, unknown> {
	const { recordCacheSize, maxHeapMemoryMb, blockCacheBytes } = settings;
	return {
		threads: { count: settings.threads, ...(maxHeapMemoryMb ? { maxHeapMemory: maxHeapMemoryMb } : {}) },
		...(recordCacheSize || blockCacheBytes
			? {
					storage: {
						...(recordCacheSize ? { recordCacheSize } : {}),
						...(blockCacheBytes ? { rocks: { blockCacheSize: blockCacheBytes } } : {}),
					},
				}
			: {}),
		analytics: { aggregatePeriod: -1 },
		logging: { level: 'warn' },
		...(auth === 'token' ? { authentication: { authorizeLocal: false } } : {}),
	};
}

/** Harper's NODE_OPTIONS: the profiler's flags and the verification-table preload, each when needed. */
export function harperNodeOptions(profile: boolean, settings: HarperSettings): string {
	return [
		...(profile ? [PERF_NODE_OPTIONS] : []),
		...(settings.verificationTableEntries === undefined ? [] : [`--import=${pathToFileURL(VT_PRELOAD).href}`]),
	].join(' ');
}

function describeSettings(settings: HarperSettings): string {
	const parts = [`threads.count=${settings.threads}`];
	if (settings.maxHeapMemoryMb) parts.push(`threads.maxHeapMemory=${settings.maxHeapMemoryMb}`);
	if (settings.blockCacheBytes) parts.push(`storage.rocks.blockCacheSize=${settings.blockCacheBytes}`);
	if (settings.recordCacheSize) parts.push(`storage.recordCacheSize=${settings.recordCacheSize}`);
	if (settings.verificationTableEntries !== undefined)
		parts.push(`verificationTableEntries=${settings.verificationTableEntries}`);
	return parts.join(', ');
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
	const settings = harperSettings(spec, session, launch);
	const { recordCacheSize, verificationTableEntries } = settings;
	const unit = nextUnit(session, 'harper');
	const ctx = createHarperContext(`ycsb-vs-pg-${target}`);
	console.log(
		`\n=== ${target}: starting ${bin} (memory.max=${session.harperMemoryBytes}, ${describeSettings(settings)}` +
			`${launch.restore ? `, restoring ${launch.restore}` : ''}) ===`
	);
	const nodeOptions = harperNodeOptions(Boolean(session.profile), settings);
	const env: Record<string, string> = {
		HARPER_STORAGE_ENGINE: options.engine,
		YCSB_SCOPE_UNIT: unit,
		YCSB_MEMORY_MAX: Number.isFinite(session.harperMemoryBytes) ? String(session.harperMemoryBytes) : 'infinity',
		// benchmarks/ycsb/app/resources.js: who the inspect caller is
		YCSB_AUTH: session.auth,
		...(spec.uws ? { HARPER_UWS_HTTP: '1' } : {}),
		...(verificationTableEntries === undefined
			? {}
			: { YCSB_VERIFICATION_TABLE_ENTRIES: String(verificationTableEntries) }),
		...(nodeOptions ? { NODE_OPTIONS: nodeOptions } : {}),
	};
	const harperOptions = {
		harperBinPath: bin,
		config: harperConfig(settings, session.auth),
		env,
		startupTimeoutMs: options.startupTimeoutMs,
	};
	const launchedAt = Date.now();
	// A target agent's host binds Harper to the address the generator reaches instead of a pool loopback address.
	const bind = session.bindAddress;
	let started: Awaited<ReturnType<typeof startHarper>>;
	try {
		if (launch.restore) {
			// The copy runs inside Harper's scope before node starts (see writePinnedRuntime), silently,
			// so neither startup timer may fire during it.
			const root = launch.restoreRoot!;
			// Fails if it exists: a leftover from an earlier sample must never be reused.
			await mkdir(root);
			ctx.harper = { dataRootDir: root, ...(bind ? { hostname: bind } : {}) };
			env.YCSB_RESTORE_FROM = launch.restore;
			env.YCSB_RESTORE_TO = root;
			started = await startHarper(ctx, { ...harperOptions, startupTimeoutMs: 3_600_000, startupMaxMs: 3_600_000 });
		} else if (bind) {
			// What setupHarperWithFixture does, minus allocating a pool address.
			const root = await mkdtemp(
				join(process.env.HARPER_INTEGRATION_TEST_INSTALL_PARENT_DIR!, 'harper-integration-test-')
			);
			ctx.harper = { dataRootDir: root, hostname: bind };
			await cp(HARPER_APP_DIR, join(root, 'components', basename(HARPER_APP_DIR)), {
				recursive: true,
				dereference: true,
			});
			started = await startHarper(ctx, harperOptions);
		} else {
			// setupHarperWithFixture releases what it allocated if it fails; teardown owns it after.
			started = await setupHarperWithFixture(ctx, HARPER_APP_DIR, harperOptions);
		}
	} catch (error) {
		// Scope first: a copy or a Harper still running in it would race the delete.
		await stopScope(unit);
		if ((launch.restore || bind) && ctx.harper?.dataRootDir)
			await rm(ctx.harper.dataRootDir, { recursive: true, force: true });
		throw error;
	}
	try {
		const { httpURL, operationsAPIURL, admin } = started.harper;
		let credentials: Credentials | undefined;
		if (session.auth === 'token') {
			const adminBasic = `Basic ${Buffer.from(`${admin.username}:${admin.password}`).toString('base64')}`;
			await waitForRoute(`${httpURL}/${options.config.table}/`, 30_000, adminBasic);
			credentials = await harperTokenCredentials(operationsAPIURL, adminBasic, options.config.table);
			await assertCredentialChecked(`${httpURL}/${options.config.table}/auth-probe`, credentials.authorization);
		} else {
			await waitForRoute(`${httpURL}/${options.config.table}/`, 30_000);
		}
		const pid = started.harper.process.pid!;
		const cgroup = processCgroup(pid);
		console.log(`${target} ready at ${httpURL} (pid ${pid}, ${cgroup})`);
		return await body({
			baseUrl: httpURL,
			probe: localProbe({
				targets: { processes: {}, cgroups: { harper: cgroup } },
				pinned: { harper: pid },
				cpus: session.serverCpus,
				workDir: RESULTS_DIR,
				dataRoot: started.harper.dataRootDir,
				separateSelf: session.separateSelf,
			}),
			memoryLimits: {
				harper: verifyMemoryLimit('harper', cgroup, session.harperMemoryBytes, MEMORY_BUDGET_BYTES),
			},
			recordCacheSize,
			harperSettings: settings,
			...credentials,
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
		if (bind) {
			// teardownHarper would return a non-pool address to the loopback pool, which throws. stopScope
			// confirms nothing of this Harper still runs (or holds its ports) before its directory goes.
			await killHarper(started);
		} else {
			await teardownHarper(started);
		}
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
	const part = launch.stack;
	console.log(
		`\n=== ${target}: starting ${part ? `${part.services.join('+')} ` : ''}(fastify workers=${options.threads}, cache=${useCache}` +
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
		services: part?.services,
		listen: session.bindAddress,
		pgUrl: part?.pgUrl,
		redisUrl: part?.redisUrl,
		redisPassword: part?.redisPassword,
	});
	try {
		const secret = session.jwtSecret;
		const authorization = secret && stack.baseUrl ? `Bearer ${mintHs256(secret, TOKEN_USER)}` : undefined;
		const callerAuthorizations =
			secret && stack.baseUrl
				? Object.fromEntries(OWNERS.map((owner) => [owner, `Bearer ${mintHs256(secret, owner)}`]))
				: undefined;
		if (stack.baseUrl) {
			await waitForRoute(`${stack.baseUrl}/${options.config.table}/`, 30_000, authorization);
			if (authorization)
				await assertCredentialChecked(`${stack.baseUrl}/${options.config.table}/auth-probe`, authorization);
			console.log(`${target} ready at ${stack.baseUrl}`);
		}
		const hasPostgres = stack.services.includes('postgres');
		return await body({
			baseUrl: stack.baseUrl ?? '',
			probe: localProbe({
				targets: { processes: {}, cgroups: stack.cgroups, redisExec: useCache ? stack.redisExec : undefined },
				pinned: stack.appPid ? { fastify: stack.appPid } : {},
				cpus: session.serverCpus,
				workDir: RESULTS_DIR,
				separateSelf: session.separateSelf,
			}),
			memoryLimits: stack.memoryLimits,
			authorization,
			callerAuthorizations,
			startupMs: stack.startupMs,
			afterLoad: hasPostgres ? stack.vacuum : undefined,
			checkpoints: hasPostgres ? stack.checkpoints : undefined,
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
	if (session.remote) return withRemoteTarget(session, target, body, launch);
	try {
		return TARGETS[target].kind === 'stack'
			? await withPgStack(session, target, body, launch)
			: await withHarper(session, target, body, launch);
	} finally {
		if (session.profile) await removePerfMaps();
	}
}

export function assertNoErrors(phase: string, result: PhaseResult): void {
	if (result.errors > 0) throw new Error(`${phase}: ${result.errors} failed requests — sample invalid`);
}

/** The target's threads; the generator checks its own as each phase starts (DriverConfig.cpus). */
function verifyPlacement(running: Running): Promise<number> {
	return running.probe.verifyPlacement();
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
	/** Harper: the threads and memory settings the target launched with. */
	harperSettings?: HarperSettings;
	/** Page-cache refaults (pages read again after eviction) per component during the window: the reads that went to disk. */
	refaultFilePages: Record<string, number>;
	affinityVerifiedThreads: number;
	/** Wall clock of the measured run, epoch ms. */
	window: { startMs: number; endMs: number };
	/**
	 * CPU busy on the host outside this run during the window, and the 1-min load average at its end. In
	 * remote mode, the busiest of the target hosts and the generator's, each kept in `hosts`.
	 */
	host: HostLoad;
	hosts?: Record<string, HostLoad>;
	/** With --perf-counters or --profile: hardware counters over the measured window, per component and summed. */
	perf?: { byComponent: Record<string, Counters>; total: Counters };
	/** Counted cycles over CPU-seconds: the clock the target ran at where cpufreq is absent (a VM, turbo on). */
	perfClockGHz?: number;
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
	const steadyResult = await runInWindow(session, running, { counters: true, baselineAfterPerf: true }, (window) =>
		driver.runWorkload(workload, distribution, ops, undefined, window)
	);
	const byComponent = steadyResult.reading.perf!;
	const steadyDelta: ResourceDelta = diffResources(steadyResult.reading.before, steadyResult.reading.after);
	assertNoErrors(`steady ${workload}`, steadyResult.result);
	const steady = {
		ops: steadyResult.result.ops,
		throughput: steadyResult.result.throughput,
		cpuMicrosPerOp: (steadyDelta.totalCpuSeconds * 1e6) / steadyResult.result.ops,
		perf: { byComponent, total: sumCounters(byComponent) },
	};
	const t = steady.perf.total;
	console.log(
		`  [steady ${label}] ${steady.throughput.toFixed(0)} ops/sec, ${steady.cpuMicrosPerOp.toFixed(1)} CPU µs/op, ` +
			`${((t.instructionsUser + t.instructionsKernel) / steady.ops / 1000).toFixed(1)}k instructions/op, ` +
			`IPC ${((t.instructionsUser + t.instructionsKernel) / (t.cyclesUser + t.cyclesKernel)).toFixed(2)}`
	);
	const recorded = await runInWindow(session, running, { recordPrefix: prefix, baselineAfterPerf: true }, (window) =>
		driver.runWorkload(workload, distribution, ops, undefined, window)
	);
	const { result } = recorded;
	const delta = diffResources(recorded.reading.before, recorded.reading.after);
	const host = recorded.reading.host;
	assertNoErrors(`profiled ${workload}`, result);
	// Folded while the target still runs: symbols come from its live JIT maps and container roots.
	const samples = await running.probe.fold(prefix);
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
/**
 * Runs `run` with one target-side window, which the generator opens as its iterations start and closes
 * as they end. A failed run still closes an open window (a perf left counting would run into the next
 * sample). In remote mode the window also covers the generator's own host.
 */
async function runInWindow<T>(
	session: Session,
	running: Running,
	options: Parameters<TargetProbe['beginWindow']>[0],
	run: (window: PhaseWindow) => Promise<T>
): Promise<{
	result: T;
	reading: Awaited<ReturnType<TargetProbe['endWindow']>>;
	window: { startMs: number; endMs: number };
	generatorHost?: HostLoad;
}> {
	let open = false;
	let reading: Awaited<ReturnType<TargetProbe['endWindow']>> | undefined;
	let generatorHost: ReturnType<typeof startHostLoad> | undefined;
	let generatorLoad: HostLoad | undefined;
	const window = { startMs: 0, endMs: 0 };
	try {
		const result = await run({
			async begin() {
				await running.probe.beginWindow(options);
				open = true;
				window.startMs = Date.now();
				// Remote mode: the generator's host, which the target hosts' readings do not cover.
				if (session.remote) generatorHost = startHostLoad();
			},
			async end() {
				open = false;
				window.endMs = Date.now();
				generatorLoad = await generatorHost?.stop();
				reading = await running.probe.endWindow();
			},
		});
		if (!reading) throw new Error('the generator ran without opening and closing its window');
		return { result, reading, window, generatorHost: generatorLoad };
	} finally {
		if (open) await running.probe.endWindow().catch(() => {});
	}
}

export async function measureWindow(
	session: Session,
	running: Running,
	driver: DriverRun,
	workload: string,
	distribution: DistributionName,
	ops?: number,
	label = workload
): Promise<MeasuredWindow> {
	const affinityVerifiedThreads = await verifyPlacement(running);
	const checkpointsBefore = await running.checkpoints?.();
	const { result, reading, window, generatorHost } = await runInWindow(
		session,
		running,
		{ counters: session.perfCounters, memory: true, clock: true, refaults: true },
		(phaseWindow) => driver.runWorkload(workload, distribution, ops, undefined, phaseWindow)
	);
	const { generatorCpuSeconds } = result;
	const { before, after, cgroupMemory, meanClockGHz } = reading;
	const refaultFilePages = reading.refaultFilePages ?? {};
	const peaks = reading.memory!;
	let hostLoad = reading.host;
	let hosts = reading.hosts;
	if (generatorHost) {
		hosts = { ...(hosts ?? { target: reading.host }), generator: generatorHost };
		hostLoad = mergeHostLoads(hosts);
	}
	const perf: MeasuredWindow['perf'] = reading.perf && { byComponent: reading.perf, total: sumCounters(reading.perf) };
	for (const [name, memory] of Object.entries(cgroupMemory)) {
		// Every component's cgroup is created for this sample, so any kill belongs to it.
		const kills = memory.events.oom_kill ?? 0;
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
	const perfClockGHz =
		perf && meanClockGHz === 0 && resources.totalCpuSeconds > 0
			? (perf.total.cyclesUser + perf.total.cyclesKernel) / (resources.totalCpuSeconds * 1e9)
			: undefined;
	if (
		before.redis &&
		after.redis &&
		(after.redis.hits < before.redis.hits || after.redis.misses < before.redis.misses)
	) {
		throw new Error('Redis counters went backwards during the measured run (restart?) — sample invalid');
	}
	let redisHitRate: number | undefined;
	if (running.probe.hasRedis) {
		const spec = WORKLOADS[workload];
		const lookups = resources.redisHits + resources.redisMisses;
		const pointReads = (spec.mix.read ?? 0) + (spec.mix.rmw ?? 0) + (spec.mix.inspect ?? 0) + (spec.mix.chain ?? 0) > 0;
		if (pointReads && lookups === 0) throw new Error(`workload ${workload}: no Redis lookups recorded`);
		if (lookups > 0) redisHitRate = resources.redisHits / lookups;
	}
	const cpuMicrosPerOp = (resources.totalCpuSeconds * 1e6) / result.ops;
	const overBudget = peaks.peakTotalBytes > MEMORY_BUDGET_BYTES;
	console.log(
		`  [${workload}] ${result.throughput.toFixed(0)} ops/sec, ` +
			`${cpuMicrosPerOp.toFixed(1)} server CPU µs/op @ ${(perfClockGHz ?? meanClockGHz).toFixed(2)} GHz, ` +
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
		harperSettings: running.harperSettings,
		refaultFilePages,
		affinityVerifiedThreads,
		window,
		host: hostLoad,
		...(hosts ? { hosts } : {}),
		perf,
		...(perfClockGHz === undefined ? {} : { perfClockGHz }),
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
	placed: PlacedTarget,
	workload: string,
	rep: number,
	position: number
): Promise<Sample> {
	const { config } = session.options;
	const { target, topology } = placed;
	const keyWidth = Math.max(10, String(config.records + config.opsPerWorkload).length);
	const spec = WORKLOADS[workload];
	const distribution = (config.distribution ?? spec.distribution) as DistributionName;

	console.log(`\n--- rep ${rep + 1} #${position} ${placed.name} / workload ${workload} (${spec.description}) ---`);
	const placement = session.remote
		? {
				topology,
				...(topology === 'b' ? { note: B_TOPOLOGY_NOTE, rtt: await session.remote.backendRtt() } : {}),
			}
		: {};
	return withTarget(
		session,
		target,
		async (running) => {
			const driver = await startGenerator(
				session.generator,
				{
					baseUrl: running.baseUrl,
					table: config.table,
					records: config.records,
					opsPerWorkload: config.opsPerWorkload,
					concurrency: config.concurrency,
					shape: { fieldCount: config.fieldCount, fieldLength: config.fieldLength },
					keyWidth,
					maxScanLength: config.maxScanLength,
					authorization: running.authorization,
					callerAuthorizations: running.callerAuthorizations,
					cpus: session.driverCpus,
				},
				session.shards
			);
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
				if (usesDependentReads(spec)) await assertDependentReads(running, config, keyWidth);

				const measured = await measureWindow(
					session,
					running,
					driver,
					workload,
					distribution,
					undefined,
					`${placed.name.replace('@', '-')}-${workload}-${session.cache}-rep${rep + 1}`
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
					...placement,
					workload,
					auth: session.auth,
					generator: session.generator,
					load: driver.load,
					warm,
					measured,
				};
			} finally {
				await driver.close();
			}
		},
		{ topology }
	);
}

/** Rep `r` runs the targets forward on even reps and reversed on odd ones. */
export function targetOrder<T>(targets: readonly T[], rep: number): T[] {
	return rep % 2 === 0 ? [...targets] : [...targets].reverse();
}

function median<T>(items: T[], by: (item: T) => number): T {
	const sorted = [...items].sort((a, b) => by(a) - by(b));
	return sorted[Math.floor((sorted.length - 1) / 2)];
}

/** The latency block of a workload's primary operation (reads, inspect, chain, scans, else the first). */
export function primaryLatency(result: PhaseResult): LatencyStats | undefined {
	return (
		result.latency.read ??
		result.latency.inspect ??
		result.latency.chain ??
		result.latency.scan ??
		(Object.values(result.latency)[0] as LatencyStats | undefined)
	);
}

interface Summary {
	/** The target, with @b for topology b. */
	target: string;
	workload: string;
	throughputs: number[];
	median: Sample;
}

function summarize(samples: Sample[], targets: string[], workloads: string[]): Summary[] {
	const out: Summary[] = [];
	for (const workload of workloads) {
		for (const target of targets) {
			const mine = samples.filter((s) => placedName(s) === target && s.workload === workload);
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
		session.remote
			? `Remote targets: ${session.remote.describe()}; generator on ${session.driverCpus.join(',')}; cache=${session.cache}`
			: `Equal CPU budget: every target on cpus ${session.serverCpus.join(',')} (${session.serverCpus.length} cores); ` +
					`generator on ${session.driverCpus.join(',')}; cache=${session.cache}`
	);
	out.push('Median of reps by throughput; CPU µs/op, memory, hit rate and latency are from that median rep.');
	for (const target of new Set(summaries.map((s) => s.target))) {
		const [name, topology] = target.split('@');
		out.push(
			`  ${target.padEnd(16)} ${TARGETS[name as TargetName].label}${topology === 'b' ? ` — ${B_TOPOLOGY_NOTE}` : ''}`
		);
	}
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

/** Harper inherits this environment: an exported value would silently retune or re-back a target. */
const TARGET_ENV = [
	// Core treats any non-empty HARPER_UWS_HTTP as on, "0" included.
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
];

/**
 * What a host that runs targets needs before the first launch, in single-host mode and on a target
 * agent's host alike: a clean inherited environment, Harper's pinned launch wrapper, the data
 * directories on one real filesystem, and a private TMPDIR and loopback pool. Returns the data dir.
 */
export async function prepareTargetHost(serverCpus: number[]): Promise<string> {
	for (const name of TARGET_ENV) delete process.env[name];
	process.env.HARPER_RUNTIME = await writePinnedRuntime(RESULTS_DIR, serverCpus);
	const { base } = await prepareDataDirs();
	// The loopback pool keeps its registry in tmpdir() and indexes it by slot, so neither the file nor
	// the addresses may be shared with Harper tests elsewhere on the host: a shared file with another
	// range mis-maps slots, and a private file with the default range lets a test co-bind our ports.
	// Set before @harperfast/integration-testing is first imported (withHarper), which reads both.
	process.env.TMPDIR = join(base, 'tmp');
	await mkdir(process.env.TMPDIR, { recursive: true });
	process.env.HARPER_INTEGRATION_TEST_LOOPBACK_POOL_START = '240';
	process.env.HARPER_INTEGRATION_TEST_LOOPBACK_POOL_COUNT = '8';
	return base;
}

/** HEAD of a checkout, or the REVISION file an exported (git archive) tree carries instead. */
/**
 * SHA-256 of the built files that the temporary record-cache probes patch in place (README, "A
 * Redis-sized record cache"): a digest that differs from a clean build's marks an instrumented session.
 */
export function buildDigests(root: string): Record<string, string> {
	const digests: Record<string, string> = {};
	for (const file of ['dist/resources/PrimaryRocksDatabase.js', 'node_modules/weak-lru-cache/dist/index.cjs']) {
		const path = join(root, file);
		digests[file] = existsSync(path) ? createHash('sha256').update(readFileSync(path)).digest('hex') : 'missing';
	}
	return digests;
}

export function gitRevision(root: string): string {
	try {
		return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: 'pipe' }).trim();
	} catch {
		return readSysfs(join(root, 'REVISION')) ?? 'unknown';
	}
}

export function readSysfs(path: string): string | undefined {
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

/** One per target core: the session's target cpus, or in remote mode (where the agents pick them) --target-cpus. */
export function defaultThreads(serverCpus: number[], argv: string[]): number {
	if (serverCpus.length > 0) return serverCpus.length;
	const k = Number(argValue(argv, '--target-cpus') ?? 4);
	if (!Number.isInteger(k) || k < 1) throw new Error(`--target-cpus must be a positive integer, got ${k}`);
	return k;
}

/**
 * Everything a comparison session shares: target validation, CPU placement, Harper's launch
 * wrapper, a clean inherited environment, the data directories and the recorded conditions.
 * `ownFlags` are the caller's own flags, kept away from the YCSB option parser.
 */
export async function createSession(
	argv: string[],
	{
		targets: placedTargets,
		cache,
		stackMemory,
		ownFlags = [],
	}: {
		/** With --hosts, a target may carry its topology (`pg-redis@b`). */
		targets: PlacedTarget[];
		cache: CacheMode;
		stackMemory: (target: 'pg-redis' | 'pg-only') => StackMemory;
		ownFlags?: string[];
	}
): Promise<{ session: Session; meta: Record<string, unknown> }> {
	const targets = [...new Set(placedTargets.map((p) => p.target))];
	const hostsFile = argValue(argv, '--hosts');
	if (argv.includes('--uws')) {
		throw new Error('--uws is gone: the HTTP backend is part of the target (harper-uws, harper-uws-sized)');
	}
	if (cache === 'cold') {
		// Cold Postgres is pg-only. A sized or tuned target is a warm configuration by definition, and a
		// base build need not read storage.recordCacheSize (6d725818 does not).
		const refused = targets.filter((t) => {
			const spec: HarperTarget | StackTarget = TARGETS[t];
			return spec.kind === 'stack' ? spec.cache : spec.sized || spec.base || spec.tuning !== undefined;
		});
		if (refused.length > 0) throw new Error(`--cache=cold does not support ${refused.join(', ')}`);
	}
	const generator = (argValue(argv, '--generator') ?? defaultGenerator(Boolean(hostsFile))) as GeneratorName;
	if (generator !== 'k6' && generator !== 'node') throw new Error(`--generator must be k6 or node, got ${generator}`);
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
	// Remote mode: each agent checks its own build; the generator needs none.
	if (!hostsFile)
		for (const bin of [harperBin, baseHarperBin])
			if (bin && !existsSync(bin)) throw new Error(`${bin} not found — build it first`);

	const topology = readTopology();
	const serverArg = argValue(argv, '--serverCpus');
	const driverArg = argValue(argv, '--driverCpus');
	let serverCpus: number[];
	let driverCpus: number[];
	if (hostsFile) {
		// The target cpus are each agent's to choose (or --serverCpus, passed to them); this host only drives.
		serverCpus = serverArg ? parseCpuList(serverArg) : [];
		driverCpus = driverArg ? parseCpuList(driverArg) : topology.map((t) => t.cpu);
	} else if (serverArg || driverArg) {
		if (!serverArg || !driverArg) throw new Error('--serverCpus and --driverCpus go together');
		serverCpus = parseCpuList(serverArg);
		driverCpus = parseCpuList(driverArg);
	} else {
		({ server: serverCpus, driver: driverCpus } = chooseCpuSets(
			topology,
			Number(argValue(argv, '--target-cpus') ?? 4)
		));
	}
	if (!hostsFile) assertDisjointCores(topology, serverCpus, driverCpus);

	const sessionFlags = [
		'targets',
		'generator',
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
		'hosts',
	];
	const passthrough = argv.filter((a) => {
		if (a === '--perf-counters') return false;
		const name = /^--([^=]+)=/.exec(a)?.[1];
		return !name || ![...sessionFlags, ...ownFlags].includes(name);
	});
	// Harper threads and Fastify workers default to one per target core.
	if (!passthrough.some((a) => a.startsWith('--threads')))
		passthrough.push(`--threads=${defaultThreads(serverCpus, argv)}`);
	const options = parseOptions(passthrough);
	const sizesCache = targets.some((t) => {
		const spec = TARGETS[t];
		return spec.kind === 'harper' && (spec.sized || cache === 'cold');
	});
	const tuned = targets.filter((t) => {
		const spec: HarperTarget | StackTarget = TARGETS[t];
		return spec.kind === 'harper' && spec.tuning !== undefined;
	});
	if ((sizesCache || tuned.length > 0) && options.engine !== 'rocksdb') {
		throw new Error(
			`storage.recordCacheSize and the RocksDB tuning of ${tuned.join(', ') || 'sized targets'} only apply to the rocksdb engine, not ${options.engine}`
		);
	}

	// This process, and the generator shards it forks, run on the generator cores.
	await pinPid(process.pid, driverCpus);
	const base = hostsFile ? undefined : await prepareTargetHost(serverCpus);

	const profileDir = argValue(argv, '--profile');
	// instructions/op is the stable metric where turbo cannot be turned off, so a remote session always counts.
	const perfCounters = Boolean(profileDir) || argv.includes('--perf-counters') || Boolean(hostsFile);
	if (perfCounters && !hostsFile) await perfAvailable();
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
		generator,
		shards: Number(argValue(argv, '--shards') ?? 4),
		serverCpus,
		driverCpus,
		harperBin,
		baseHarperBin,
		recordCacheSize: cache === 'warm' ? sizedRecordCacheSize(options.config.records) : 4,
		harperMemoryBytes: harperMemory === 'capped' ? MEMORY_BUDGET_BYTES : Infinity,
		stackMemory,
		unitPrefix: `ycsb-vs-pg-${process.pid}`,
		units: { count: 0 },
		perfCounters,
		profile,
		auth,
		jwtSecret: auth === 'token' ? randomBytes(32).toString('base64url') : undefined,
	};

	if (base) {
		console.log(`Data directories under ${base} (real disk, single filesystem)`);
		console.log(`Target cpus ${serverCpus.join(',')}, generator cpus ${driverCpus.join(',')}, cache=${cache}`);
	}
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
		generator: generator === 'k6' ? { name: 'k6', version: k6Version() } : { name: 'node', shards: session.shards },
		dataDir: base,
		harper: { bin: harperBin, revision: gitRevision(REPO_ROOT), digests: buildDigests(REPO_ROOT) },
		perfPmu: perfCounters && !hostsFile ? detectPmu() : undefined,
		harperBase: baseHarperBin
			? { bin: baseHarperBin, revision: gitRevision(join(baseHarperBin, '..', '..', '..')) }
			: undefined,
		// --threads: Fastify's workers, and Harper's threads unless the target sets its own (harperSettings)
		config: { ...options.config, threads: options.threads, engine: options.engine },
		// What each Harper target fixes; a sized target's cache size follows its dataset, so only rows have it.
		harperSettings: Object.fromEntries(
			targets.flatMap((t) => {
				const spec: HarperTarget | StackTarget = TARGETS[t];
				if (spec.kind !== 'harper') return [];
				const settings = harperSettings(spec, session);
				if (spec.sized) delete settings.recordCacheSize;
				return [[t, settings]];
			})
		),
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
	if (hostsFile) {
		session.remote = await connectRemote(session, hostsFile, placedTargets, {
			targetCpus: Number(argValue(argv, '--target-cpus') ?? 4),
			baseHarperBin: baseHarperArg,
			generatorTopology: topology,
		});
		Object.assign(meta, { remote: session.remote.meta });
		// Every host's facts are the agents'; this host's are the generator's.
		console.log(`Remote targets: ${session.remote.describe()}; generator cpus ${driverCpus.join(',')}, cache=${cache}`);
	}
	return { session, meta };
}

async function main(): Promise<void> {
	const argv = process.argv.slice(2);
	const targets = parsePlacedTargets(argValue(argv, '--targets') ?? 'harper,pg-redis', {
		remote: argValue(argv, '--hosts') !== undefined,
	});
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
	let failed = true;
	try {
		await runComparison(session, meta, targets, { hostQuietCores, hostQuietMaxMin, sharedCgroup });
		failed = false;
	} finally {
		await closeRemote(session, failed);
	}
}

/** Closes the agents after a session; a close failure after the session already failed is reported, not raised over it. */
export async function closeRemote(session: Session, sessionFailed: boolean): Promise<void> {
	await session.remote?.close().catch((error) => {
		if (!sessionFailed) throw error;
		console.error(`closing the target agents failed too: ${(error as Error).message}`);
	});
}

/**
 * The host gate before a sample: this host, and in remote mode every host the target runs on (where
 * the target agent's own CPU counts as neither the target's nor the rest of the host's).
 */
export async function waitForQuietHosts(
	session: Session,
	placed: PlacedTarget | undefined,
	gate: { maxOtherCores: number; maxMs: number }
): Promise<{
	waitedMs: number;
	quiet: boolean;
	last: HostLoad;
	byHost?: Record<string, HostLoad>;
	sharedCgroup?: true;
}> {
	if (!session.remote) return waitForQuietHost(gate);
	return session.remote.waitForQuietHosts(placed, gate, () => waitForQuietHost(gate));
}

async function runComparison(
	session: Session,
	meta: Record<string, unknown>,
	targets: PlacedTarget[],
	{
		hostQuietCores,
		hostQuietMaxMin,
		sharedCgroup,
	}: { hostQuietCores?: number; hostQuietMaxMin: number; sharedCgroup: boolean }
): Promise<void> {
	const { options } = session;
	const file = join(RESULTS_DIR, `compare-${meta.timestamp}.json`);
	const runMeta = { ...meta, targetOrderRule: 'forward on even reps, reversed on odd reps' };
	const names = targets.map((t) => t.name);

	const samples: Sample[] = [];
	const persist = async (summaries?: Summary[]) => {
		const payload = { meta: runMeta, targets: names, samples, summaries };
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
						: await waitForQuietHosts(session, order[i], {
								maxOtherCores: hostQuietCores,
								maxMs: hostQuietMaxMin * 60_000,
							});
				if (gate) {
					console.log(
						`  [host] ${gate.last.otherCores.toFixed(2)} cores busy elsewhere` +
							(gate.quiet ? '' : ' — not quiet, running anyway') +
							` (waited ${(gate.waitedMs / 1000).toFixed(0)} s)`
					);
				}
				const sample = await measureSample(session, order[i], workload, rep, i + 1);
				if (gate) {
					sample.hostGate = { waitedMs: gate.waitedMs, quiet: gate.quiet, load: gate.last, byHost: gate.byHost };
					if (sharedCgroup || gate.sharedCgroup || foreignProcessesInOwnCgroup().length > 0) sample.sharedCgroup = true;
				}
				samples.push(sample);
				await persist();
			}
		}
	}
	const summaries = summarize(samples, names, options.config.workloads);
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
