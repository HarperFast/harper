/**
 * ST-1 — TTL-churn / map-size growth benchmark.
 *
 * Runs a sustained insert-with-TTL workload and samples the on-disk data
 * directory size periodically to verify that storage stays bounded — i.e. that
 * Harper's TTL eviction + compaction reclaims space rather than growing
 * unboundedly as records expire.
 *
 * Two scales:
 *   quick   (default) — 10 000 records, 60 s TTL, 30 s run  (~1 min)
 *   nightly           — 1 000 000 records, 60 s TTL, 30+ min (opt-in CI only)
 *
 * For the "nightly" scale, only use this in CI — do NOT run it locally as it
 * takes 30+ minutes. The quick default is designed for local validation.
 *
 * Usage (after npm run build from the repo root):
 *   node benchmarks/ttl-churn/run.mts                   # quick default
 *   node benchmarks/ttl-churn/run.mts --scale=nightly   # long CI run (DO NOT run locally)
 *   node benchmarks/ttl-churn/run.mts --records=5000 --ttl=30 --duration=60
 *
 * Options:
 *   --scale         quick (default) | nightly
 *   --records       inserts per wave before sampling
 *   --ttl           TTL in seconds for each record
 *   --duration      total benchmark duration in seconds
 *   --concurrency   concurrent in-flight inserts
 *   --engine        rocksdb (default) | lmdb
 *   --threads       Harper worker thread count
 *   --sample-every  seconds between disk-size samples
 *
 * Result format (parseable by a regression gate):
 *   TTL_CHURN_SAMPLE  elapsed_s=NNN   dir_bytes=NNN   records_inserted=NNN
 *   TTL_CHURN_RESULT  duration_s=NNN  peak_bytes=NNN  final_bytes=NNN  total_inserts=NNN  bounded=true|false
 */
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { stat, readdir } from 'node:fs/promises';
import { createHarperContext, setupHarperWithFixture, teardownHarper } from '@harperfast/integration-testing';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const REPO_ROOT = join(import.meta.dirname, '..', '..');
const HARPER_BIN = join(REPO_ROOT, 'dist', 'bin', 'harper.js');
const APP_DIR = join(import.meta.dirname, 'app');

interface Scale {
	records: number; // inserts per wave
	ttlSeconds: number; // TTL per record
	durationSeconds: number; // total run duration
	concurrency: number;
	sampleEverySeconds: number;
}

const SCALE_PRESETS: Record<string, Scale> = {
	quick: {
		records: 10_000,
		ttlSeconds: 60,
		durationSeconds: 30,
		concurrency: 32,
		sampleEverySeconds: 5,
	},
	nightly: {
		records: 1_000_000,
		ttlSeconds: 60,
		durationSeconds: 1_800, // 30 min
		concurrency: 64,
		sampleEverySeconds: 60,
	},
};

interface CliOptions extends Scale {
	engine: string;
	threads: number;
	startupTimeoutMs: number;
}

function parseOptions(): CliOptions {
	const { values } = parseArgs({
		args: process.argv.slice(2),
		options: {
			'scale': { type: 'string', default: 'quick' },
			'records': { type: 'string' },
			'ttl': { type: 'string' },
			'duration': { type: 'string' },
			'concurrency': { type: 'string' },
			'engine': { type: 'string', default: 'rocksdb' },
			'threads': { type: 'string', default: '4' },
			'sample-every': { type: 'string' },
			'startup-timeout': { type: 'string', default: '120000' },
		},
		allowPositionals: false,
	});

	const scale = values.scale as string;
	const preset = SCALE_PRESETS[scale];
	if (!preset) throw new Error(`unknown scale "${scale}" (expected: ${Object.keys(SCALE_PRESETS).join(', ')})`);

	if (scale === 'nightly') {
		console.warn('WARNING: --scale=nightly runs for 30+ minutes. Only use this in CI/nightly jobs, not locally.');
	}

	return {
		records: values.records ? Number(values.records) : preset.records,
		ttlSeconds: values.ttl ? Number(values.ttl) : preset.ttlSeconds,
		durationSeconds: values.duration ? Number(values.duration) : preset.durationSeconds,
		concurrency: values.concurrency ? Number(values.concurrency) : preset.concurrency,
		sampleEverySeconds: values['sample-every'] ? Number(values['sample-every']) : preset.sampleEverySeconds,
		engine: values.engine as string,
		threads: Number(values.threads),
		startupTimeoutMs: Number(values['startup-timeout']),
	};
}

// ---------------------------------------------------------------------------
// Disk-size sampling
// ---------------------------------------------------------------------------

/** Recursively sum the byte sizes of all regular files under a directory. */
async function dirBytes(dir: string): Promise<number> {
	let entries: string[];
	try {
		entries = await readdir(dir);
	} catch {
		return 0;
	}
	const sizes = await Promise.all(
		entries.map(async (name) => {
			const full = join(dir, name);
			try {
				const s = await stat(full);
				if (s.isDirectory()) {
					return await dirBytes(full);
				}
				return s.size;
			} catch {
				// ignore races with TTL cleanup deleting files
				return 0;
			}
		})
	);
	return sizes.reduce((sum, size) => sum + size, 0);
}

// ---------------------------------------------------------------------------
// HTTP helpers
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
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
	const opts = parseOptions();

	console.log('\n' + '='.repeat(72));
	console.log('ST-1 TTL-churn / map-size growth benchmark');
	console.log(
		`records_per_wave=${opts.records.toLocaleString()}  ttl=${opts.ttlSeconds}s  duration=${opts.durationSeconds}s  ` +
			`concurrency=${opts.concurrency}  engine=${opts.engine}  threads=${opts.threads}`
	);
	console.log('='.repeat(72));

	const ctx = createHarperContext('ttl-churn');
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
	const dataRootDir = ctx.harper.dataRootDir;
	const parsed = new URL(httpURL);
	const hostname = parsed.hostname;
	const port = Number(parsed.port) || 9926;

	interface Sample {
		elapsedS: number;
		bytes: number;
		totalInserts: number;
	}

	const samples: Sample[] = [];
	let totalInserts = 0;
	let insertErrors = 0;
	let keyCounter = 0;

	const agent = createAgent(opts.concurrency);

	try {
		await waitForRoute(`${httpURL}/ttlrecord/`, 30_000);
		console.log(`Harper ready at ${httpURL}`);
		if (dataRootDir) {
			console.log(`Data dir: ${dataRootDir}`);
		} else {
			console.log('NOTE: dataRootDir not available; disk-size sampling will report 0.');
		}
		console.log('');

		const benchStart = Date.now();
		let lastSampleTime = benchStart;
		let lastProgressTime = benchStart;

		// Insert loop: keep inserting batches until the duration expires.
		// Each batch is `opts.concurrency` records inserted in parallel, then
		// we check if it's time to sample or if the duration has elapsed.
		const ttlMs = opts.ttlSeconds * 1_000;

		while (Date.now() - benchStart < opts.durationSeconds * 1_000) {
			const now = Date.now();

			// Sample disk size?
			if (now - lastSampleTime >= opts.sampleEverySeconds * 1_000) {
				const bytes = dataRootDir ? await dirBytes(dataRootDir) : 0;
				const elapsedS = (now - benchStart) / 1_000;
				samples.push({ elapsedS, bytes, totalInserts });
				lastSampleTime = now;
				const mb = (bytes / (1024 * 1024)).toFixed(2);
				console.log(
					`[sample] elapsed=${elapsedS.toFixed(1)}s  dir=${mb} MiB  inserts=${totalInserts.toLocaleString()}`
				);
				console.log(
					`TTL_CHURN_SAMPLE elapsed_s=${elapsedS.toFixed(1)} dir_bytes=${bytes} records_inserted=${totalInserts}`
				);
			}

			// Log progress at most once per 10s.
			if (now - lastProgressTime >= 10_000) {
				const elapsedS = (now - benchStart) / 1_000;
				const remainingS = opts.durationSeconds - elapsedS;
				process.stdout.write(
					`  ${totalInserts.toLocaleString()} records inserted, ` +
						`${remainingS.toFixed(0)}s remaining, ${insertErrors} errors\n`
				);
				lastProgressTime = now;
			}

			// Insert one batch.
			const batchSize = opts.concurrency;
			const expiresAt = Date.now() + ttlMs;
			const batch: Promise<void>[] = [];
			for (let i = 0; i < batchSize; i++) {
				const key = 'ttl' + String(keyCounter++).padStart(12, '0');
				const body = Buffer.from(JSON.stringify({ payload: 'x'.repeat(64), expiresAt }));
				batch.push(
					put(agent, hostname, port, `/ttlrecord/${key}`, body).catch(() => {
						insertErrors++;
					})
				);
			}
			await Promise.all(batch);
			totalInserts += batchSize;
		}

		// Final sample after run completes.
		const finalBytes = dataRootDir ? await dirBytes(dataRootDir) : 0;
		const elapsedS = (Date.now() - benchStart) / 1_000;
		samples.push({ elapsedS, bytes: finalBytes, totalInserts });
		console.log(
			`TTL_CHURN_SAMPLE elapsed_s=${elapsedS.toFixed(1)} dir_bytes=${finalBytes} records_inserted=${totalInserts}`
		);
	} finally {
		agent.destroy();
		await teardownHarper(ctx);
		console.log('Harper stopped.');
	}

	// ---------------------------------------------------------------------------
	// Report
	// ---------------------------------------------------------------------------
	const peakBytes = samples.reduce((m, s) => Math.max(m, s.bytes), 0);
	const finalBytes = samples.length > 0 ? samples[samples.length - 1].bytes : 0;

	// "Bounded" heuristic: the final size is <= 150% of the peak at the halfway
	// point (allowing for compaction lag) — or if there was no growth at all.
	const halfwaySample = samples[Math.floor(samples.length / 2)];
	const halfwayBytes = halfwaySample?.bytes ?? peakBytes;
	const bounded = finalBytes <= halfwayBytes * 1.5 || peakBytes === 0;

	const { commit, branch } = gitInfo();
	const peakMb = (peakBytes / (1024 * 1024)).toFixed(2);
	const finalMb = (finalBytes / (1024 * 1024)).toFixed(2);

	console.log('\n' + '='.repeat(72));
	console.log('ST-1 TTL-churn / map-size growth — RESULTS');
	console.log(
		`git: ${branch}@${commit.slice(0, 10)}  node: ${process.version}  platform: ${process.platform}-${process.arch}`
	);
	console.log('-'.repeat(72));
	console.log(`Total inserts : ${totalInserts.toLocaleString()} (${insertErrors} errors)`);
	console.log(`Peak dir size : ${peakMb} MiB`);
	console.log(`Final dir size: ${finalMb} MiB`);
	console.log(`Storage bounded: ${bounded ? 'YES' : 'NO (growth detected — check compaction)'}`);
	console.log('');
	console.log('Size-over-time:');
	console.log(`  ${'elapsed(s)'.padStart(12)}  ${'dir_MiB'.padStart(10)}  ${'inserts'.padStart(12)}`);
	for (const s of samples) {
		const mb = (s.bytes / (1024 * 1024)).toFixed(2);
		console.log(`  ${s.elapsedS.toFixed(1).padStart(12)}  ${mb.padStart(10)}  ${String(s.totalInserts).padStart(12)}`);
	}
	console.log('='.repeat(72));

	// Machine-parseable summary
	console.log(
		`\nTTL_CHURN_RESULT duration_s=${opts.durationSeconds} peak_bytes=${peakBytes} final_bytes=${finalBytes} total_inserts=${totalInserts} bounded=${bounded}`
	);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
