/**
 * Lifecycle for the Postgres + Redis + Fastify comparison stack: brings up the
 * docker-compose services with a fresh or restored PGDATA, boots the Fastify
 * cluster in its own capped scope, and tears everything down again.
 */
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { join, resolve } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import {
	verifyAffinity,
	verifyCgroupCpuset,
	verifyMemoryLimit,
	processCgroup,
	scopedCommand,
	stopScope,
	type MemoryLimit,
} from './resources.mts';

const exec = promisify(execFile);
const DIR = import.meta.dirname;
const COMPOSE = ['compose', '-f', join(DIR, 'docker-compose.yml'), '-p', 'ycsb-vs-pg'];

/** Where PGDATA lives on the host. Must be a real disk, and the same filesystem Harper uses. */
export const dataDir = (): string => resolve(process.env.YCSB_VS_PG_DATA_DIR || join(DIR, 'data'));

const MiB = 1024 ** 2;

/**
 * How a target's memory budget is split across the stack. Every part is a hard cap with swap off:
 * the containers by `mem_limit` (page cache and shared_buffers included), the Fastify cluster by
 * its user scope. The stack picks this split once; a run records it.
 */
export interface StackMemory {
	fastifyMiB: number;
	postgresMiB: number;
	sharedBuffersMiB: number;
	effectiveCacheMiB: number;
	redisMiB: number;
	redisMaxmemoryMiB: number;
}

/** run-compare's split (the #3736 run's containers, plus a Fastify cap): 1 + 6 + 1 = 8 GiB. */
export const WARM_STACK_MEMORY: StackMemory = {
	fastifyMiB: 1024,
	postgresMiB: 6144,
	sharedBuffersMiB: 4096,
	effectiveCacheMiB: 6144,
	redisMiB: 1024,
	redisMaxmemoryMiB: 768,
};

/**
 * memory-sweep's splits, each summing to 8 GiB of charged memory. pg-only gives Postgres the share
 * pg-redis spends on Redis; its Redis container still runs (one compose file) but is never used or charged.
 */
export const SWEEP_STACK_MEMORY: Record<'pg-redis' | 'pg-only', StackMemory> = {
	'pg-redis': {
		fastifyMiB: 1024,
		postgresMiB: 3584,
		sharedBuffersMiB: 1024,
		effectiveCacheMiB: 2560,
		redisMiB: 3584,
		redisMaxmemoryMiB: 3072,
	},
	'pg-only': {
		fastifyMiB: 1024,
		postgresMiB: 7168,
		sharedBuffersMiB: 2048,
		effectiveCacheMiB: 5120,
		redisMiB: 256,
		redisMaxmemoryMiB: 64,
	},
};

const composeEnv = (cpuset: string, memory: StackMemory, restore = ''): NodeJS.ProcessEnv => ({
	...process.env,
	YCSB_VS_PG_DATA_DIR: dataDir(),
	YCSB_TARGET_CPUSET: cpuset,
	YCSB_PG_MEM_LIMIT: `${memory.postgresMiB}m`,
	YCSB_PG_SHARED_BUFFERS: `${memory.sharedBuffersMiB}MB`,
	YCSB_PG_EFFECTIVE_CACHE_SIZE: `${memory.effectiveCacheMiB}MB`,
	YCSB_REDIS_MEM_LIMIT: `${memory.redisMiB}m`,
	YCSB_REDIS_MAXMEMORY: process.env.YCSB_REDIS_MAXMEMORY || `${memory.redisMaxmemoryMiB}mb`,
	YCSB_PG_RESTORE: restore,
});

/** Runs `script` as root in a throwaway container with the data dir at /host-data (PGDATA is owned by postgres' uid). */
async function asRootInDataDir(script: string, timeoutMs: number): Promise<void> {
	const base = dataDir();
	await mkdir(base, { recursive: true });
	await exec('docker', ['run', '--rm', '-v', `${base}:/host-data`, 'alpine:latest', 'sh', '-c', script], {
		timeout: timeoutMs,
	});
}

/**
 * Removes the previous run's PGDATA. `docker compose down -v` only drops named
 * volumes, so a bind mount would otherwise carry a run's WAL and bloat into the
 * next one — exactly the cross-run contamination the per-workload restarts exist
 * to prevent.
 */
const wipePgData = () => asRootInDataDir('rm -rf /host-data/pgdata', 30 * 60_000);

/** Deletes every Postgres dataset snapshot memory-sweep.mts made. */
export const removePgSnapshots = () => asRootInDataDir('rm -rf /host-data/snapshots/pg-*', 30 * 60_000);

export const PG_URL = 'postgres://ycsb:ycsb@127.0.0.1:5433/ycsb';
export const REDIS_URL = 'redis://127.0.0.1:6380';
export const PG_APP_PORT = 9940;

const SNAPSHOT_NAME = /^pg-[a-z0-9-]+$/;

export interface PgStackOptions {
	workers: number;
	useCache: boolean;
	fields: number;
	poolSize: number;
	/** CPUs the whole server side (Fastify + Postgres + Redis) shares, with no per-service split. */
	serverCpus: number[];
	memory: StackMemory;
	/** Systemd unit name for the Fastify cluster's scope; unique per sample. */
	fastifyUnit: string;
	/** Start from this snapshot (see `snapshot`) instead of an empty table. */
	restore?: string;
}

export interface PgStack {
	baseUrl: string;
	/** The Fastify cluster's primary; its workers are its children. */
	appPid: number;
	/**
	 * VACUUM ANALYZE after the bulk load: sets hint bits and planner stats up front, as an
	 * operator would, so neither they nor an autovacuum triggered by the load land in a
	 * measured run. Through Fastify the read-all pass cannot do it for pg-redis — the load's
	 * write-through already cached every row, so it never reaches Postgres.
	 */
	vacuum(): Promise<void>;
	/** Checkpoints completed so far (timed + requested), so a measured window can report its own. */
	checkpoints(): Promise<number>;
	/**
	 * Checkpoints, shuts Postgres down cleanly, and moves PGDATA to `snapshots/<name>`. The stack is
	 * unusable afterwards except for `stop()`.
	 */
	snapshot(name: string): Promise<void>;
	/** Every component's cgroup: the Fastify scope and the containers. */
	cgroups: Record<string, string>;
	/** Each component's verified memory limit. */
	memoryLimits: Record<string, MemoryLimit>;
	/** Command that prints Redis INFO stats, for cache hit-rate sampling. */
	redisExec: string[];
	/** Milliseconds from `compose up` to Postgres accepting connections: the snapshot copy, when restoring. */
	startupMs: number;
	stop(): Promise<void>;
}

export async function startPgStack(options: PgStackOptions): Promise<PgStack> {
	if (options.restore && !SNAPSHOT_NAME.test(options.restore)) throw new Error(`bad snapshot name ${options.restore}`);
	const env = composeEnv(options.serverCpus.join(','), options.memory, options.restore);
	const compose = (args: string[], timeoutMs = 10 * 60_000) =>
		exec('docker', [...COMPOSE, ...args], { maxBuffer: 1 << 24, env, timeout: timeoutMs });
	const composeDown = () => compose(['down', '-v', '-t', '300']);
	// Stop first, and let a failure abort: `up -d` will not recreate an already-running
	// container, so wiping PGDATA while one is live deletes the data directory out from under it.
	await composeDown();
	await wipePgData();
	// Created as the host user before compose would create it as root.
	await mkdir(join(dataDir(), 'snapshots'), { recursive: true });
	let child: ChildProcess | undefined;
	const stop = async (): Promise<void> => {
		child?.kill('SIGKILL');
		await stopScope(options.fastifyUnit);
		await composeDown();
	};
	try {
		return await startServices(options, compose, (spawned) => (child = spawned), stop);
	} catch (error) {
		await stop().catch(() => {});
		throw error;
	}
}

async function startServices(
	options: PgStackOptions,
	compose: (args: string[], timeoutMs?: number) => Promise<{ stdout: string }>,
	onSpawn: (child: ChildProcess) => void,
	stop: () => Promise<void>
): Promise<PgStack> {
	const psql = (sql: string, timeoutMs = 60_000) =>
		compose(['exec', '-T', 'postgres', 'psql', '-p', '5433', '-U', 'ycsb', '-d', 'ycsb', '-tAc', sql], timeoutMs);
	const containerCgroup = async (service: string): Promise<string> => {
		const id = (await compose(['ps', '-q', service])).stdout.trim();
		const scope = `/sys/fs/cgroup/system.slice/docker-${id}.scope`;
		if (!id || !existsSync(scope)) throw new Error(`no cgroup scope for ${service} at ${scope}`);
		return scope;
	};

	// The containers get their cpuset at creation (compose `cpuset`), so initdb and every
	// Postgres backend forked later are inside it from the start.
	const upAt = Date.now();
	await compose(['up', '-d']);
	// A restore copies the snapshot before Postgres listens; the probe only succeeds once it has.
	await waitForPostgres(compose, options.restore ? 60 * 60_000 : 120_000);
	const startupMs = Date.now() - upAt;

	if (!options.restore) {
		// Fresh dataset per run: the harness load phase inserts sequential keys, and
		// leftover rows would change both the row count and the cache hit profile.
		await psql('DROP TABLE IF EXISTS usertable');
	}
	await compose(['exec', '-T', 'redis', 'redis-cli', '-p', '6380', 'flushall']);

	// The scope and taskset are both in place before node starts: the cluster primary and every
	// worker it forks inherit the cpuset and the memory cap.
	const [command, ...args] = [
		...scopedCommand(options.fastifyUnit, options.memory.fastifyMiB * MiB),
		'taskset',
		'-c',
		options.serverCpus.join(','),
		process.execPath,
		join(DIR, 'pg-app', 'server.mjs'),
	];
	const child: ChildProcess = spawn(command, args, {
		env: {
			...process.env,
			PORT: String(PG_APP_PORT),
			WORKERS: String(options.workers),
			FIELDS: String(options.fields),
			PG_POOL: String(options.poolSize),
			USE_CACHE: String(options.useCache),
			PG_URL,
			REDIS_URL,
		},
		stdio: ['ignore', 'pipe', 'inherit'],
	});
	onSpawn(child);

	await new Promise<void>((resolve, reject) => {
		let buffer = '';
		const timer = setTimeout(() => reject(new Error('pg-app did not report ready')), 60_000);
		child.stdout!.on('data', (chunk: Buffer) => {
			buffer += chunk.toString();
			process.stdout.write(chunk);
			if (buffer.includes('PG_APP_READY')) {
				clearTimeout(timer);
				resolve();
			}
		});
		child.on('error', reject);
		child.on('exit', (code) => reject(new Error(`pg-app exited early with ${code}`)));
	});

	const cgroups: Record<string, string> = {
		fastify: processCgroup(child.pid!),
		postgres: await containerCgroup('postgres'),
	};
	if (options.useCache) cgroups.redis = await containerCgroup('redis');
	for (const [name, scope] of Object.entries(cgroups)) {
		if (name !== 'fastify') await verifyCgroupCpuset(name, scope, options.serverCpus);
	}
	verifyAffinity('fastify', child.pid!, options.serverCpus);
	const { memory } = options;
	const memoryLimits: Record<string, MemoryLimit> = {
		fastify: verifyMemoryLimit('fastify', cgroups.fastify, memory.fastifyMiB * MiB),
		postgres: verifyMemoryLimit('postgres', cgroups.postgres, memory.postgresMiB * MiB),
	};
	if (cgroups.redis) memoryLimits.redis = verifyMemoryLimit('redis', cgroups.redis, memory.redisMiB * MiB);

	return {
		baseUrl: `http://127.0.0.1:${PG_APP_PORT}`,
		appPid: child.pid!,
		cgroups,
		memoryLimits,
		startupMs,
		async vacuum(): Promise<void> {
			await psql('VACUUM (ANALYZE) usertable', 4 * 60 * 60_000);
		},
		async checkpoints(): Promise<number> {
			const { stdout } = await psql('SELECT num_timed + num_requested FROM pg_stat_checkpointer');
			return Number(stdout.trim());
		},
		async snapshot(name: string): Promise<void> {
			if (!SNAPSHOT_NAME.test(name)) throw new Error(`bad snapshot name ${name}`);
			await psql('CHECKPOINT', 60 * 60_000);
			child.kill('SIGKILL');
			await stopScope(options.fastifyUnit);
			await compose(['stop', '-t', '300', 'postgres'], 15 * 60_000);
			const id = (await compose(['ps', '-a', '-q', 'postgres'])).stdout.trim();
			const { stdout } = await exec('docker', ['inspect', '-f', '{{.State.ExitCode}}', id], { timeout: 60_000 });
			// A Postgres that did not shut down cleanly would replay WAL on every restore.
			if (stdout.trim() !== '0') throw new Error(`postgres exited ${stdout.trim()} on shutdown; snapshot not taken`);
			await asRootInDataDir(
				`rm -rf /host-data/snapshots/${name} && mv /host-data/pgdata /host-data/snapshots/${name}`,
				10 * 60_000
			);
		},
		// pg-only still runs the redis container (idle, never connected to) so both stacks share
		// one compose file; its CPU and memory are not charged since the app never uses it.
		redisExec: ['docker', ...COMPOSE, 'exec', '-T', 'redis', 'redis-cli', '-p', '6380', 'info'],
		stop,
	};
}

/**
 * Waits for the real server, over TCP.
 *
 * The postgres image's entrypoint runs a temporary server while it initializes a
 * fresh PGDATA, then stops it and starts the real one. That temporary server is
 * socket-only (`listen_addresses=''`), so a unix-socket `pg_isready` reports
 * "ready" during init and the next statement races its shutdown. Probing over
 * TCP — which is how the app connects anyway — can only succeed against the real
 * server. On tmpfs initdb was fast enough to hide this; on a real disk it is not.
 */
async function waitForPostgres(
	compose: (args: string[], timeoutMs?: number) => Promise<unknown>,
	timeoutMs: number
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	let lastError: unknown;
	while (Date.now() < deadline) {
		try {
			await compose(['exec', '-T', 'postgres', 'pg_isready', '-h', '127.0.0.1', '-p', '5433', '-U', 'ycsb'], 30_000);
			return;
		} catch (error) {
			lastError = error;
			await delay(500);
		}
	}
	throw new Error(`postgres did not become ready: ${(lastError as Error)?.message ?? 'unknown'}`);
}
