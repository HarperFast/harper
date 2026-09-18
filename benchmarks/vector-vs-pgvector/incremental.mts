/**
 * Steady-state behaviour of a vector index under continuous update.
 *
 * The cold-build-then-query comparison in run-compare.mts measures the case that favours a bulk
 * builder: load everything, build once, never write again. It says nothing about a corpus that is
 * actively changing, which is the case Harper's post-commit derived index is designed for.
 *
 * Three measurements, on an index that is already built and serving:
 *   1. sustained insert rate into a LIVE index (not a bulk build)
 *   2. query throughput and recall WHILE those inserts are running
 *   3. visibility lag — how long until a just-inserted vector can be found by searching for itself
 *
 * (3) is the sharpest of the three: it is the difference between "the index is maintained" and
 * "the index is eventually maintained", and it is invisible to any throughput-only benchmark.
 */
import { parseArgs } from 'node:util';
import { join } from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { createHarperContext, setupHarperWithFixture, teardownHarper } from '@harperfast/integration-testing';
import { readFvecs, DATA_DIR } from './dataset.mts';

const exec = promisify(execFile);
const REPO_ROOT = join(import.meta.dirname, '..', '..');
const COMPOSE = ['compose', '-f', join(import.meta.dirname, 'docker-compose.yml')];
const PG_APP = join(import.meta.dirname, 'pgvector-app', 'server.mjs');

const { values } = parseArgs({
	options: {
		base: { type: 'string', default: '100000' },
		added: { type: 'string', default: '20000' },
		probes: { type: 'string', default: '40' },
		threads: { type: 'string', default: '6' },
		target: { type: 'string', default: 'harper' },
		serverCpus: { type: 'string', default: '0-5' },
	},
});
const BASE = Number(values.base);
const ADDED = Number(values.added);
const PROBES = Number(values.probes);
const THREADS = Number(values.threads);

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
		child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`psql ${code}: ${err.slice(0, 400)}`))));
		child.stdin.write(sql);
		if (stdinAfter) child.stdin.write(stdinAfter);
		child.stdin.end();
	});
}

async function waitFor(url: string, deadlineMs: number): Promise<void> {
	const end = Date.now() + deadlineMs;
	while (Date.now() < end) {
		try {
			const r = await fetch(url, { signal: AbortSignal.timeout(5000) });
			await r.body?.cancel();
			if (r.status >= 200 && r.status < 400) return;
		} catch {}
		await delay(250);
	}
	throw new Error(`timed out waiting for ${url}`);
}

/**
 * Search for a vector that is itself in the corpus; it should come back as its own top hit.
 *
 * A failed search counts as not-yet-visible rather than propagating: since harper#2658 a native
 * index that is too far behind rejects the query outright, and for this measurement that is
 * exactly the same observable fact as "the write is not queryable yet".
 */
async function findsItself(search: (v: Float32Array) => Promise<(number | string)[]>, v: Float32Array, id: number) {
	try {
		const got = await search(v);
		return got.length > 0 && Number(got[0]) === id;
	} catch {
		return false;
	}
}

/**
 * Time from a successful write acknowledgement to the vector being findable.
 * Polls rather than sleeping a fixed interval so a fast index reports a small number.
 */
async function visibilityLag(
	insert: (id: number, v: Float32Array) => Promise<void>,
	search: (v: Float32Array) => Promise<(number | string)[]>,
	vectors: Float32Array[],
	startId: number,
	count: number
): Promise<{ median: number; max: number; timedOut: number }> {
	const lags: number[] = [];
	let timedOut = 0;
	for (let i = 0; i < count; i++) {
		const id = startId + i;
		const v = vectors[i];
		const t0 = performance.now();
		await insert(id, v);
		let found = false;
		while (performance.now() - t0 < 120_000) {
			if (await findsItself(search, v, id)) {
				found = true;
				break;
			}
			await delay(25);
		}
		if (found) lags.push(performance.now() - t0);
		else timedOut++;
	}
	lags.sort((a, b) => a - b);
	return { median: lags[Math.floor(lags.length / 2)] ?? -1, max: lags[lags.length - 1] ?? -1, timedOut };
}

/** Sustained insert rate into a live index, with concurrent queries running throughout. */
async function concurrentPhase(
	insert: (id: number, v: Float32Array) => Promise<void>,
	search: (v: Float32Array) => Promise<(number | string)[]>,
	vectors: Float32Array[],
	startId: number,
	count: number,
	queryVectors: Float32Array[]
) {
	let inserted = 0;
	let queried = 0;
	let queryErrors = 0;
	let stop = false;
	const t0 = performance.now();

	const writers = Array.from({ length: 16 }, async () => {
		while (true) {
			const n = inserted++;
			if (n >= count) return;
			await insert(startId + n, vectors[n]);
		}
	});
	const readers = Array.from({ length: 16 }, async () => {
		while (!stop) {
			try {
				await search(queryVectors[queried % queryVectors.length]);
				queried++;
			} catch {
				queryErrors++;
			}
		}
	});

	await Promise.all(writers);
	const writeElapsed = (performance.now() - t0) / 1000;
	stop = true;
	await Promise.all(readers);
	return {
		insertRate: count / writeElapsed,
		queryRate: queried / writeElapsed,
		queryErrors,
		elapsed: writeElapsed,
	};
}

let writeRejections = 0;
let writeBlockedMs = 0;
let lastRejection = '';

async function main(): Promise<void> {
	const { dims, vectors } = readFvecs(join(DATA_DIR, 'sift_base.fvecs'), BASE + ADDED + PROBES);
	const { vectors: queryVectors } = readFvecs(join(DATA_DIR, 'sift_query.fvecs'), 200);
	const baseSet = vectors.slice(0, BASE);
	const addSet = vectors.slice(BASE, BASE + ADDED);
	const probeSet = vectors.slice(BASE + ADDED, BASE + ADDED + PROBES);
	console.log(`${BASE} base + ${ADDED} added + ${PROBES} probes, ${dims}d, target=${values.target}\n`);

	if (values.target === 'pgvector') {
		await exec('docker', [...COMPOSE, 'down', '-v'], { maxBuffer: 1 << 24 }).catch(() => {});
		await exec('docker', [...COMPOSE, 'up', '-d'], { maxBuffer: 1 << 24 });
		const end = Date.now() + 120_000;
		while (Date.now() < end) {
			try {
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
		await pgSql('CREATE EXTENSION IF NOT EXISTS vector;\n');
		await pgSql('DROP TABLE IF EXISTS items;\n');
		await pgSql(`CREATE TABLE items (id int PRIMARY KEY, embedding vector(${dims}));\n`);
		const lines: string[] = [];
		for (let i = 0; i < baseSet.length; i++) lines.push(`${i}\t[${baseSet[i].join(',')}]`);
		await pgSql('COPY items (id, embedding) FROM STDIN;\n', lines.join('\n') + '\n\\.\n');
		const ixStart = Date.now();
		await pgSql(
			`SET maintenance_work_mem='2GB';\nCREATE INDEX ON items USING hnsw (embedding vector_cosine_ops) WITH (m=16, ef_construction=200);\n`
		);
		console.log(
			`  bulk index built in ${((Date.now() - ixStart) / 1000).toFixed(1)}s — index is now LIVE for the phases below`
		);

		const app = spawn(process.execPath, [PG_APP], {
			stdio: ['ignore', 'inherit', 'inherit'],
			env: { ...process.env, VEC_WORKERS: String(THREADS), VEC_EF_SEARCH: '40', VEC_OP: '<=>' },
		});
		await waitFor('http://127.0.0.1:9941/health', 60_000);

		const insert = async (id: number, v: Float32Array) => {
			const r = await fetch('http://127.0.0.1:9941/insert', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ id, vector: Array.from(v) }),
			});
			await r.body?.cancel();
			if (!r.ok) throw new Error(`insert ${r.status}`);
		};
		const search = async (v: Float32Array) => {
			const r = await fetch('http://127.0.0.1:9941/search', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ vector: Array.from(v), k: 10 }),
			});
			return await r.json();
		};

		const lag = await visibilityLag(insert, search, probeSet, BASE + ADDED, PROBES);
		console.log(
			`  visibility lag: median ${lag.median.toFixed(1)}ms, max ${lag.max.toFixed(1)}ms, never-found ${lag.timedOut}`
		);
		const conc = await concurrentPhase(insert, search, addSet, BASE, ADDED, queryVectors);
		console.log(
			`  under load: ${conc.insertRate.toFixed(0)} inserts/s while serving ${conc.queryRate.toFixed(0)} queries/s ` +
				`(${conc.elapsed.toFixed(1)}s, ${conc.queryErrors} query errors)`
		);
		app.kill('SIGKILL');
		await exec('docker', [...COMPOSE, 'down', '-v'], { maxBuffer: 1 << 24 }).catch(() => {});
		return;
	}

	const ctx = createHarperContext('vector-incremental');
	await setupHarperWithFixture(ctx, join(import.meta.dirname, 'harper-app'), {
		harperBinPath: join(REPO_ROOT, 'dist', 'bin', 'harper.js'),
		config: { threads: { count: THREADS }, analytics: { aggregatePeriod: -1 }, logging: { level: 'warn' } },
		env: { HARPER_STORAGE_ENGINE: 'rocksdb', HARPER_UWS_HTTP: '1' },
		startupTimeoutMs: 180_000,
	});
	try {
		const url = ctx.harper.httpURL;
		await waitFor(`${url}/items/`, 60_000);
		// Writes can be refused while the derived index catches up (harper#2658 bounds index lag
		// by applying backpressure to writers, not just readers). That refusal is a real property
		// of ingesting into a live index, so retry it and account for it rather than failing: the
		// interesting numbers are how often it happens and how long a writer is held off.
		const insert = async (id: number, v: Float32Array) => {
			const t0 = performance.now();
			for (let attempt = 0; ; attempt++) {
				const r = await fetch(`${url}/items/${id}`, {
					method: 'PUT',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ embedding: Array.from(v) }),
				});
				if (r.ok) {
					await r.body?.cancel();
					if (attempt > 0) {
						writeRejections++;
						writeBlockedMs += performance.now() - t0;
					}
					return;
				}
				const body = (await r.text()).slice(0, 160);
				if (r.status !== 503 || attempt >= 600) throw new Error(`insert ${r.status}: ${body}`);
				lastRejection = body;
				await delay(100);
			}
		};
		const search = async (v: Float32Array) => {
			const r = await fetch(`${url}/items/`, {
				method: 'QUERY',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					sort: { attribute: 'embedding', target: Array.from(v), distance: 'cosine', ef: 40 },
					limit: 10,
					select: ['id'],
				}),
			});
			if (!r.ok) {
				await r.body?.cancel();
				throw new Error(`query ${r.status}`);
			}
			const rows = await r.json();
			return (Array.isArray(rows) ? rows : []).map((x: any) => x.id);
		};

		let next = 0;
		await Promise.all(
			Array.from({ length: 32 }, async () => {
				while (true) {
					const i = next++;
					if (i >= baseSet.length) return;
					await insert(i, baseSet[i]);
				}
			})
		);
		// Let the post-commit plane finish before measuring steady state, so this measures
		// maintenance of a built index rather than the initial build.
		console.log('  base loaded; waiting for the plane to settle before measuring');
		let settled = 0;
		for (let i = 0; i < 120; i++) {
			await delay(5000);
			if (await findsItself(search, baseSet[0], 0)) settled++;
			else settled = 0;
			if (settled >= 6) break;
		}
		console.log('  plane settled — index is LIVE for the phases below');

		const lag = await visibilityLag(insert, search, probeSet, BASE + ADDED, PROBES);
		console.log(
			`  visibility lag: median ${lag.median.toFixed(1)}ms, max ${lag.max.toFixed(1)}ms, never-found ${lag.timedOut}`
		);
		const conc = await concurrentPhase(insert, search, addSet, BASE, ADDED, queryVectors);
		console.log(
			`  under load: ${conc.insertRate.toFixed(0)} inserts/s while serving ${conc.queryRate.toFixed(0)} queries/s ` +
				`(${conc.elapsed.toFixed(1)}s, ${conc.queryErrors} query errors)`
		);
		console.log(
			`  write backpressure: ${writeRejections} writes held off, ${(writeBlockedMs / 1000).toFixed(1)}s total blocked` +
				(lastRejection ? `\n    last refusal: ${lastRejection}` : '')
		);
	} finally {
		await teardownHarper(ctx);
	}
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
