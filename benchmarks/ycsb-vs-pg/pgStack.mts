/**
 * Lifecycle for the Postgres + Redis + Fastify comparison stack: brings up the
 * docker-compose services, truncates the table, boots the Fastify cluster, and
 * tears everything down again.
 */
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';

const exec = promisify(execFile);
const DIR = import.meta.dirname;
const COMPOSE = ['compose', '-f', join(DIR, 'docker-compose.yml'), '-p', 'ycsb-vs-pg'];

export const PG_URL = 'postgres://ycsb:ycsb@127.0.0.1:5433/ycsb';
export const REDIS_URL = 'redis://127.0.0.1:6380';
export const PG_APP_PORT = 9940;

export interface PgStackOptions {
	workers: number;
	useCache: boolean;
	fields: number;
	poolSize: number;
}

export interface PgStack {
	baseUrl: string;
	stop(): Promise<void>;
}

async function waitForPostgres(timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			await exec('docker', [...COMPOSE, 'exec', '-T', 'postgres', 'pg_isready', '-p', '5433', '-U', 'ycsb']);
			return;
		} catch {
			await delay(500);
		}
	}
	throw new Error('postgres did not become ready');
}

export async function startPgStack(options: PgStackOptions): Promise<PgStack> {
	await exec('docker', [...COMPOSE, 'up', '-d'], { maxBuffer: 1 << 24 });
	await waitForPostgres(120_000);

	// Fresh dataset per run: the harness load phase inserts sequential keys, and
	// leftover rows would change both the row count and the cache hit profile.
	await exec('docker', [
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
	]);
	await exec('docker', [...COMPOSE, 'exec', '-T', 'redis', 'redis-cli', '-p', '6380', 'flushall']);

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

	return {
		baseUrl: `http://127.0.0.1:${PG_APP_PORT}`,
		async stop(): Promise<void> {
			child.kill('SIGKILL');
			await exec('docker', [...COMPOSE, 'down', '-v'], { maxBuffer: 1 << 24 });
		},
	};
}
