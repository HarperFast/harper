/**
 * Harper HNSW vs. pgvector HNSW on SIFT.
 *
 * Throughput is only meaningful at a stated recall: an approximate index can be made arbitrarily
 * fast by searching less of the graph. So this sweeps the search-time candidate list on BOTH
 * systems (Harper's per-query `ef`, pgvector's `hnsw.ef_search`) and reports queries/sec against
 * measured recall@10, which is the ann-benchmarks methodology. Comparing single QPS numbers at
 * unstated recall is the usual way these benchmarks go wrong.
 *
 *   node benchmarks/vector-vs-pgvector/run-compare.mts --records=200000 --queries=500
 */
import { parseArgs } from 'node:util';
import { join } from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdir } from 'node:fs/promises';
import { createHarperContext, setupHarperWithFixture, teardownHarper } from '@harperfast/integration-testing';
import { readFvecs, groundTruth, recallAt, DATA_DIR } from './dataset.mts';
import { runQueries, percentile } from './queryDriver.mts';
import { sampleResources, diffResources, pinProcesses, ClockProbe, parseCpuList, onlineCpus } from './resources.mts';

const exec = promisify(execFile);
const REPO_ROOT = join(import.meta.dirname, '..', '..');
const COMPOSE = ['compose', '-f', join(import.meta.dirname, 'docker-compose.yml')];
const PG_APP = join(import.meta.dirname, 'pgvector-app', 'server.mjs');

const { values } = parseArgs({
	options: {
		records: { type: 'string', default: '200000' },
		queries: { type: 'string', default: '500' },
		k: { type: 'string', default: '10' },
		efs: { type: 'string', default: '10,20,40,80,160,320' },
		concurrency: { type: 'string', default: '32' },
		repeats: { type: 'string', default: '4' },
		threads: { type: 'string', default: '6' },
		targets: { type: 'string', default: 'harper,pgvector' },
		serverCpus: { type: 'string', default: '0-5' },
		uws: { type: 'boolean', default: true },
	},
});
const RECORDS = Number(values.records);
const N_QUERIES = Number(values.queries);
const K = Number(values.k);
const EFS = (values.efs as string).split(',').map(Number);
const CONCURRENCY = Number(values.concurrency);
const REPEATS = Number(values.repeats);
const THREADS = Number(values.threads);

interface SweepPoint {
	ef: number;
	qps: number;
	recall: number;
	p50: number;
	p99: number;
	cpuSeconds: number;
	clockGHz: number;
	totalQueries: number;
}
interface TargetResult {
	target: string;
	loadSeconds: number;
	indexSeconds: number;
	memoryMiB: number;
	sweep: SweepPoint[];
}

async function waitFor(url: string, deadlineMs: number, init?: RequestInit): Promise<void> {
	const deadline = Date.now() + deadlineMs;
	while (Date.now() < deadline) {
		try {
			const res = await fetch(url, { ...init, signal: AbortSignal.timeout(5000) });
			await res.body?.cancel();
			if (res.status >= 200 && res.status < 400) return;
		} catch {
			// not up yet
		}
		await delay(250);
	}
	throw new Error(`timed out waiting for ${url}`);
}

// --------------------------------------------------------------------------- Harper

async function withHarper<T>(body: (url: string, targets: any) => Promise<T>): Promise<T> {
	const ctx = createHarperContext('vector-vs-pgvector');
	console.log(`\n=== harper: starting (threads=${THREADS}, uws=${values.uws}) ===`);
	await setupHarperWithFixture(ctx, join(import.meta.dirname, 'harper-app'), {
		harperBinPath: join(REPO_ROOT, 'dist', 'bin', 'harper.js'),
		config: { threads: { count: THREADS }, analytics: { aggregatePeriod: -1 }, logging: { level: 'warn' } },
		env: {
			HARPER_STORAGE_ENGINE: 'rocksdb',
			...(values.uws ? { HARPER_UWS_HTTP: '1' } : {}),
			// Reaches only the server, so a --cpu-prof run does not also profile this driver.
			...(process.env.HARPER_NODE_OPTIONS ? { NODE_OPTIONS: process.env.HARPER_NODE_OPTIONS } : {}),
		},
		startupTimeoutMs: 180_000,
	});
	try {
		await waitFor(`${ctx.harper.httpURL}/items/`, 60_000);
		if (values.serverCpus) await pinProcesses('dist/bin/harper.js', values.serverCpus);
		return await body(ctx.harper.httpURL, { processes: { harper: 'dist/bin/harper.js' }, cgroups: {} });
	} finally {
		await teardownHarper(ctx);
	}
}

/** Harper indexes on write, so load time and index build time are the same number. */
async function loadHarper(url: string, base: Float32Array[]): Promise<number> {
	const started = Date.now();
	const CONC = 32;
	let next = 0;
	await Promise.all(
		Array.from({ length: CONC }, async () => {
			while (true) {
				const i = next++;
				if (i >= base.length) return;
				const res = await fetch(`${url}/items/${i}`, {
					method: 'PUT',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ embedding: Array.from(base[i]) }),
				});
				await res.body?.cancel();
				if (!res.ok) throw new Error(`load failed at ${i}: ${res.status}`);
				if (i % 20000 === 0) console.log(`  loaded ${i} / ${base.length}`);
			}
		})
	);
	return (Date.now() - started) / 1000;
}

function harperSender(url: string, ef: number) {
	return async (vector: Float32Array, k: number): Promise<(number | string)[]> => {
		const res = await fetch(`${url}/items/`, {
			method: 'QUERY',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				sort: { attribute: 'embedding', target: Array.from(vector), distance: 'euclidean', ef },
				limit: k,
				select: ['id'],
			}),
		});
		if (!res.ok) {
			await res.body?.cancel();
			throw new Error(`query ${res.status}`);
		}
		const rows = await res.json();
		return (Array.isArray(rows) ? rows : []).map((r: any) => r.id);
	};
}

// --------------------------------------------------------------------------- pgvector

/**
 * Run SQL in the Postgres container, feeding it over stdin.
 *
 * Not `psql -c`: a bulk INSERT or COPY payload of a few thousand 128-dimension vectors exceeds
 * the kernel's argv limit and spawn fails with E2BIG. stdin has no such bound.
 */
function pgSql(sql: string, stdinAfter?: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn(
			'docker',
			[...COMPOSE, 'exec', '-T', 'postgres', 'psql', '-p', '5434', '-U', 'vec', '-d', 'vec', '-v', 'ON_ERROR_STOP=1', '-q'],
			{ stdio: ['pipe', 'pipe', 'pipe'] }
		);
		let out = '';
		let err = '';
		child.stdout.on('data', (c) => (out += c));
		child.stderr.on('data', (c) => (err += c));
		child.on('error', reject);
		child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`psql exited ${code}: ${err.slice(0, 500)}`))));
		child.stdin.write(sql);
		if (stdinAfter) child.stdin.write(stdinAfter);
		child.stdin.end();
	});
}
const pgExec = pgSql;

async function startPgvector(): Promise<void> {
	console.log('\n=== pgvector: starting postgres ===');
	await exec('docker', [...COMPOSE, 'down', '-v'], { maxBuffer: 1 << 24 }).catch(() => {});
	await exec('docker', [...COMPOSE, 'up', '-d'], { maxBuffer: 1 << 24 });
	const deadline = Date.now() + 120_000;
	while (Date.now() < deadline) {
		try {
			// TCP, not the unix socket: the image runs a socket-only temporary server during initdb,
			// and probing that would race its shutdown.
			await exec('docker', [...COMPOSE, 'exec', '-T', 'postgres', 'pg_isready', '-h', '127.0.0.1', '-p', '5434', '-U', 'vec']);
			break;
		} catch {
			await delay(500);
		}
	}
	await pgExec('CREATE EXTENSION IF NOT EXISTS vector');
}

let pgApp: ReturnType<typeof spawn> | undefined;
async function startPgApp(efSearch: number): Promise<void> {
	pgApp?.kill('SIGKILL');
	pgApp = spawn(process.execPath, [PG_APP], {
		stdio: ['ignore', 'inherit', 'inherit'],
		env: { ...process.env, VEC_WORKERS: String(THREADS), VEC_EF_SEARCH: String(efSearch) },
	});
    await waitFor('http://127.0.0.1:9941/health', 60_000);
	if (values.serverCpus) await pinProcesses('pgvector-app/server.mjs', values.serverCpus);
}

/**
 * pgvector builds its index in bulk after the data is loaded, which is the documented fast path
 * and what any real deployment would do. Harper indexes on write instead, so the two build
 * strategies differ and only the load+index total is comparable.
 */
async function loadPgvector(base: Float32Array[], dims: number): Promise<{ load: number; index: number }> {
	await pgExec('DROP TABLE IF EXISTS items');
	await pgExec(`CREATE TABLE items (id int PRIMARY KEY, embedding vector(${dims}))`);

	// COPY rather than INSERT: this is the documented bulk path and keeps the load phase from
	// dominating a measurement that is meant to be about index build and query time.
	const loadStart = Date.now();
	const CHUNK = 20000;
	for (let start = 0; start < base.length; start += CHUNK) {
		const end = Math.min(start + CHUNK, base.length);
		const lines: string[] = [];
		for (let i = start; i < end; i++) lines.push(`${i}\t[${base[i].join(',')}]`);
		await pgSql('COPY items (id, embedding) FROM STDIN;\n', lines.join('\n') + '\n\\.\n');
		console.log(`  loaded ${end} / ${base.length}`);
	}
	const load = (Date.now() - loadStart) / 1000;

	const indexStart = Date.now();
	await pgSql(
		`SET maintenance_work_mem='2GB';\nCREATE INDEX ON items USING hnsw (embedding vector_l2_ops) WITH (m=16, ef_construction=100);\n`
	);
	const index = (Date.now() - indexStart) / 1000;
	return { load, index };
}

function pgSender(ef: number) {
	return async (vector: Float32Array, k: number): Promise<(number | string)[]> => {
		const res = await fetch('http://127.0.0.1:9941/search', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ vector: Array.from(vector), k }),
		});
		if (!res.ok) {
			await res.body?.cancel();
			throw new Error(`query ${res.status}`);
		}
		return await res.json();
	};
}

// --------------------------------------------------------------------------- sweep

async function sweep(
	makeSender: (ef: number) => (v: Float32Array, k: number) => Promise<(number | string)[]>,
	beforeEf: ((ef: number) => Promise<void>) | undefined,
	queries: Float32Array[],
	truth: number[][],
	resourceTargets: any
): Promise<SweepPoint[]> {
	const clockCpus = values.serverCpus ? parseCpuList(values.serverCpus) : onlineCpus();
	const points: SweepPoint[] = [];
	for (const ef of EFS) {
		if (beforeEf) await beforeEf(ef);
		const send = makeSender(ef);
		await runQueries(send, queries.slice(0, 50), K, 8, 1); // warm caches at this ef
		const clock = new ClockProbe(clockCpus);
		const before = await sampleResources(resourceTargets);
		clock.start();
		const result = await runQueries(send, queries, K, CONCURRENCY, REPEATS);
		const clockGHz = clock.stop();
		const delta = diffResources(before, await sampleResources(resourceTargets));
		const recall = result.ids.reduce((sum, got, i) => sum + recallAt(got, truth[i]), 0) / queries.length;
		const point = {
			ef,
			qps: result.throughput,
			recall,
			p50: percentile(result.latencies, 50),
			p99: percentile(result.latencies, 99),
			cpuSeconds: delta.totalCpuSeconds,
			clockGHz,
			totalQueries: queries.length * REPEATS,
		};
		points.push(point);
		console.log(
			`  ef ${String(ef).padStart(4)}  ${point.qps.toFixed(0).padStart(7)} q/s  recall@${K} ${(recall * 100).toFixed(2)}%  ` +
				`p50 ${point.p50.toFixed(2)}ms  p99 ${point.p99.toFixed(2)}ms  ${point.cpuSeconds.toFixed(1)} cpu-s @ ${clockGHz.toFixed(2)}GHz` +
				(result.errors ? `  ERRORS ${result.errors}` : '')
		);
	}
	return points;
}

async function main(): Promise<void> {
	console.log(`Loading SIFT from ${DATA_DIR}`);
	const { dims, vectors: base } = readFvecs(join(DATA_DIR, 'sift_base.fvecs'), RECORDS);
	const { vectors: allQueries } = readFvecs(join(DATA_DIR, 'sift_query.fvecs'), N_QUERIES);
	const queries = allQueries.slice(0, N_QUERIES);
	console.log(`  ${base.length} base x ${dims} dims, ${queries.length} queries, k=${K}`);
	const truth = groundTruth(base, queries, K);

	const targets = (values.targets as string).split(',');
	const results: TargetResult[] = [];

	if (targets.includes('harper')) {
		const r = await withHarper(async (url, resourceTargets) => {
			const loadSeconds = await loadHarper(url, base);
			console.log(`  [harper] load+index ${loadSeconds.toFixed(1)}s (${(base.length / loadSeconds).toFixed(0)} vec/s)`);
			const mem = await sampleResources(resourceTargets);
			const sweepPoints = await sweep(
				(ef) => harperSender(url, ef),
				undefined,
				queries,
				truth,
				resourceTargets
			);
			return {
				target: 'harper',
				loadSeconds,
				indexSeconds: 0,
				memoryMiB: Object.values(mem.memoryBytes ?? {}).reduce((a, b) => a + b, 0) / 1048576,
				sweep: sweepPoints,
			};
		});
		results.push(r);
	}

	if (targets.includes('pgvector')) {
		await startPgvector();
		const { load, index } = await loadPgvector(base, dims);
		console.log(`  [pgvector] load ${load.toFixed(1)}s + index build ${index.toFixed(1)}s`);
		await startPgApp(EFS[0]);
		const resourceTargets = { processes: { fastify: 'pgvector-app/server.mjs' }, cgroups: {} as Record<string, string> };
		const { stdout } = await exec('docker', [...COMPOSE, 'ps', '-q', 'postgres']);
		resourceTargets.cgroups.postgres = `/sys/fs/cgroup/system.slice/docker-${stdout.trim()}.scope`;
		if (values.serverCpus) {
			await exec('docker', ['update', `--cpuset-cpus=${values.serverCpus}`, stdout.trim()]);
		}
		const mem = await sampleResources(resourceTargets);
		const sweepPoints = await sweep((ef) => pgSender(ef), (ef) => startPgApp(ef), queries, truth, resourceTargets);
		pgApp?.kill('SIGKILL');
		await exec('docker', [...COMPOSE, 'down', '-v'], { maxBuffer: 1 << 24 }).catch(() => {});
		results.push({
			target: 'pgvector',
			loadSeconds: load,
			indexSeconds: index,
			memoryMiB: Object.values(mem.memoryBytes ?? {}).reduce((a, b) => a + b, 0) / 1048576,
			sweep: sweepPoints,
		});
	}

	console.log('\n' + '='.repeat(96));
	console.log(`Harper HNSW vs pgvector — SIFT ${base.length} x ${dims}d, k=${K}, recall-matched`);
	console.log('='.repeat(96));
	for (const r of results) {
		console.log(
			`\n${r.target}: load ${r.loadSeconds.toFixed(1)}s` +
				(r.indexSeconds ? ` + index ${r.indexSeconds.toFixed(1)}s = ${(r.loadSeconds + r.indexSeconds).toFixed(1)}s total` : ' (indexed on write)') +
				`, resident ${r.memoryMiB.toFixed(0)} MiB`
		);
		console.log('    ef     q/s   recall@10    p50ms    p99ms   q/CPU-Gcycle');
		for (const p of r.sweep) {
			// Queries per CPU-gigacycle: CPU-seconds are not comparable across runs on a machine
			// whose clock moves, so normalise by the clock measured during the window.
			const perG = p.totalQueries / Math.max(p.cpuSeconds * (p.clockGHz || 1), 1e-9);
			console.log(
				`  ${String(p.ef).padStart(4)}  ${p.qps.toFixed(0).padStart(6)}   ${(p.recall * 100).toFixed(2).padStart(7)}%  ${p.p50
					.toFixed(2)
					.padStart(7)}  ${p.p99.toFixed(2).padStart(7)}   ${(perG * 1).toFixed(0).padStart(8)}`
			);
		}
	}
	console.log('\nCompare q/s between targets at the same recall, not at the same ef.');
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
