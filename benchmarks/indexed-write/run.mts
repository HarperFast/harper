/**
 * ST-2 — Indexed-write throughput benchmark.
 *
 * Measures write ops/sec on three table variants that differ only in how many
 * @indexed secondary fields each has:
 *   baseline  — primary key only (0 secondary indexes)
 *   indexed3  — 3 @indexed fields
 *   indexed5  — 5 @indexed fields
 *
 * Each variant is loaded with `--records` inserts at `--concurrency` in-flight
 * requests and the steady-state throughput is reported. A ratio vs. the
 * unindexed baseline is printed so regression tracking can gate on relative
 * cost growth rather than absolute numbers (which vary by hardware/CI runner).
 *
 * Warmup strategy (removes ordering bias):
 *   1. Instance-level warmup: before any variant is measured, a throwaway
 *      insert loop fires `--instance-warmup` requests against the baseline
 *      table so JIT, connection-pool, and RocksDB page-cache are hot.
 *   2. Per-variant warmup: the first `--variant-warmup` requests of every
 *      variant are sent but excluded from the timing window, so each variant
 *      is measured at steady state regardless of its position in the loop.
 *
 * Usage (after npm run build from the repo root):
 *   node benchmarks/indexed-write/run.mts                   # small/quick default
 *   node benchmarks/indexed-write/run.mts --scale=nightly   # 1M records (CI nightly)
 *   node benchmarks/indexed-write/run.mts --records=20000 --concurrency=16
 *
 * Scales:
 *   quick   (default) — 5 000 records, 16 concurrency  (~30s total)
 *   nightly           — 1 000 000 records, 64 concurrency
 *
 * Result format (parseable by a regression gate):
 *   INDEXED_WRITE_RESULT variant=baseline ops_per_sec=NNN
 *   INDEXED_WRITE_RESULT variant=indexed3  ops_per_sec=NNN ratio_vs_baseline=N.NN
 *   INDEXED_WRITE_RESULT variant=indexed5  ops_per_sec=NNN ratio_vs_baseline=N.NN
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

const SCALE_PRESETS: Record<
	string,
	{ records: number; concurrency: number; instanceWarmup: number; variantWarmup: number }
> = {
	quick: { records: 5_000, concurrency: 16, instanceWarmup: 500, variantWarmup: 200 },
	nightly: { records: 1_000_000, concurrency: 64, instanceWarmup: 2_000, variantWarmup: 1_000 },
};

const VARIANTS = ['baseline', 'indexed3', 'indexed5'] as const;
type Variant = (typeof VARIANTS)[number];

interface CliOptions {
	records: number;
	concurrency: number;
	engine: string;
	threads: number;
	startupTimeoutMs: number;
	instanceWarmup: number;
	variantWarmup: number;
}

function parseOptions(): CliOptions {
	const { values } = parseArgs({
		args: process.argv.slice(2),
		options: {
			'scale': { type: 'string', default: 'quick' },
			'records': { type: 'string' },
			'concurrency': { type: 'string' },
			'engine': { type: 'string', default: 'rocksdb' },
			'threads': { type: 'string', default: '4' },
			'startup-timeout': { type: 'string', default: '120000' },
			'instance-warmup': { type: 'string' },
			'variant-warmup': { type: 'string' },
		},
		allowPositionals: false,
	});

	const preset = SCALE_PRESETS[values.scale as string];
	if (!preset) throw new Error(`unknown scale "${values.scale}" (expected: ${Object.keys(SCALE_PRESETS).join(', ')})`);

	return {
		records: values.records ? Number(values.records) : preset.records,
		concurrency: values.concurrency ? Number(values.concurrency) : preset.concurrency,
		engine: values.engine as string,
		threads: Number(values.threads),
		startupTimeoutMs: Number(values['startup-timeout']),
		instanceWarmup: values['instance-warmup'] !== undefined ? Number(values['instance-warmup']) : preset.instanceWarmup,
		variantWarmup: values['variant-warmup'] !== undefined ? Number(values['variant-warmup']) : preset.variantWarmup,
	};
}

// ---------------------------------------------------------------------------
// HTTP helpers (reuses the same no-dep pattern as ycsb/restClient.mts)
// ---------------------------------------------------------------------------

import http from 'node:http';

function createAgent(maxSockets: number): http.Agent {
	return new http.Agent({ keepAlive: true, maxSockets, maxFreeSockets: maxSockets });
}

function put(agent: http.Agent, hostname: string, port: number, path: string, body: Buffer): Promise<void> {
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
				res.resume(); // drain
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
// Payload pool (shared between warmup and measured runs)
// ---------------------------------------------------------------------------

function buildPayloadPool(size: number): Buffer[] {
	return Array.from({ length: size }, (_, i) =>
		Buffer.from(
			JSON.stringify({
				field0: 'val' + String(i % 1000).padStart(6, '0'),
				field1: 'cat' + String((i * 7) % 100),
				field2: 'reg' + String((i * 13) % 50),
				field3: 'str' + String((i * 3) % 200),
				field4: 'tag' + String((i * 17) % 80),
			})
		)
	);
}

// ---------------------------------------------------------------------------
// Workload driver
// ---------------------------------------------------------------------------

interface WriteResult {
	ops: number;
	errors: number;
	elapsedMs: number;
	throughput: number;
}

/**
 * Send `count` PUT requests to `table`, starting at key offset `keyOffset`.
 * If `timed` is false the elapsed time is not meaningful (used for warmup).
 */
async function driveWrites(
	agent: http.Agent,
	hostname: string,
	port: number,
	table: string,
	count: number,
	concurrency: number,
	keyOffset: number,
	payloadPool: Buffer[]
): Promise<WriteResult> {
	const pad = Math.max(10, String(keyOffset + count).length);
	const formatKey = (i: number) => 'key' + String(i).padStart(pad, '0');

	let dispatched = 0;
	let errors = 0;

	const worker = async (): Promise<void> => {
		while (true) {
			const index = dispatched++;
			if (index >= count) break;
			const key = formatKey(keyOffset + index);
			const body = payloadPool[index % payloadPool.length];
			try {
				await put(agent, hostname, port, `/${table}/${key}`, body);
			} catch {
				errors++;
			}
		}
	};

	const start = performance.now();
	await Promise.all(Array.from({ length: concurrency }, worker));
	const elapsedMs = performance.now() - start;
	const ops = count - errors;
	return { ops, errors, elapsedMs, throughput: (ops * 1_000) / elapsedMs };
}

// ---------------------------------------------------------------------------
// Startup probe (same pattern as ycsb/run-single-node.mts)
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
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
	const opts = parseOptions();

	console.log('\n' + '='.repeat(72));
	console.log('ST-2 Indexed-write throughput benchmark');
	console.log(
		`records=${opts.records.toLocaleString()}  concurrency=${opts.concurrency}  engine=${opts.engine}  threads=${opts.threads}`
	);
	console.log(
		`instance-warmup=${opts.instanceWarmup.toLocaleString()}  variant-warmup=${opts.variantWarmup.toLocaleString()}`
	);
	console.log('='.repeat(72));

	const ctx = createHarperContext('indexed-write');
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

	const results: Array<{ variant: Variant; throughput: number; errors: number }> = [];

	// Pre-build a shared payload pool large enough for all warmup + measured runs.
	const POOL_SIZE = Math.min(opts.records, 500);
	const payloadPool = buildPayloadPool(POOL_SIZE);

	try {
		// Wait for all three tables to be routable.
		for (const variant of VARIANTS) {
			await waitForRoute(`${httpURL}/${variant}/`, 30_000);
		}
		console.log(`Harper ready at ${httpURL}\n`);

		const agent = createAgent(opts.concurrency);
		try {
			// -----------------------------------------------------------------
			// Phase 1: Instance-level warmup (not timed, not reported)
			// Inserts into the baseline table to heat JIT, connection pool, and
			// RocksDB page cache before any variant is measured.
			// -----------------------------------------------------------------
			if (opts.instanceWarmup > 0) {
				process.stdout.write(
					`[warmup] instance-level: ${opts.instanceWarmup.toLocaleString()} requests to baseline...`
				);
				await driveWrites(agent, hostname, port, 'baseline', opts.instanceWarmup, opts.concurrency, 0, payloadPool);
				process.stdout.write(' done\n\n');
			}

			// -----------------------------------------------------------------
			// Phase 2: Per-variant measured runs.
			// Each variant begins with an untimed per-variant warmup so any
			// remaining cold-start cost (routing cache, schema lookup, etc.) is
			// absorbed before the clock starts.
			// -----------------------------------------------------------------
			for (const variant of VARIANTS) {
				// Per-variant warmup: use key range [0, variantWarmup) — may
				// overlap with instance warmup keys, which is fine (updates are
				// cheap and exercise the same code path as inserts at this stage).
				if (opts.variantWarmup > 0) {
					process.stdout.write(`[${variant}] per-variant warmup: ${opts.variantWarmup.toLocaleString()} requests...`);
					await driveWrites(agent, hostname, port, variant, opts.variantWarmup, opts.concurrency, 0, payloadPool);
					process.stdout.write(' done\n');
				}

				// Measured run: use key range [variantWarmup, variantWarmup + records).
				process.stdout.write(`[${variant}] measuring ${opts.records.toLocaleString()} records...`);
				const result = await driveWrites(
					agent,
					hostname,
					port,
					variant,
					opts.records,
					opts.concurrency,
					opts.variantWarmup,
					payloadPool
				);
				process.stdout.write(
					` done — ${result.throughput.toFixed(0)} ops/sec (${result.errors} errors, ${(result.elapsedMs / 1_000).toFixed(1)}s)\n`
				);
				results.push({ variant, throughput: result.throughput, errors: result.errors });
			}
		} finally {
			agent.destroy();
		}
	} finally {
		await teardownHarper(ctx);
		console.log('Harper stopped.');
	}

	// ---------------------------------------------------------------------------
	// Report
	// ---------------------------------------------------------------------------
	const baseline = results.find((r) => r.variant === 'baseline')!.throughput;
	const { commit, branch } = gitInfo();

	console.log('\n' + '='.repeat(72));
	console.log('ST-2 Indexed-write throughput — RESULTS');
	console.log(
		`git: ${branch}@${commit.slice(0, 10)}  node: ${process.version}  platform: ${process.platform}-${process.arch}`
	);
	console.log('-'.repeat(72));
	console.log(`${'variant'.padEnd(12)}${'ops/sec'.padStart(12)}${'ratio'.padStart(10)}${'errors'.padStart(10)}`);
	console.log('-'.repeat(72));
	for (const r of results) {
		const ratio = r.variant === 'baseline' ? '—' : (r.throughput / baseline).toFixed(3);
		console.log(
			`${r.variant.padEnd(12)}${r.throughput.toFixed(0).padStart(12)}${ratio.padStart(10)}${String(r.errors).padStart(10)}`
		);
	}
	console.log('='.repeat(72));

	// Machine-parseable lines for regression gate
	const baselineResult = results.find((r) => r.variant === 'baseline')!;
	console.log(`\nINDEXED_WRITE_RESULT variant=baseline ops_per_sec=${baselineResult.throughput.toFixed(0)}`);
	for (const r of results.filter((x) => x.variant !== 'baseline')) {
		const ratio = (r.throughput / baseline).toFixed(3);
		console.log(
			`INDEXED_WRITE_RESULT variant=${r.variant} ops_per_sec=${r.throughput.toFixed(0)} ratio_vs_baseline=${ratio}`
		);
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
