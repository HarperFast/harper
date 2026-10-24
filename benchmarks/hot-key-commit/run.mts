/**
 * Hot-key commit contention on an audited table.
 *
 * Each request is one transaction that reads N Counter records and increments each by 1. The hot
 * workloads draw keys from a small set (default 32), so concurrent transactions conflict on commit and
 * Harper retries them; the cold workloads draw from the whole table (default 100 000) as a near-parity
 * control. Built to measure what a change to the native commit path (conflict check, transaction-log
 * write, RocksDB write) costs Harper under contention.
 *
 * Workloads (`--workloads`, comma-separated):
 *   hot1  — 1 record from the hot set per transaction
 *   hot4  — 4 distinct records from the hot set per transaction
 *   cold1 — 1 record from the whole table
 *   cold4 — 4 distinct records from the whole table
 *
 * `--mode=add` (default) increments with addTo(1), which Harper applies against the latest stored value
 * on retry, so the final counts must equal the acknowledged increments exactly. `--mode=set` writes the
 * read value + 1 instead; the count check then reports lost updates rather than asserting none.
 *
 * Correctness: before and after each workload the counts of every key it can touch are read back;
 * per key, the delta must equal the increments the client saw acknowledged (2xx). `counts_ok=false`
 * (and exit code 1) when an acknowledged increment is missing or more were applied than were sent;
 * `inconclusive` when a request failed or timed out (it may or may not have applied) and nothing was
 * provably wrong.
 *
 * Retries per commit: Harper exports no commit-retry counter, so the Increment resource commits
 * explicitly and returns the native transaction handle's own `retries` count, which both conflict-retry
 * paths in DatabaseTransaction.commit() (the coordinated RETRY_NOW resolve and the ERR_BUSY/ERR_TRY_AGAIN
 * rejection) increment. Summed over the commits measured.
 *
 * The load generator is closed-loop: `--concurrency` callers (default 16 per Harper thread), each
 * sending its next request when the previous one answers, spread over `--client-threads` Node worker
 * threads. Latency is per HTTP request (one transaction, including retries). `client_elu` is the busiest
 * client thread's event-loop utilization; near 1 means the client, not Harper, limits throughput.
 *
 * Usage (after npm run build from the repo root):
 *   node benchmarks/hot-key-commit/run.mts
 *   node benchmarks/hot-key-commit/run.mts --threads=8 --duration=15 --workloads=hot1,hot4
 *
 * Result format, one line per workload:
 *   HOT_KEY_COMMIT_RESULT label=… workload=hot1 mode=add threads=N concurrency=N commits=N commits_per_sec=N
 *     p50_ms=N.NN p99_ms=N.NN retries=N retries_per_commit=N.NNN errors=N
 *     counts_ok=true|false|inconclusive harper_threads_seen=N client_elu=N.NN
 */
import http from 'node:http';
import { parseArgs } from 'node:util';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { setTimeout } from 'node:timers/promises';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { createHarperContext, setupHarperWithFixture, teardownHarper } from '@harperfast/integration-testing';

const REPO_ROOT = join(import.meta.dirname, '..', '..');
const HARPER_BIN = join(REPO_ROOT, 'dist', 'bin', 'harper.js');
const APP_DIR = join(import.meta.dirname, 'app');

const WORKLOADS: Record<string, { hot: boolean; recordsPerTxn: number }> = {
	hot1: { hot: true, recordsPerTxn: 1 },
	hot4: { hot: true, recordsPerTxn: 4 },
	cold1: { hot: false, recordsPerTxn: 1 },
	cold4: { hot: false, recordsPerTxn: 4 },
};

interface Options {
	threads: number;
	concurrency: number;
	clientThreads: number;
	durationSeconds: number;
	warmupSeconds: number;
	hotKeys: number;
	coldKeys: number;
	workloads: string[];
	mode: 'add' | 'set';
	engine: string;
	label: string;
	startupTimeoutMs: number;
}

function parseOptions(): Options {
	const { values } = parseArgs({
		args: process.argv.slice(2),
		options: {
			'threads': { type: 'string', default: '4' },
			'concurrency': { type: 'string' },
			'client-threads': { type: 'string', default: '4' },
			'duration': { type: 'string', default: '10' },
			'warmup': { type: 'string', default: '3' },
			'hot-keys': { type: 'string', default: '32' },
			'cold-keys': { type: 'string', default: '100000' },
			'workloads': { type: 'string', default: 'hot1,hot4,cold1,cold4' },
			'mode': { type: 'string', default: 'add' },
			'engine': { type: 'string', default: 'rocksdb' },
			'label': { type: 'string', default: '' },
			'startup-timeout': { type: 'string', default: '120000' },
		},
		allowPositionals: false,
	});
	const threads = Number(values.threads);
	const workloads = (values.workloads as string).split(',');
	for (const name of workloads) {
		if (!WORKLOADS[name])
			throw new Error(`unknown workload "${name}" (expected: ${Object.keys(WORKLOADS).join(', ')})`);
	}
	const mode = values.mode as string;
	if (mode !== 'add' && mode !== 'set') throw new Error(`unknown mode "${mode}" (expected: add, set)`);
	return {
		threads,
		// enough in-flight transactions per worker that no worker idles waiting on the client
		concurrency: values.concurrency ? Number(values.concurrency) : 16 * threads,
		clientThreads: Number(values['client-threads']),
		durationSeconds: Number(values.duration),
		warmupSeconds: Number(values.warmup),
		hotKeys: Number(values['hot-keys']),
		coldKeys: Number(values['cold-keys']),
		workloads,
		mode,
		engine: values.engine as string,
		label: values.label as string,
		startupTimeoutMs: Number(values['startup-timeout']),
	};
}

interface Response {
	status: number;
	body: any;
}

function post(agent: http.Agent, url: URL, path: string, payload: unknown): Promise<Response> {
	const body = Buffer.from(JSON.stringify(payload));
	return new Promise((resolve, reject) => {
		const req = http.request(
			{
				hostname: url.hostname,
				port: url.port,
				path,
				method: 'POST',
				agent,
				headers: {
					'content-type': 'application/json',
					'accept': 'application/json',
					'content-length': String(body.length),
				},
			},
			(res) => {
				const chunks: Buffer[] = [];
				res.on('data', (chunk) => chunks.push(chunk));
				res.on('end', () => {
					const text = Buffer.concat(chunks).toString();
					let parsed: any = text;
					try {
						parsed = JSON.parse(text);
					} catch {
						// non-JSON error body; keep the text
					}
					resolve({ status: res.statusCode ?? 0, body: parsed });
				});
				res.on('error', reject);
			}
		);
		req.on('error', reject);
		req.setTimeout(30_000, () => req.destroy(new Error(`POST ${path} timed out`)));
		req.end(body);
	});
}

async function postOk(agent: http.Agent, url: URL, path: string, payload: unknown): Promise<any> {
	const res = await post(agent, url, path, payload);
	if (res.status < 200 || res.status >= 300) {
		throw new Error(`POST ${path} -> ${res.status}: ${JSON.stringify(res.body).slice(0, 500)}`);
	}
	return res.body;
}

function percentile(sorted: Float64Array, p: number): number {
	if (sorted.length === 0) return 0;
	return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}

function gitInfo(): string {
	try {
		return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
	} catch {
		return 'unknown';
	}
}

async function readCounts(agent: http.Agent, url: URL, keyCount: number): Promise<number[]> {
	const counts: number[] = [];
	for (let start = 0; start < keyCount; start += 10_000) {
		const ids = Array.from({ length: Math.min(10_000, keyCount - start) }, (_, i) => start + i);
		counts.push(...(await postOk(agent, url, '/Counts/', { ids })));
	}
	return counts;
}

/** Picks `n` distinct ids from 0..keyCount-1. */
function pickIds(keyCount: number, n: number): number[] {
	const ids: number[] = [];
	while (ids.length < n) {
		const id = (Math.random() * keyCount) | 0;
		if (!ids.includes(id)) ids.push(id);
	}
	return ids;
}

interface WorkloadResult {
	commits: number;
	seconds: number;
	latencies: Float64Array;
	errors: number;
	firstError?: string;
	retries: number;
	harperThreads: number;
	clientElu: number;
	countsOk: 'true' | 'false' | 'inconclusive';
	countDetail: string;
}

interface LoadTask {
	url: string;
	keyCount: number;
	recordsPerTxn: number;
	mode: string;
	concurrency: number;
}

interface LoadResult {
	acked: Int32Array;
	uncertain: Int32Array;
	latencies: Float64Array;
	errors: number;
	firstError?: string;
	retries: number;
	harperThreads: number[];
	elu: number;
}

/**
 * Load-generator thread body: runs `concurrency` sequential callers until told to stop. Messages from the
 * main thread: 'measure' starts the timed window, 'stop' ends it and returns a LoadResult.
 */
function generateLoad(task: LoadTask): void {
	const url = new URL(task.url);
	const agent = new http.Agent({ keepAlive: true, maxSockets: task.concurrency });
	const acked = new Int32Array(task.keyCount);
	// a request that failed may still have applied, so it widens the key's expected range
	const uncertain = new Int32Array(task.keyCount);
	const harperThreads = new Set<number>();
	let retries = 0;
	let measuring = false;
	let stopped = false;
	let commits = 0;
	let errors = 0;
	let firstError: string | undefined;
	let latencies = new Float64Array(1 << 16);
	let eluStart = performance.eventLoopUtilization();

	const caller = async (): Promise<void> => {
		while (!stopped) {
			const ids = pickIds(task.keyCount, task.recordsPerTxn);
			const counted = measuring;
			const start = performance.now();
			let res: Response | undefined;
			try {
				res = await post(agent, url, '/Increment/', { ids, mode: task.mode });
			} catch (error) {
				firstError ??= String(error);
			}
			const elapsed = performance.now() - start;
			if (res && res.status >= 200 && res.status < 300) {
				for (const id of ids) acked[id]++;
				if (counted && measuring) {
					retries += res.body.retries;
					harperThreads.add(res.body.thread);
					if (commits === latencies.length) {
						const grown = new Float64Array(latencies.length * 2);
						grown.set(latencies);
						latencies = grown;
					}
					latencies[commits++] = elapsed;
				}
			} else {
				for (const id of ids) uncertain[id]++;
				firstError ??= res ? `${res.status}: ${JSON.stringify(res.body).slice(0, 300)}` : undefined;
				if (counted && measuring) errors++;
			}
		}
	};
	const callers = Array.from({ length: task.concurrency }, caller);

	parentPort!.on('message', async (message: string) => {
		if (message === 'measure') {
			eluStart = performance.eventLoopUtilization();
			measuring = true;
			return;
		}
		measuring = false;
		const elu = performance.eventLoopUtilization(eluStart).utilization;
		stopped = true;
		await Promise.all(callers);
		agent.destroy();
		const result: LoadResult = {
			acked,
			uncertain,
			latencies: latencies.subarray(0, commits),
			errors,
			firstError,
			retries,
			harperThreads: [...harperThreads],
			elu,
		};
		parentPort!.postMessage(result);
		parentPort!.close();
	});
}

async function runWorkload(agent: http.Agent, url: URL, opts: Options, name: string): Promise<WorkloadResult> {
	const { hot, recordsPerTxn } = WORKLOADS[name];
	const keyCount = hot ? opts.hotKeys : opts.coldKeys;
	const before = await readCounts(agent, url, keyCount);

	const workers = Array.from({ length: opts.clientThreads }, (_, i) => {
		const task: LoadTask = {
			url: url.href,
			keyCount,
			recordsPerTxn,
			mode: opts.mode,
			// spread the callers as evenly as the division allows
			concurrency: Math.floor((opts.concurrency + i) / opts.clientThreads),
		};
		return new Worker(new URL(import.meta.url), { workerData: task });
	});
	const results = workers.map(
		(worker) =>
			new Promise<LoadResult>((resolve, reject) => {
				worker.once('message', resolve);
				worker.once('error', reject);
				worker.once('exit', (code) => reject(new Error(`load worker exited (${code}) before reporting`)));
			})
	);
	await setTimeout(opts.warmupSeconds * 1000);
	for (const worker of workers) worker.postMessage('measure');
	const measureStart = performance.now();
	await setTimeout(opts.durationSeconds * 1000);
	for (const worker of workers) worker.postMessage('stop');
	const seconds = (performance.now() - measureStart) / 1000;
	const loads = await Promise.all(results);

	const acked = new Int32Array(keyCount);
	const uncertain = new Int32Array(keyCount);
	const harperThreads = new Set<number>();
	for (const load of loads) {
		for (let id = 0; id < keyCount; id++) {
			acked[id] += load.acked[id];
			uncertain[id] += load.uncertain[id];
		}
		for (const thread of load.harperThreads) harperThreads.add(thread);
	}
	const latencies = new Float64Array(loads.reduce((sum, load) => sum + load.latencies.length, 0));
	let offset = 0;
	for (const load of loads) {
		latencies.set(load.latencies, offset);
		offset += load.latencies.length;
	}

	const after = await readCounts(agent, url, keyCount);
	let mismatched = 0;
	let lost = 0;
	let extra = 0;
	let ambiguous = false;
	for (let id = 0; id < keyCount; id++) {
		const delta = after[id] - before[id];
		if (uncertain[id]) ambiguous = true;
		if (delta < acked[id]) {
			mismatched++;
			lost += acked[id] - delta;
		} else if (delta > acked[id] + uncertain[id]) {
			mismatched++;
			extra += delta - acked[id] - uncertain[id];
		}
	}
	return {
		commits: latencies.length,
		seconds,
		latencies: latencies.sort(),
		errors: loads.reduce((sum, load) => sum + load.errors, 0),
		firstError: loads.find((load) => load.firstError)?.firstError,
		retries: loads.reduce((sum, load) => sum + load.retries, 0),
		harperThreads: harperThreads.size,
		clientElu: Math.max(...loads.map((load) => load.elu)),
		countsOk: mismatched ? 'false' : ambiguous ? 'inconclusive' : 'true',
		countDetail:
			mismatched === 0 ? '' : `${mismatched} keys off: ${lost} acknowledged increments lost, ${extra} extra applied`,
	};
}

async function main(): Promise<void> {
	const opts = parseOptions();
	console.log(
		`hot-key-commit: threads=${opts.threads} concurrency=${opts.concurrency} client-threads=${opts.clientThreads} mode=${opts.mode} ` +
			`duration=${opts.durationSeconds}s warmup=${opts.warmupSeconds}s hot=${opts.hotKeys} cold=${opts.coldKeys} ` +
			`engine=${opts.engine} label=${opts.label || '-'} git=${gitInfo().slice(0, 10)} node=${process.version}`
	);

	const ctx = createHarperContext('hot-key-commit');
	const agent = new http.Agent({ keepAlive: true, maxSockets: 8 });
	try {
		await setupHarperWithFixture(ctx, APP_DIR, {
			harperBinPath: HARPER_BIN,
			config: {
				threads: { count: opts.threads },
				analytics: { aggregatePeriod: -1 },
				logging: { level: 'warn', auditLog: true },
			},
			env: { HARPER_STORAGE_ENGINE: opts.engine },
			startupTimeoutMs: opts.startupTimeoutMs,
		});
		const url = new URL(ctx.harper.httpURL);
		const seedBatch = 1_000;
		const batches = Array.from({ length: Math.ceil(opts.coldKeys / seedBatch) }, (_, i) => i * seedBatch);
		const seeder = async (): Promise<void> => {
			for (let start = batches.shift(); start !== undefined; start = batches.shift()) {
				await postOk(agent, url, '/Seed/', { start, count: Math.min(seedBatch, opts.coldKeys - start) });
			}
		};
		await Promise.all(Array.from({ length: 8 }, seeder));

		for (const name of opts.workloads) {
			const r = await runWorkload(agent, url, opts, name);
			const line =
				`HOT_KEY_COMMIT_RESULT label=${opts.label || '-'} workload=${name} mode=${opts.mode} threads=${opts.threads} ` +
				`concurrency=${opts.concurrency} commits=${r.commits} commits_per_sec=${(r.commits / r.seconds).toFixed(0)} ` +
				`p50_ms=${percentile(r.latencies, 0.5).toFixed(2)} p99_ms=${percentile(r.latencies, 0.99).toFixed(2)} ` +
				`retries=${r.retries} retries_per_commit=${(r.retries / r.commits).toFixed(3)} errors=${r.errors} ` +
				`counts_ok=${r.countsOk} harper_threads_seen=${r.harperThreads} client_elu=${r.clientElu.toFixed(2)}`;
			console.log(line);
			if (r.countsOk === 'false') {
				console.log(`  count check: ${r.countDetail}`);
				process.exitCode = 1;
			}
			if (r.firstError) console.log(`  first error: ${r.firstError}`);
		}
	} finally {
		agent.destroy();
		await teardownHarper(ctx);
	}
}

if (isMainThread) {
	main().catch((err) => {
		console.error(err);
		process.exit(1);
	});
} else {
	generateLoad(workerData);
}
