/**
 * YCSB-style CRUD load test against a single local Harper (core) instance.
 *
 * Boots one Harper instance via @harperfast/integration-testing with the
 * `usertable` app pre-installed, then drives the YCSB load + run phases over
 * the HTTP REST interface and writes JSON results.
 *
 * Build Harper first (npm run build), then run e.g.:
 *   node benchmarks/ycsb/run-single-node.mts --scale=standard
 *   node benchmarks/ycsb/run-single-node.mts --scale=quick --workloads=C,A
 *   node benchmarks/ycsb/run-single-node.mts --engine=lmdb --threads=4
 *
 * See harness.mts (parseOptions) for the full flag list.
 */
import { setTimeout as delay } from 'node:timers/promises';
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { createHarperContext, setupHarperWithFixture, teardownHarper } from '@harperfast/integration-testing';
import { parseOptions, runBenchmark, writeResults, printReport } from './harness.mts';

const REPO_ROOT = join(import.meta.dirname, '..', '..');
const HARPER_BIN = join(REPO_ROOT, 'dist', 'bin', 'harper.js');
const APP_DIR = join(import.meta.dirname, 'app');

async function waitForRoute(url: string, deadlineMs: number): Promise<void> {
	const deadline = Date.now() + deadlineMs;
	while (Date.now() < deadline) {
		try {
			const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
			await res.body?.cancel(); // always drain so the socket is freed
			// Require 2xx: after startup the HTTP stack is up but the usertable route may not be
			// registered yet, and a 404 from the router would falsely pass a < 500 check.
			if (res.status >= 200 && res.status < 300) return;
		} catch {
			// not accepting connections yet (or this probe timed out)
		}
		await delay(250);
	}
	throw new Error(`timed out waiting for ${url}`);
}

async function main(): Promise<void> {
	const options = parseOptions(process.argv.slice(2));
	const ctx = createHarperContext('ycsb-single-node');

	// In --profile mode, run the HTTP server on the main thread (threads.count=0)
	// so a single NODE_OPTIONS --cpu-prof captures request handling — Harper's
	// worker threads use a fixed execArgv that --cpu-prof can't reach.
	const threads = options.profile ? 0 : options.threads;
	// This config is passed as HARPER_SET_CONFIG, which takes precedence over (and filters out)
	// the framework's hard-coded CLI args — so threads.count and logging.level here override the
	// framework defaults of --THREADS_COUNT=1 and --LOGGING_LEVEL=debug. The latter matters:
	// debug logging under load would be a major measurement confound.
	const config: Record<string, unknown> = {
		threads: { count: threads },
		analytics: { aggregatePeriod: -1 }, // analytics aggregation is noisy under load
		logging: { level: 'warn' },
	};
	// Set the engine explicitly (not only when non-default) so the run is pinned to the
	// requested engine even if Harper's default changes, matching the reported config.
	const env: Record<string, string> = { HARPER_STORAGE_ENGINE: options.engine };
	let profileDir: string | undefined;
	if (options.profile) {
		profileDir = join(options.out, 'profile');
		await mkdir(profileDir, { recursive: true });
		env.NODE_OPTIONS = `--cpu-prof --cpu-prof-dir=${profileDir}`;
	}

	console.log(
		`Starting Harper (threads.count=${threads}, engine=${options.engine}${options.profile ? ', profiling' : ''})...`
	);
	await setupHarperWithFixture(ctx, APP_DIR, {
		harperBinPath: HARPER_BIN,
		config,
		env,
		startupTimeoutMs: options.startupTimeoutMs,
	});

	const { httpURL } = ctx.harper;
	try {
		await waitForRoute(`${httpURL}/${options.config.table}/`, 30_000);
		console.log(`Harper ready at ${httpURL}`);
		const results = await runBenchmark([httpURL], options);
		const file = await writeResults(results, options.out, 'single-node');
		printReport(results);
		console.log(`\nResults written to ${file}`);
	} finally {
		await teardownHarper(ctx);
		console.log('Harper stopped.');
		if (profileDir) console.log(`CPU profile(s) in ${profileDir}`);
	}
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
