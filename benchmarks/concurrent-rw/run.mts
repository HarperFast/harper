/**
 * ST-5 — Concurrent read+write on a highly-indexed table.
 *
 * Measures read latency (p50, p95, p99) under concurrent multi-condition
 * query load while a separate writer pool inserts records at a steady rate
 * into a table with 5 secondary indexes. The intent is to quantify the
 * latency penalty that index-maintenance under concurrent writes imposes on
 * readers.
 *
 * Workload:
 *   - `--writers` goroutines each insert continuously at full speed.
 *   - `--readers` goroutines each issue range/equality queries against
 *     indexed fields (category, region, status, priority, tag) continuously.
 *   - Both pools run concurrently for `--duration` seconds.
 *   - p99 read latency is compared against `--p99-ceiling-ms` (default 200 ms);
 *     the benchmark reports whether the ceiling was breached (does not exit
 *     non-zero — this is a measurement tool, not an assertion test).
 *
 * Usage (after npm run build from the repo root):
 *   node benchmarks/concurrent-rw/run.mts               # quick default
 *   node benchmarks/concurrent-rw/run.mts --scale=nightly
 *   node benchmarks/concurrent-rw/run.mts --readers=8 --writers=4 --duration=30
 *
 * Scales:
 *   quick   (default) — 2 000 seed records, 15 s run, 4 readers, 2 writers
 *   nightly           — 200 000 seed records, 120 s run, 16 readers, 8 writers
 *
 * Result format (parseable by a regression gate):
 *   CONCURRENT_RW_RESULT read_ops=NNN write_ops=NNN read_p50_ms=N.N read_p95_ms=N.N read_p99_ms=N.N p99_ceiling_ms=NNN ceiling_ok=true|false
 */
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHarperContext, setupHarperWithFixture, teardownHarper } from '@harperfast/integration-testing';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const REPO_ROOT = join(import.meta.dirname, '..', '..');
const HARPER_BIN = join(REPO_ROOT, 'dist', 'bin', 'harper.js');
const APP_DIR = join(import.meta.dirname, 'app');

interface Scale {
	seedRecords: number;
	durationSeconds: number;
	readers: number;
	writers: number;
}

const SCALE_PRESETS: Record<string, Scale> = {
	quick: { seedRecords: 2_000, durationSeconds: 15, readers: 4, writers: 2 },
	nightly: { seedRecords: 200_000, durationSeconds: 120, readers: 16, writers: 8 },
};

interface CliOptions extends Scale {
	engine: string;
	threads: number;
	p99CeilingMs: number;
	startupTimeoutMs: number;
	loadConcurrency: number;
}

function parseOptions(): CliOptions {
	const { values } = parseArgs({
		args: process.argv.slice(2),
		options: {
			'scale': { type: 'string', default: 'quick' },
			'seed-records': { type: 'string' },
			'duration': { type: 'string' },
			'readers': { type: 'string' },
			'writers': { type: 'string' },
			'engine': { type: 'string', default: 'rocksdb' },
			'threads': { type: 'string', default: '4' },
			'p99-ceiling-ms': { type: 'string', default: '200' },
			'load-concurrency': { type: 'string', default: '32' },
			'startup-timeout': { type: 'string', default: '120000' },
		},
		allowPositionals: false,
	});

	const scale = values.scale as string;
	const preset = SCALE_PRESETS[scale];
	if (!preset) throw new Error(`unknown scale "${scale}" (expected: ${Object.keys(SCALE_PRESETS).join(', ')})`);

	return {
		seedRecords: values['seed-records'] ? Number(values['seed-records']) : preset.seedRecords,
		durationSeconds: values.duration ? Number(values.duration) : preset.durationSeconds,
		readers: values.readers ? Number(values.readers) : preset.readers,
		writers: values.writers ? Number(values.writers) : preset.writers,
		engine: values.engine as string,
		threads: Number(values.threads),
		p99CeilingMs: Number(values['p99-ceiling-ms']),
		loadConcurrency: Number(values['load-concurrency']),
		startupTimeoutMs: Number(values['startup-timeout']),
	};
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

import http from 'node:http';

function createAgent(maxSockets: number): http.Agent {
	return new http.Agent({ keepAlive: true, maxSockets, maxFreeSockets: maxSockets });
}

function httpGet(agent: http.Agent, hostname: string, port: number, path: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const req = http.request({ hostname, port, path, method: 'GET', agent }, (res) => {
			res.resume();
			res.on('end', () => {
				if ((res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 500) resolve();
				else reject(new Error(`GET ${path} -> ${res.statusCode}`));
			});
			res.on('error', reject);
		});
		req.on('error', reject);
		req.setTimeout(30_000, () => req.destroy(new Error(`GET ${path} timed out`)));
		req.end();
	});
}

function httpPut(agent: http.Agent, hostname: string, port: number, path: string, body: Buffer): Promise<void> {
	return new Promise((resolve, reject) => {
		const req = http.request(
			{
				hostname,
				port,
				path,
				method: 'PUT',
				agent,
				headers: { 'content-type': 'application/json', 'content-length': String(body.length) },
			},
			(res) => {
				res.resume();
				res.on('end', () => {
					if ((res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300) resolve();
					else reject(new Error(`PUT ${path} -> ${res.statusCode}`));
				});
				res.on('error', reject);
			}
		);
		req.on('error', reject);
		req.setTimeout(30_000, () => req.destroy(new Error(`PUT ${path} timed out`)));
		req.write(body);
		req.end();
	});
}

// ---------------------------------------------------------------------------
// Latency percentile helpers
// ---------------------------------------------------------------------------

function percentile(sorted: number[], p: number): number {
	if (sorted.length === 0) return 0;
	return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}

// ---------------------------------------------------------------------------
// Startup probe
// ---------------------------------------------------------------------------

async function waitForRoute(url: string, deadlineMs: number): Promise<void> {
	const deadline = Date.now() + deadlineMs;
	while (Date.now() < deadline) {
		try {
			const res = await fetch(url, { signal: AbortSignal.timeout(5_000) });
			await res.body?.cancel();
			if (res.status >= 200 && res.status < 300) return;
		} catch {
			// not ready yet
		}
		await delay(250);
	}
	throw new Error(`timed out waiting for ${url}`);
}

// ---------------------------------------------------------------------------
// Git info
// ---------------------------------------------------------------------------

function gitInfo(): { commit: string; branch: string } {
	const read = (args: string[]) => {
		try {
			return execFileSync('git', args, { encoding: 'utf8' }).trim();
		} catch {
			return 'unknown';
		}
	};
	return { commit: read(['rev-parse', 'HEAD']), branch: read(['rev-parse', '--abbrev-ref', 'HEAD']) };
}

// ---------------------------------------------------------------------------
// Record / query helpers
// ---------------------------------------------------------------------------

const CATEGORIES = ['electronics', 'apparel', 'food', 'sports', 'books', 'tools'];
const REGIONS = ['us-east', 'us-west', 'eu-central', 'ap-south', 'ap-east'];
const STATUSES = ['active', 'inactive', 'pending', 'archived'];
const PRIORITIES = ['low', 'medium', 'high', 'critical'];
const TAGS = ['promo', 'clearance', 'new', 'featured', 'sale', 'bundle'];

function randomPick<T>(arr: T[]): T {
	return arr[(Math.random() * arr.length) | 0];
}

function makeRecord(index: number): Buffer {
	return Buffer.from(
		JSON.stringify({
			category: randomPick(CATEGORIES),
			region: randomPick(REGIONS),
			status: randomPick(STATUSES),
			priority: randomPick(PRIORITIES),
			tag: randomPick(TAGS),
			payload: 'p' + String(index).padStart(10, '0'),
		})
	);
}

/** Build a multi-condition read query against one or two indexed fields. */
function readQuery(): string {
	// Alternate between single-field and two-field queries to exercise both plans.
	const r = Math.random();
	if (r < 0.4) {
		// Single-field equality
		return `/hotindex/?category=${randomPick(CATEGORIES)}&limit(50)`;
	} else if (r < 0.7) {
		// Two-field conjunction
		return `/hotindex/?status=${randomPick(STATUSES)}&region=${randomPick(REGIONS)}&limit(50)`;
	} else {
		// Priority + tag
		return `/hotindex/?priority=${randomPick(PRIORITIES)}&tag=${randomPick(TAGS)}&limit(50)`;
	}
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
	const opts = parseOptions();

	console.log('\n' + '='.repeat(72));
	console.log('ST-5 Concurrent read+write on a highly-indexed table');
	console.log(
		`seed=${opts.seedRecords.toLocaleString()}  duration=${opts.durationSeconds}s  ` +
			`readers=${opts.readers}  writers=${opts.writers}  ` +
			`engine=${opts.engine}  threads=${opts.threads}`
	);
	console.log('='.repeat(72));

	const ctx = createHarperContext('concurrent-rw');
	const config: Record<string, unknown> = {
		threads: { count: opts.threads },
		analytics: { aggregatePeriod: -1 },
		logging: { level: 'warn' },
	};
	const env: Record<string, string> = { HARPER_STORAGE_ENGINE: opts.engine };

	console.log('Starting Harper...');
	await setupHarperWithFixture(ctx, APP_DIR, {
		harperBinPath: HARPER_BIN,
		config,
		env,
		startupTimeoutMs: opts.startupTimeoutMs,
	});

	const { httpURL } = ctx.harper;
	const parsed = new URL(httpURL);
	const hostname = parsed.hostname;
	const port = Number(parsed.port) || 9926;

	const readLatenciesMs: number[] = [];
	let readErrors = 0;
	let writeOps = 0;
	let writeErrors = 0;

	const agent = createAgent(opts.readers + opts.writers + opts.loadConcurrency);

	try {
		await waitForRoute(`${httpURL}/hotindex/`, 30_000);
		console.log(`Harper ready at ${httpURL}\n`);

		// --- Seed phase: pre-load records so readers have data from the start ---
		console.log(
			`[seed] inserting ${opts.seedRecords.toLocaleString()} records (concurrency=${opts.loadConcurrency})...`
		);
		const pad = Math.max(10, String(opts.seedRecords + 1_000_000).length);
		let seedCounter = 0;
		let seedErrors = 0;

		const seedWorker = async (): Promise<void> => {
			while (true) {
				const index = seedCounter++;
				if (index >= opts.seedRecords) break;
				const key = 'seed' + String(index).padStart(pad, '0');
				try {
					await httpPut(agent, hostname, port, `/hotindex/${key}`, makeRecord(index));
				} catch {
					seedErrors++;
				}
			}
		};
		await Promise.all(Array.from({ length: opts.loadConcurrency }, seedWorker));
		console.log(`[seed] done — ${opts.seedRecords.toLocaleString()} records (${seedErrors} errors)\n`);

		// --- Concurrent read + write phase ---
		console.log(`[bench] starting ${opts.readers} readers + ${opts.writers} writers for ${opts.durationSeconds}s...`);
		const benchStart = Date.now();
		const deadlineMs = opts.durationSeconds * 1_000;
		let writeCounter = opts.seedRecords; // writers pick up where seed left off

		// Reader worker: issues multi-condition queries continuously.
		const readerWorker = async (): Promise<void> => {
			while (Date.now() - benchStart < deadlineMs) {
				const path = readQuery();
				const start = performance.now();
				try {
					await httpGet(agent, hostname, port, path);
					readLatenciesMs.push(performance.now() - start);
				} catch {
					readErrors++;
				}
			}
		};

		// Writer worker: inserts new records continuously.
		const writerWorker = async (): Promise<void> => {
			while (Date.now() - benchStart < deadlineMs) {
				const index = writeCounter++;
				const key = 'live' + String(index).padStart(pad, '0');
				try {
					await httpPut(agent, hostname, port, `/hotindex/${key}`, makeRecord(index));
					writeOps++;
				} catch {
					writeErrors++;
				}
			}
		};

		// Progress reporter (every 5s).
		// Live p99 is intentionally omitted: sorting the growing latency array on the event loop
		// every 5 s would block the readers/writers and inflate the very metric being measured.
		// Final percentiles are computed once after all workers finish (see Report section below).
		const reportInterval = setInterval(() => {
			const elapsed = ((Date.now() - benchStart) / 1_000).toFixed(1);
			const remaining = (opts.durationSeconds - parseFloat(elapsed)).toFixed(0);
			process.stdout.write(
				`  elapsed=${elapsed}s remaining=${remaining}s reads=${readLatenciesMs.length.toLocaleString()} writes=${writeOps.toLocaleString()}\n`
			);
		}, 5_000);

		await Promise.all([
			...Array.from({ length: opts.readers }, readerWorker),
			...Array.from({ length: opts.writers }, writerWorker),
		]);
		clearInterval(reportInterval);
	} finally {
		agent.destroy();
		await teardownHarper(ctx);
		console.log('Harper stopped.');
	}

	// ---------------------------------------------------------------------------
	// Report
	// ---------------------------------------------------------------------------
	const sorted = readLatenciesMs.slice().sort((a, b) => a - b);
	const p50 = percentile(sorted, 0.5);
	const p95 = percentile(sorted, 0.95);
	const p99 = percentile(sorted, 0.99);
	const pMax = sorted.length > 0 ? sorted[sorted.length - 1] : 0;
	const ceilingOk = p99 <= opts.p99CeilingMs;

	const { commit, branch } = gitInfo();

	console.log('\n' + '='.repeat(72));
	console.log('ST-5 Concurrent read+write — RESULTS');
	console.log(
		`git: ${branch}@${commit.slice(0, 10)}  node: ${process.version}  platform: ${process.platform}-${process.arch}`
	);
	console.log('-'.repeat(72));
	console.log(`Read ops     : ${readLatenciesMs.length.toLocaleString()} (${readErrors} errors)`);
	console.log(`Write ops    : ${writeOps.toLocaleString()} (${writeErrors} errors)`);
	console.log(
		`Read latency : p50=${p50.toFixed(1)}ms  p95=${p95.toFixed(1)}ms  p99=${p99.toFixed(1)}ms  max=${pMax.toFixed(1)}ms`
	);
	console.log(`p99 ceiling  : ${opts.p99CeilingMs}ms — ${ceilingOk ? 'OK' : 'BREACHED'}`);
	if (!ceilingOk) {
		console.log(
			`  ↳ p99 ${p99.toFixed(1)}ms > ${opts.p99CeilingMs}ms ceiling — consider tuning concurrency or indexes`
		);
	}
	console.log('='.repeat(72));

	// Machine-parseable summary
	console.log(
		`\nCONCURRENT_RW_RESULT read_ops=${readLatenciesMs.length} write_ops=${writeOps} ` +
			`read_p50_ms=${p50.toFixed(1)} read_p95_ms=${p95.toFixed(1)} read_p99_ms=${p99.toFixed(1)} ` +
			`p99_ceiling_ms=${opts.p99CeilingMs} ceiling_ok=${ceilingOk}`
	);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
