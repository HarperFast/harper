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
import { readFileSync, writeFileSync } from 'node:fs';
import { createHarperContext, setupHarperWithFixture, teardownHarper } from '@harperfast/integration-testing';
import { readFvecs, groundTruth, recallAt, DATA_DIR, type Metric } from './dataset.mts';
import { runQueries, percentile } from './queryDriver.mts';
import { sampleResources, diffResources, pinProcesses, ClockProbe, parseCpuList, onlineCpus } from './resources.mts';

const exec = promisify(execFile);
const REPO_ROOT = join(import.meta.dirname, '..', '..');
const HARPER_BIN = join(REPO_ROOT, 'dist', 'bin', 'harper.js');
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
		// Cosine because the native HNSW plane is cosine-only; euclidean falls back to the JS index.
		distance: { type: 'string', default: 'cosine' },
		// Swap in the non-nativePlane schema, to separate the native module from the JS index.
		jsPlane: { type: 'boolean', default: false },
		// The native plane is maintained post-commit, so a query issued straight after the load can
		// hit a plane that is still catching up. Wait before measuring.
		settleMs: { type: 'string', default: '300000' },
		// When set, sweep CLIENT CONCURRENCY at a single ef instead of sweeping ef. Finds each
		// engine's own saturation point: a target that is not CPU-bound at the chosen concurrency
		// reports a floor, not a ceiling, and comparing floors to ceilings is not a comparison.
		concurrencies: { type: 'string' },
	},
});
const RECORDS = Number(values.records);
const N_QUERIES = Number(values.queries);
const K = Number(values.k);
const EFS = (values.efs as string).split(',').map(Number);
const CONCURRENCY = Number(values.concurrency);
const REPEATS = Number(values.repeats);
const THREADS = Number(values.threads);
const METRIC = values.distance as Metric;

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
	// The two schemas differ only in nativePlane; swapping the file is simpler than templating
	// the app directory and keeps both variants readable in the repo.
	const appDir = join(import.meta.dirname, 'harper-app');
	const active = join(appDir, 'schema.graphql');
	const jsVariant = join(appDir, 'schema-js.graphql.disabled');
	const savedNative = readFileSync(active, 'utf8');
	if (values.jsPlane) writeFileSync(active, readFileSync(jsVariant, 'utf8'));
	console.log(
		`\n=== harper: starting (threads=${THREADS}, uws=${values.uws}, plane=${values.jsPlane ? 'js' : 'native'}) ===`
	);
	await setupHarperWithFixture(ctx, join(import.meta.dirname, 'harper-app'), {
		harperBinPath: HARPER_BIN,
		config: {
			threads: { count: THREADS },
			analytics: { aggregatePeriod: -1 },
			logging: { level: 'warn', stdStreams: true },
		},
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
		if (values.serverCpus) {
			// Match on the ABSOLUTE binary path, not 'dist/bin/harper.js'. This box runs other
			// agents' worktrees, whose Harper command lines contain that substring too — so the
			// loose pattern summed their CPU into ours (readings above the pinned core budget gave
			// it away) and, worse, would have pinned their server onto our cpuset.
			const pinned = await pinProcesses(HARPER_BIN, values.serverCpus);
			if (pinned === 0) throw new Error(`failed to pin any Harper process matching ${HARPER_BIN}`);
			console.log(`  pinned ${pinned} Harper process(es) to cpus ${values.serverCpus}`);
		}
		return await body(ctx.harper.httpURL, { processes: { harper: HARPER_BIN }, cgroups: {} });
	} finally {
		await teardownHarper(ctx);
		if (values.jsPlane) writeFileSync(active, savedNative);
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
				sort: { attribute: 'embedding', target: Array.from(vector), distance: METRIC, ef },
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
			[
				...COMPOSE,
				'exec',
				'-T',
				'postgres',
				'psql',
				'-p',
				'5434',
				'-U',
				'vec',
				'-d',
				'vec',
				'-v',
				'ON_ERROR_STOP=1',
				'-q',
			],
			{ stdio: ['pipe', 'pipe', 'pipe'] }
		);
		let out = '';
		let err = '';
		child.stdout.on('data', (c) => (out += c));
		child.stderr.on('data', (c) => (err += c));
		child.on('error', reject);
		child.on('close', (code) =>
			code === 0 ? resolve(out) : reject(new Error(`psql exited ${code}: ${err.slice(0, 500)}`))
		);
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
			await exec('docker', [
				...COMPOSE,
				'exec',
				'-T',
				'postgres',
				'pg_isready',
				'-h',
				'127.0.0.1',
				'-p',
				'5434',
				'-U',
				'vec',
			]);
			break;
		} catch {
			await delay(500);
		}
	}
	await pgExec('CREATE EXTENSION IF NOT EXISTS vector');
}

let pgApp: ReturnType<typeof spawn> | undefined;
async function startPgApp(efSearch: number): Promise<void> {
	// Wait for the previous instance to actually exit before rebinding. ef_search is applied at
	// connection time, so each sweep point restarts the app, and racing the old listener's socket
	// produces EADDRINUSE on every worker.
	if (pgApp) {
		const exited = new Promise<void>((resolve) => pgApp!.once('exit', () => resolve()));
		pgApp.kill('SIGKILL');
		await Promise.race([exited, delay(10_000)]);
		pgApp = undefined;
	}
	pgApp = spawn(process.execPath, [PG_APP], {
		stdio: ['ignore', 'inherit', 'inherit'],
		env: {
			...process.env,
			VEC_WORKERS: String(THREADS),
			VEC_EF_SEARCH: String(efSearch),
			// Must match the index operator class chosen from METRIC, or the planner ignores the index.
			VEC_OP: METRIC === 'cosine' ? '<=>' : '<->',
		},
	});
	await waitFor('http://127.0.0.1:9941/health', 60_000);
	if (values.serverCpus) {
		const pinned = await pinProcesses(PG_APP, values.serverCpus);
		if (pinned === 0) throw new Error(`failed to pin any pgvector-app process matching ${PG_APP}`);
	}
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
	// Operator class must match the metric, and ef_construction matches the value the native
	// plane pins Harper to, so both build comparable graphs.
	const opclass = METRIC === 'cosine' ? 'vector_cosine_ops' : 'vector_l2_ops';
	await pgSql(
		`SET maintenance_work_mem='2GB';\nCREATE INDEX ON items USING hnsw (embedding ${opclass}) WITH (m=16, ef_construction=200);\n`
	);
	const index = (Date.now() - indexStart) / 1000;

	// Assert the planner actually uses the index. An operator that does not match the index's
	// operator class silently degrades to a sequential scan, which reports near-100% recall at a
	// fraction of the throughput — an exact search that looks like a catastrophically slow ANN
	// one. Cheaper to fail loudly here than to publish that number.
	const op = METRIC === 'cosine' ? '<=>' : '<->';
	const plan = await pgSql(
		`EXPLAIN SELECT id FROM items ORDER BY embedding ${op} '[${base[0].join(',')}]' LIMIT 10;\n`
	);
	if (!/Index Scan/i.test(plan)) {
		throw new Error(`pgvector is not using the HNSW index (operator ${op} vs ${opclass}):\n${plan}`);
	}
	console.log(`  [pgvector] planner confirmed index scan with ${op}`);
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

// --------------------------------------------------------------------------- qdrant

const QDRANT = 'http://127.0.0.1:6333';
const QDRANT_COLLECTION = 'items';

async function qdrantApi(method: string, path: string, body?: unknown): Promise<any> {
	const res = await fetch(`${QDRANT}${path}`, {
		method,
		headers: { 'Content-Type': 'application/json' },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const text = await res.text();
	if (!res.ok) throw new Error(`qdrant ${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
	return text ? JSON.parse(text) : undefined;
}

async function startQdrant(): Promise<string> {
	console.log('\n=== qdrant: starting ===');
	await exec('docker', [...COMPOSE, 'down', '-v'], { maxBuffer: 1 << 24 }).catch(() => {});
	await exec('docker', [...COMPOSE, 'up', '-d', 'qdrant'], { maxBuffer: 1 << 24 });
	await waitFor(`${QDRANT}/readyz`, 120_000);
	const { stdout } = await exec('docker', [...COMPOSE, 'ps', '-q', 'qdrant']);
	const id = stdout.trim();
	if (values.serverCpus) await exec('docker', ['update', `--cpuset-cpus=${values.serverCpus}`, id]);
	return id;
}

/**
 * Qdrant indexes in background optimizer threads, and leaves a segment on plain (brute-force)
 * search until it grows past `indexing_threshold` — which is a SIZE IN KILOBYTES, not a vector
 * count, and where 0 means "never index" rather than "index everything". Its default of 20000 KB
 * is ~39k 128-dim float32 vectors, so a smaller collection silently stays brute-forced and scores
 * 100% recall at every ef: exact search wearing an ANN benchmark's clothes. Set it to 1 KB so the
 * graph is always built, then wait for the optimizer to report every vector indexed.
 */
async function loadQdrant(base: Float32Array[], dims: number): Promise<{ load: number; index: number }> {
	await qdrantApi('DELETE', `/collections/${QDRANT_COLLECTION}`).catch(() => {});
	await qdrantApi('PUT', `/collections/${QDRANT_COLLECTION}`, {
		vectors: { size: dims, distance: METRIC === 'cosine' ? 'Cosine' : 'Euclid' },
		hnsw_config: { m: 16, ef_construct: 200 },
		optimizers_config: { indexing_threshold: 1 },
	});

	const loadStart = Date.now();
	const BATCH = 2000;
	for (let start = 0; start < base.length; start += BATCH) {
		const end = Math.min(start + BATCH, base.length);
		const points = [];
		for (let i = start; i < end; i++) points.push({ id: i, vector: Array.from(base[i]) });
		await qdrantApi('PUT', `/collections/${QDRANT_COLLECTION}/points?wait=true`, { points });
		if (start % 40000 === 0) console.log(`  loaded ${end} / ${base.length}`);
	}
	const load = (Date.now() - loadStart) / 1000;

	// Time-to-queryable: green status with every vector indexed. Without this the sweep would
	// measure a half-optimized collection, the same trap the native plane posed.
	const indexStart = Date.now();
	const deadline = Date.now() + 900_000;
	while (Date.now() < deadline) {
		const info = await qdrantApi('GET', `/collections/${QDRANT_COLLECTION}`);
		const r = info?.result ?? {};
		if (r.status === 'green' && (r.indexed_vectors_count ?? 0) >= base.length) break;
		await delay(2000);
	}
	const index = (Date.now() - indexStart) / 1000;
	const info = await qdrantApi('GET', `/collections/${QDRANT_COLLECTION}`);
	const indexed = info?.result?.indexed_vectors_count ?? 0;
	if (indexed < base.length) {
		throw new Error(
			`qdrant indexed only ${indexed}/${base.length} vectors — the collection is still on plain ` +
				`search, which scores 100% recall at every ef and is not an HNSW measurement`
		);
	}
	console.log(`  [qdrant] ${indexed} vectors indexed (HNSW active)`);
	return { load, index };
}

function qdrantSender(ef: number) {
	return async (vector: Float32Array, k: number): Promise<(number | string)[]> => {
		const body = await qdrantApi('POST', `/collections/${QDRANT_COLLECTION}/points/search`, {
			vector: Array.from(vector),
			limit: k,
			params: { hnsw_ef: ef },
			with_payload: false,
			with_vector: false,
		});
		return (body?.result ?? []).map((h: any) => h.id);
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
	// Either sweep ef at a fixed concurrency (the default), or sweep concurrency at a fixed ef.
	const concurrencySweep = values.concurrencies ? (values.concurrencies as string).split(',').map(Number) : null;
	const axis = concurrencySweep ?? EFS;
	for (const value of axis) {
		const ef = concurrencySweep ? EFS[0] : value;
		const conc = concurrencySweep ? value : CONCURRENCY;
		if (beforeEf) await beforeEf(ef);
		const send = makeSender(ef);
		await runQueries(send, queries.slice(0, 50), K, 8, 1); // warm caches at this ef
		const clock = new ClockProbe(clockCpus);
		const before = await sampleResources(resourceTargets);
		clock.start();
		const result = await runQueries(send, queries, K, conc, REPEATS);
		const clockGHz = clock.stop();
		const delta = diffResources(before, await sampleResources(resourceTargets));
		const recall = result.ids.reduce((sum, got, i) => sum + recallAt(got, truth[i]), 0) / queries.length;
		const point = {
			ef: concurrencySweep ? conc : ef,
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
			`  ${concurrencySweep ? 'conc' : 'ef  '} ${String(concurrencySweep ? conc : ef).padStart(4)}  ${point.qps.toFixed(0).padStart(7)} q/s  recall@${K} ${(recall * 100).toFixed(2)}%  ` +
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
	console.log(`  ${base.length} base x ${dims} dims, ${queries.length} queries, k=${K}, metric=${METRIC}`);
	const truth = groundTruth(base, queries, K, METRIC);

	const targets = (values.targets as string).split(',');
	const results: TargetResult[] = [];

	if (targets.includes('harper')) {
		const r = await withHarper(async (url, resourceTargets) => {
			const loadSeconds = await loadHarper(url, base);
			console.log(`  [harper] load+index ${loadSeconds.toFixed(1)}s (${(base.length / loadSeconds).toFixed(0)} vec/s)`);
			// Time-to-queryable. Two distinct states have to be cleared, and they are not the same:
			//   1. the index is still building — every query fails 503 "rebuilding"/"unavailable"
			//   2. the index is ready but has not yet covered the most recent writes
			// waitForIndexMilliseconds (harper#2658) addresses only (2): its wait path checks
			// readiness first and throws 503 immediately if the index is not ready, so it cannot be
			// used to wait out the initial build. It is also capped at 30000ms. So poll for (1),
			// then use the bounded causal wait for (2).
			const probe = queries.slice(0, 50);
			const probeTruth = truth.slice(0, 50);
			const settleStart = Date.now();
			const plain = harperSender(url, 40);
			const readyBy = Date.now() + Number(values.settleMs || '900000');
			let becameReady = false;
			while (Date.now() < readyBy) {
				try {
					await plain(queries[0], K);
					becameReady = true;
					break;
				} catch {
					await delay(1000);
				}
			}
			if (!becameReady) console.log('  [harper] WARNING: index never left the rebuilding state');
			// Now that it is serving, make sure it has caught up with the load before measuring.
			try {
				await harperSender(url, 40, 30_000)(queries[0], K);
			} catch (error) {
				console.log(`  [harper] coverage wait: ${(error as Error).message}`);
			}
			// Verify completeness rather than trusting readiness. Observed on 0.3.0: a run whose very
			// first query succeeded immediately measured 68.9% recall where a run that waited 4.1s
			// measured 99.4% — so "serving" and "complete" are still not the same state, and a
			// benchmark that starts measuring on the first 200 silently scores a half-built index.
			// Since recall is measured anyway, use it as the gate.
			let best = 0;
			let probeRun = await runQueries(plain, probe, K, 8, 1);
			best = probeRun.ids.reduce((sum, got, i) => sum + recallAt(got, probeTruth[i]), 0) / probe.length;
			while (best < 0.95 && Date.now() < readyBy) {
				await delay(2000);
				probeRun = await runQueries(plain, probe, K, 8, 1);
				const again = probeRun.ids.reduce((sum, got, i) => sum + recallAt(got, probeTruth[i]), 0) / probe.length;
				if (again <= best + 0.001 && again >= 0.9) break; // plateaued below the gate; report honestly
				best = again;
			}
			const indexSeconds = (Date.now() - settleStart) / 1000;
			console.log(
				`  [harper] index queryable after a further ${indexSeconds.toFixed(1)}s (probe recall ${(best * 100).toFixed(1)}%)`
			);
			const mem = await sampleResources(resourceTargets);
			const sweepPoints = await sweep((ef) => harperSender(url, ef), undefined, queries, truth, resourceTargets);
			return {
				target: 'harper',
				loadSeconds,
				indexSeconds,
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
		const resourceTargets = {
			processes: { fastify: PG_APP },
			cgroups: {} as Record<string, string>,
		};
		const { stdout } = await exec('docker', [...COMPOSE, 'ps', '-q', 'postgres']);
		resourceTargets.cgroups.postgres = `/sys/fs/cgroup/system.slice/docker-${stdout.trim()}.scope`;
		if (values.serverCpus) {
			await exec('docker', ['update', `--cpuset-cpus=${values.serverCpus}`, stdout.trim()]);
		}
		const mem = await sampleResources(resourceTargets);
		const sweepPoints = await sweep(
			(ef) => pgSender(ef),
			(ef) => startPgApp(ef),
			queries,
			truth,
			resourceTargets
		);
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

	if (targets.includes('qdrant')) {
		const id = await startQdrant();
		const { load, index } = await loadQdrant(base, dims);
		console.log(`  [qdrant] load ${load.toFixed(1)}s + index ${index.toFixed(1)}s`);
		const resourceTargets = {
			processes: {} as Record<string, string>,
			cgroups: { qdrant: `/sys/fs/cgroup/system.slice/docker-${id}.scope` },
		};
		const mem = await sampleResources(resourceTargets);
		const sweepPoints = await sweep((ef) => qdrantSender(ef), undefined, queries, truth, resourceTargets);
		await exec('docker', [...COMPOSE, 'down', '-v'], { maxBuffer: 1 << 24 }).catch(() => {});
		results.push({
			target: 'qdrant',
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
				(r.indexSeconds
					? ` + index ${r.indexSeconds.toFixed(1)}s = ${(r.loadSeconds + r.indexSeconds).toFixed(1)}s total`
					: '') +
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
