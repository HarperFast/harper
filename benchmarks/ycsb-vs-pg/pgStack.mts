/**
 * Lifecycle for the Postgres + Redis + Fastify comparison stack: brings up the
 * docker-compose services, truncates the table, boots the Fastify cluster, and
 * tears everything down again.
 */
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { pinProcesses } from './resources.mts';

const exec = promisify(execFile);
const DIR = import.meta.dirname;
const COMPOSE = ['compose', '-f', join(DIR, 'docker-compose.yml'), '-p', 'ycsb-vs-pg'];

/** Where PGDATA lives on the host. Must be a real disk, and the same filesystem Harper uses. */
export const dataDir = (): string => process.env.YCSB_VS_PG_DATA_DIR || join(DIR, 'data');

const composeEnv = (): NodeJS.ProcessEnv => ({
	...process.env,
	YCSB_VS_PG_DATA_DIR: dataDir(),
	YCSB_REDIS_MAXMEMORY: process.env.YCSB_REDIS_MAXMEMORY || '8gb',
});

/**
 * Removes the previous run's PGDATA. `docker compose down -v` only drops named
 * volumes, so a bind mount would otherwise carry a run's WAL and bloat into the
 * next one — exactly the cross-run contamination the per-workload restarts exist
 * to prevent. The files are owned by the container's postgres uid, so the delete
 * runs in a throwaway root container rather than as the host user.
 */
async function wipePgData(): Promise<void> {
	const base = dataDir();
	await mkdir(base, { recursive: true });
	await exec('docker', [
		'run',
		'--rm',
		'-v',
		`${base}:/host-data`,
		'alpine:latest',
		'sh',
		'-c',
		'rm -rf /host-data/pgdata',
	]);
}

export const PG_URL = 'postgres://ycsb:ycsb@127.0.0.1:5433/ycsb';
export const REDIS_URL = 'redis://127.0.0.1:6380';
export const PG_APP_PORT = 9940;

export interface PgStackOptions {
	workers: number;
	useCache: boolean;
	fields: number;
	poolSize: number;
	/** CPU list the whole server side (Fastify + Postgres + Redis) is confined to. */
	serverCpus?: string;
}

export interface PgStack {
	baseUrl: string;
	/** Container cgroup scopes, so Postgres' per-connection backends are all counted. */
	cgroups: Record<string, string>;
	/** Command that prints Redis INFO stats, for cache hit-rate sampling. */
	redisExec: string[];
	stop(): Promise<void>;
}

/** Resolves a compose service's cgroup scope path for CPU accounting. */
async function containerCgroup(service: string): Promise<string> {
	const { stdout } = await exec('docker', [...COMPOSE, 'ps', '-q', service], { env: composeEnv() });
	const id = stdout.trim();
	return id ? `/sys/fs/cgroup/system.slice/docker-${id}.scope` : '';
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
async function waitForPostgres(timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	let lastError: unknown;
	while (Date.now() < deadline) {
		try {
			await exec(
				'docker',
				[...COMPOSE, 'exec', '-T', 'postgres', 'pg_isready', '-h', '127.0.0.1', '-p', '5433', '-U', 'ycsb'],
				{ env: composeEnv() }
			);
			return;
		} catch (error) {
			lastError = error;
			await delay(500);
		}
	}
	throw new Error(`postgres did not become ready: ${(lastError as Error)?.message ?? 'unknown'}`);
}

export async function startPgStack(options: PgStackOptions): Promise<PgStack> {
	// Stop first: `up -d` will not recreate an already-running container, so wiping
	// PGDATA while one is live deletes the data directory out from under it.
	await exec('docker', [...COMPOSE, 'down', '-v'], { maxBuffer: 1 << 24, env: composeEnv() }).catch(() => {});
	await wipePgData();
	await exec('docker', [...COMPOSE, 'up', '-d'], { maxBuffer: 1 << 24, env: composeEnv() });
	await waitForPostgres(120_000);

	// Fresh dataset per run: the harness load phase inserts sequential keys, and
	// leftover rows would change both the row count and the cache hit profile.
	await exec(
		'docker',
		[
			...COMPOSE,
			'exec',
			'-T',
			'postgres',
			'psql',
			'-p',
			'5433',
			'-U',
			'ycsb',
			'-d',
			'ycsb',
			'-c',
			'DROP TABLE IF EXISTS usertable',
		],
		{ env: composeEnv() }
	);
	await exec('docker', [...COMPOSE, 'exec', '-T', 'redis', 'redis-cli', '-p', '6380', 'flushall'], {
		env: composeEnv(),
	});

	const child: ChildProcess = spawn(process.execPath, [join(DIR, 'pg-app', 'server.mjs')], {
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
		child.on('exit', (code) => reject(new Error(`pg-app exited early with ${code}`)));
	});

	const cgroups: Record<string, string> = {
		postgres: await containerCgroup('postgres'),
	};
	if (options.useCache) cgroups.redis = await containerCgroup('redis');

	if (options.serverCpus) {
		// The three server processes share one CPU budget, the same one Harper gets, so
		// ops-per-server-CPU-second compares like with like. Containers take a cpuset rather
		// than taskset, which cannot reach inside them.
		for (const service of options.useCache ? ['postgres', 'redis'] : ['postgres']) {
			const { stdout } = await exec('docker', [...COMPOSE, 'ps', '-q', service], { env: composeEnv() });
			await exec('docker', ['update', `--cpuset-cpus=${options.serverCpus}`, stdout.trim()]);
		}
		// Every cluster worker, not just the parent: they are already forked by this point and
		// taskset -acp on the parent would not reach them.
		await pinProcesses('pg-app/server.mjs', options.serverCpus);
	}

	return {
		baseUrl: `http://127.0.0.1:${PG_APP_PORT}`,
		cgroups,
		redisExec: ['docker', ...COMPOSE, 'exec', '-T', 'redis', 'redis-cli', '-p', '6380', 'info', 'stats'],
		async stop(): Promise<void> {
			child.kill('SIGKILL');
			await exec('docker', [...COMPOSE, 'down', '-v'], { maxBuffer: 1 << 24, env: composeEnv() });
		},
	};
}
