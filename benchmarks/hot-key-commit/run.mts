/**
 * Hot-key commit contention on an audited table; workloads, flags and output are in benchmarks/README.md.
 *
 * `--mode=add` uses addTo(1), which Harper re-applies against the latest stored value on retry, so the
 * per-key count check is exact; `--mode=set` writes the read value + 1, which a retry re-bases stale, so
 * there it only reports lost updates. The load is closed-loop: a stall also lowers the request rate, so
 * `max_ms` and `errors` include requests still in flight when the window closes.
 */
import http from 'node:http';
import { parseArgs } from 'node:util';
import { join } from 'node:path';
import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { cpus } from 'node:os';
import { execFileSync } from 'node:child_process';
import { setTimeout } from 'node:timers/promises';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { createHarperContext, setupHarperWithFixture, teardownHarper } from '@harperfast/integration-testing';

const REPO_ROOT = join(import.meta.dirname, '..', '..');
const HARPER_BIN = join(REPO_ROOT, 'dist', 'bin', 'harper.js');
const APP_DIR = join(import.meta.dirname, 'app');

const WORKLOADS: Record<string, { hot: boolean; recordsPerTxn: number; keys?: number }> = {
	// every transaction increments all of ids 0..999 in a fresh random order, so concurrent ones cross on every key
	cross1000: { hot: false, recordsPerTxn: 1000, keys: 1000 },
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
	const positive = (name: string, value: string | undefined): number => {
		const n = Number(value);
		if (!Number.isFinite(n) || n <= 0) throw new Error(`--${name} must be a positive number (got "${value}")`);
		return n;
	};
	const count = (name: string, value: string | undefined): number => {
		const n = positive(name, value);
		if (!Number.isInteger(n)) throw new Error(`--${name} must be an integer (got "${value}")`);
		return n;
	};
	const threads = count('threads', values.threads);
	const workloads = (values.workloads as string).split(',').map((name) => name.trim());
	for (const name of workloads) {
		if (!Object.hasOwn(WORKLOADS, name))
			throw new Error(`unknown workload "${name}" (expected: ${Object.keys(WORKLOADS).join(', ')})`);
	}
	const mode = values.mode as string;
	if (mode !== 'add' && mode !== 'set') throw new Error(`unknown mode "${mode}" (expected: add, set)`);
	const hotKeys = count('hot-keys', values['hot-keys']);
	const coldKeys = count('cold-keys', values['cold-keys']);
	const warmupSeconds = Number(values.warmup);
	if (!Number.isFinite(warmupSeconds) || warmupSeconds < 0) {
		throw new Error(`--warmup must be a finite number >= 0 (got "${values.warmup}")`);
	}
	const maxRecordsPerTxn = Math.max(
		...workloads.filter((name) => !WORKLOADS[name].keys).map((name) => WORKLOADS[name].recordsPerTxn),
		1
	);
	if (hotKeys < maxRecordsPerTxn || coldKeys < hotKeys) {
		throw new Error(`need ${maxRecordsPerTxn} <= --hot-keys (${hotKeys}) <= --cold-keys (${coldKeys})`);
	}
	return {
		threads,
		// enough in-flight transactions per worker that no worker idles waiting on the client
		concurrency: values.concurrency ? count('concurrency', values.concurrency) : 16 * threads,
		clientThreads: count('client-threads', values['client-threads']),
		durationSeconds: positive('duration', values.duration),
		warmupSeconds,
		hotKeys,
		coldKeys,
		workloads,
		mode,
		engine: values.engine as string,
		label: values.label as string,
		startupTimeoutMs: positive('startup-timeout', values['startup-timeout']),
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

async function getJson(agent: http.Agent, url: URL, path: string): Promise<any> {
	return new Promise((resolve, reject) => {
		http
			.get(new URL(path, url), { agent, headers: { accept: 'application/json' } }, (res) => {
				let body = '';
				res.on('data', (chunk) => (body += chunk));
				res.on('end', () => {
					try {
						resolve(JSON.parse(body || '{}'));
					} catch {
						resolve({});
					}
				});
			})
			.on('error', reject);
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

function pickIds(keyCount: number, n: number): number[] {
	if (n === keyCount) {
		const all = Array.from({ length: n }, (_, i) => i);
		for (let i = n - 1; i > 0; i--) {
			const j = (Math.random() * (i + 1)) | 0;
			[all[i], all[j]] = [all[j], all[i]];
		}
		return all;
	}
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
	maxMs: number;
	errors: number;
	firstError?: string;
	retries: number | null;
	maxRetries: number;
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
	overrunMs: number;
	errors: number;
	firstError?: string;
	retries: number;
	retriesUnavailable: boolean;
	maxRetries: number;
	harperThreads: number[];
	elu: number;
}

/** Load-generator thread: 'measure' opens the timed window; 'stop' closes it, drains, and posts a LoadResult. */
function generateLoad(task: LoadTask): void {
	const url = new URL(task.url);
	const agent = new http.Agent({ keepAlive: true, maxSockets: task.concurrency });
	const acked = new Int32Array(task.keyCount);
	// a request that failed may still have applied, so it widens the key's expected range
	const uncertain = new Int32Array(task.keyCount);
	const harperThreads = new Set<number>();
	let retries = 0;
	let retriesUnavailable = false;
	let maxRetries = 0;
	let measuring = false;
	let stopped = false;
	// longest request that was in flight when the window closed, so a stall spanning the close still shows
	let overrunMs = 0;
	let commits = 0;
	let errors = 0;
	const errorsByStatus: Record<string, number> = {};
	let firstError: string | undefined;
	let latencies = new Float64Array(1 << 16);
	let eluStart = performance.eventLoopUtilization();

	const caller = async (): Promise<void> => {
		while (!stopped) {
			const ids = pickIds(task.keyCount, task.recordsPerTxn);
			const start = performance.now();
			let res: Response | undefined;
			try {
				res = await post(agent, url, '/Increment/', { ids, mode: task.mode });
			} catch (error) {
				firstError ??= String(error);
			}
			const elapsed = performance.now() - start;
			// still in flight when the window closed
			const overran = stopped;
			if (res && res.status >= 200 && res.status < 300) {
				if (overran && elapsed > overrunMs) overrunMs = elapsed;
				for (const id of ids) acked[id]++;
				// a commit counts when it completes inside the window, so stalls that began before it are kept
				if (measuring) {
					if (res.body.retries == null) retriesUnavailable = true;
					else retries += res.body.retries;
					if (res.body.retries > maxRetries) maxRetries = res.body.retries;
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
				if (measuring || overran) {
					errors++;
					const status = res ? String(res.status) : 'network';
					errorsByStatus[status] = (errorsByStatus[status] ?? 0) + 1;
				}
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
			overrunMs,
			errors,
			errorsByStatus,
			firstError,
			retries,
			retriesUnavailable,
			maxRetries,
			harperThreads: [...harperThreads],
			elu,
		};
		parentPort!.postMessage(result);
		parentPort!.close();
	});
}

async function runWorkload(agent: http.Agent, url: URL, opts: Options, name: string): Promise<WorkloadResult> {
	const { hot, recordsPerTxn, keys } = WORKLOADS[name];
	const keyCount = keys ?? (hot ? opts.hotKeys : opts.coldKeys);
	const before = await readCounts(agent, url, keyCount);

	const workers = Array.from({ length: opts.clientThreads }, (_, i) => {
		const task: LoadTask = {
			url: url.href,
			keyCount,
			recordsPerTxn,
			mode: opts.mode,
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
	// handled now so a worker failing mid-window rejects here, after the sleeps, not as an unhandled rejection
	const settled = Promise.all(results);
	settled.catch(() => {});
	await setTimeout(opts.warmupSeconds * 1000);
	for (const worker of workers) worker.postMessage('measure');
	const measureStart = performance.now();
	await setTimeout(opts.durationSeconds * 1000);
	for (const worker of workers) worker.postMessage('stop');
	const seconds = (performance.now() - measureStart) / 1000;
	let loads: LoadResult[];
	try {
		loads = await settled;
	} catch (error) {
		await Promise.all(workers.map((worker) => worker.terminate()));
		throw error;
	}

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
		maxMs: Math.max(latencies.at(-1) ?? 0, ...loads.map((load) => load.overrunMs)),
		errors: loads.reduce((sum, load) => sum + load.errors, 0),
		errorsByStatus:
			Object.entries(
				loads.reduce((all: Record<string, number>, load: any) => {
					for (const [status, n] of Object.entries(load.errorsByStatus ?? {}))
						all[status] = (all[status] ?? 0) + (n as number);
					return all;
				}, {})
			)
				.map(([status, n]) => `${status}:${n}`)
				.join(',') || 'none',
		firstError: loads.find((load) => load.firstError)?.firstError,
		retries: loads.some((load) => load.retriesUnavailable) ? null : loads.reduce((sum, load) => sum + load.retries, 0),
		maxRetries: Math.max(...loads.map((load) => load.maxRetries)),
		harperThreads: harperThreads.size,
		clientElu: Math.max(...loads.map((load) => load.elu)),
		countsOk: mismatched ? 'false' : ambiguous ? 'inconclusive' : 'true',
		countDetail:
			mismatched === 0 ? '' : `${mismatched} keys off: ${lost} acknowledged increments lost, ${extra} extra applied`,
	};
}

/** CPU ticks per thread class of process `pid`, from /proc/<pid>/task/<tid>/stat (Linux only). */
function threadClassTicks(pid: number): Record<string, number> {
	const ticks: Record<string, number> = {};
	let tasks: string[] = [];
	try {
		tasks = readdirSync(`/proc/${pid}/task`);
	} catch {
		return ticks;
	}
	for (const tid of tasks) {
		let stat: string;
		try {
			stat = readFileSync(`/proc/${pid}/task/${tid}/stat`, 'utf8');
		} catch {
			continue; // thread exited
		}
		const name = stat.slice(stat.indexOf('(') + 1, stat.lastIndexOf(')'));
		const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
		const used = Number(fields[11]) + Number(fields[12]); // utime + stime
		const cls = name.startsWith('rocksdb-commit')
			? 'commit'
			: name.startsWith('rocksdb-txnlog')
				? 'txnlog'
				: name.startsWith('rocksdb:')
					? 'rocksdb_bg'
					: name.startsWith('libuv-worker')
						? 'libuv'
						: name.startsWith('http')
							? 'js_http'
							: name.startsWith('node-V8Worker')
								? 'v8_helpers'
								: 'other:' + name;
		ticks[cls] = (ticks[cls] ?? 0) + used;
	}
	return ticks;
}

/** Busy and total jiffies across all CPUs, from /proc/stat. */
function machineTicks(): { busy: number; total: number } {
	const fields = readFileSync('/proc/stat', 'utf8').split('\n')[0].trim().split(/\s+/).slice(1).map(Number);
	const total = fields.reduce((a, b) => a + b, 0);
	return { busy: total - fields[3] - fields[4], total };
}

/** Bytes in every transaction-log segment under `root` (aborted attempts included). */
function transactionLogBytes(root: string): number {
	let total = 0;
	const walk = (dir: string, inLogs: boolean): void => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) walk(path, inLogs || entry.name === 'transaction_logs');
			else if (inLogs && entry.name.endsWith('.txnlog')) total += statSync(path).size;
		}
	};
	walk(root, false);
	return total;
}

/** Native counters, Harper JS thread use, native CPU by thread class and machine load over one workload. */
function describeStats(
	before: any,
	after: any,
	ticksBefore: Record<string, number>,
	ticksAfter: Record<string, number>,
	machineBefore: { busy: number; total: number },
	machineAfter: { busy: number; total: number }
): string {
	const SLOTS = 64;
	const BASE = 16;
	const KINDS = BASE + SLOTS * 4;
	const d0: number[] = before.diag;
	const d1: number[] = after.diag;
	const commits = d1[0] - d0[0];
	const parts: string[] = [`all_commits=${commits}`];
	let eluSum = 0;
	let workers = 0;
	let jsCpuUs = 0;
	for (let slot = 1; slot < SLOTS; slot++) {
		const at = BASE + slot * 4;
		if (!d1[at + 3]) continue;
		const active = d1[at] - d0[at];
		const idle = d1[at + 1] - d0[at + 1];
		if (active + idle <= 0) continue;
		eluSum += active / (active + idle);
		workers++;
		jsCpuUs += d1[at + 2] - d0[at + 2];
	}
	parts.push(`js_elu_mean=${workers ? (eluSum / workers).toFixed(3) : 'n/a'} js_workers=${workers}`);
	parts.push(`js_cpu_us_per_commit=${commits ? (jsCpuUs / commits).toFixed(1) : 'n/a'}`);
	const tickUs = 1e6 / 100; // USER_HZ
	const classes: Record<string, number> = {};
	for (const [cls, t] of Object.entries(ticksAfter)) {
		const key = cls.startsWith('other:') ? 'other' : cls;
		classes[key] = (classes[key] ?? 0) + (t - (ticksBefore[cls] ?? 0));
	}
	for (const cls of ['js_http', 'commit', 'txnlog', 'rocksdb_bg', 'libuv', 'v8_helpers', 'other']) {
		parts.push(`cpu_us_per_commit_${cls}=${commits ? (((classes[cls] ?? 0) * tickUs) / commits).toFixed(1) : 'n/a'}`);
	}
	const others = Object.entries(ticksAfter)
		.filter(([cls]) => cls.startsWith('other:'))
		.map(([cls, t]) => [cls.slice(6), t - (ticksBefore[cls] ?? 0)] as const)
		.sort((x, y) => y[1] - x[1])
		.slice(0, 4);
	parts.push(
		`other_top=${others.map(([n, t]) => `${n.replace(/\s+/g, '_')}:${commits ? ((t * tickUs) / commits).toFixed(1) : 'n/a'}`).join(',')}`
	);
	const total = machineAfter.total - machineBefore.total;
	parts.push(
		`machine_busy_pct=${total ? ((100 * (machineAfter.busy - machineBefore.busy)) / total).toFixed(1) : 'n/a'} cores=${cpus().length}`
	);
	for (const [kind, label] of [
		[0, 'unknown'],
		[1, 'intent_before_log'],
		[2, 'intent_after_log'],
		[3, 'at_commit'],
		[4, 'check_before_log'],
	] as const) {
		const n = d1[KINDS + kind * 2] - d0[KINDS + kind * 2];
		const us = d1[KINDS + kind * 2 + 1] - d0[KINDS + kind * 2 + 1];
		parts.push(`retry_${label}=${n} retry_${label}_js_us=${n ? (us / n).toFixed(1) : 'n/a'}`);
	}
	const n0 = before.native;
	const n1 = after.native;
	if (n1) {
		const stat = (k: string) => (n1[k] ?? 0) - (n0?.[k] ?? 0);
		const pinned = stat('pinnedTransactions');
		parts.push(
			`aborts_marked=${stat('abortsMarked')} mark_failures=${stat('abortMarkFailures')} ` +
				`pinned_transactions=${pinned} watermark_pinned_ms_total=${(stat('watermarkPinnedUs') / 1000).toFixed(1)} ` +
				`watermark_pinned_ms_per_pinned=${pinned ? (stat('watermarkPinnedUs') / pinned / 1000).toFixed(2) : 'n/a'}`
		);
	} else {
		parts.push('native_stats=n/a');
	}
	return parts.join(' ');
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
			env: {
				HARPER_STORAGE_ENGINE: opts.engine,
				ROCKSDB_JS_PRELOG_VALIDATE: process.env.ROCKSDB_JS_PRELOG_VALIDATE ?? '',
				ROCKSDB_JS_PARK_TIMEOUT_MS: process.env.ROCKSDB_JS_PARK_TIMEOUT_MS,
				HARPER_ABORT_MARKER_NO_REKEY: process.env.HARPER_ABORT_MARKER_NO_REKEY,
				HARPER_ABORT_MARKER_NO_RELOG: process.env.HARPER_ABORT_MARKER_NO_RELOG,
				ROCKSDB_JS_ABORT_MODE: process.env.ROCKSDB_JS_ABORT_MODE ?? '',
				ROCKSDB_JS_PRELOG_CHECK: process.env.ROCKSDB_JS_PRELOG_CHECK ?? '',
				ROCKSDB_JS_INTENT_REFUSAL: process.env.ROCKSDB_JS_INTENT_REFUSAL ?? '',
				HARPER_NO_CONFLICT_CAP: process.env.HARPER_NO_CONFLICT_CAP ?? '',
				HARPER_ABORT_MARKERS: process.env.HARPER_ABORT_MARKERS ?? '',
				HKC_ROCKSDB_JS: join(
					realpathSync(join(REPO_ROOT, 'node_modules', '@harperfast', 'rocksdb-js')),
					'dist',
					'index.mjs'
				),
			},
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
			const logBytesBefore = transactionLogBytes(ctx.harper.dataRootDir);
			const statsBefore = await getJson(agent, url, '/CommitStats/');
			const ticksBefore = threadClassTicks(statsBefore.pid);
			const machineBefore = machineTicks();
			const r = await runWorkload(agent, url, opts, name);
			const statsAfter = await getJson(agent, url, '/CommitStats/');
			const ticksAfter = threadClassTicks(statsAfter.pid);
			const machineAfter = machineTicks();
			const logBytes = transactionLogBytes(ctx.harper.dataRootDir) - logBytesBefore;
			const commitStats = describeStats(statsBefore, statsAfter, ticksBefore, ticksAfter, machineBefore, machineAfter);
			const line =
				`HOT_KEY_COMMIT_RESULT label=${opts.label || '-'} workload=${name} mode=${opts.mode} threads=${opts.threads} ` +
				`concurrency=${opts.concurrency} commits=${r.commits} commits_per_sec=${(r.commits / r.seconds).toFixed(0)} ` +
				`p50_ms=${percentile(r.latencies, 0.5).toFixed(2)} p99_ms=${percentile(r.latencies, 0.99).toFixed(2)} ` +
				`p999_ms=${percentile(r.latencies, 0.999).toFixed(2)} max_ms=${r.maxMs.toFixed(2)} ` +
				`retries=${r.retries ?? 'n/a'} retries_per_commit=${r.retries != null && r.commits ? (r.retries / r.commits).toFixed(3) : 'n/a'} ` +
				`max_retries=${r.retries == null ? 'n/a' : r.maxRetries} errors=${r.errors} errors_by_status=${r.errorsByStatus} ` +
				`counts_ok=${r.countsOk} harper_threads_seen=${r.harperThreads} client_elu=${r.clientElu.toFixed(2)} ` +
				`log_bytes=${logBytes} log_bytes_per_commit=${r.commits ? (logBytes / r.commits).toFixed(0) : 'n/a'} ${commitStats}`;
			console.log(line);
			if (r.countsOk === 'false') {
				console.log(`  count check: ${r.countDetail}`);
				if (opts.mode === 'add') process.exitCode = 1;
			}
			if (r.commits === 0) process.exitCode = 1;
			if (r.firstError) console.log(`  first error (any phase): ${r.firstError}`);
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
