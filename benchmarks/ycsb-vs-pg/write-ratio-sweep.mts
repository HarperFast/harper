/**
 * Locates where a target's cost-per-operation changes as the write fraction grows.
 *
 * Motivated by a specific anomaly: Harper serves a read-only mix at ~7,600 ops
 * per server CPU-second, but a 95%-read / 5%-update mix at ~2,800 — a 2.7x drop
 * bought with only 5% writes — while going on to 50% writes costs barely 25%
 * more. That shape is not "writes are expensive"; it points at a cost that is
 * paid per *batch of concurrent work* rather than per write. This sweeps the
 * update fraction so the knee can be seen directly instead of inferred from
 * three far-apart YCSB workloads.
 *
 *   node benchmarks/ycsb-vs-pg/write-ratio-sweep.mts --target=harper
 *   node benchmarks/ycsb-vs-pg/write-ratio-sweep.mts --ratios=0,0.001,0.01,0.05,0.5
 */
import { parseArgs } from 'node:util';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createHarperContext, setupHarperWithFixture, teardownHarper } from '@harperfast/integration-testing';
import { startDriver } from './shardedDriver.mts';
import { startPgStack, dataDir } from './pgStack.mts';
import {
	sampleResources,
	diffResources,
	pinProcesses,
	ClockProbe,
	parseCpuList,
	onlineCpus,
	type ResourceTargets,
} from './resources.mts';
import { mkdir } from 'node:fs/promises';
import { statSync } from 'node:fs';

const REPO_ROOT = join(import.meta.dirname, '..', '..');

const { values } = parseArgs({
	options: {
		target: { type: 'string', default: 'harper' },
		ratios: { type: 'string', default: '0,0.005,0.01,0.02,0.05,0.1,0.25,0.5' },
		records: { type: 'string', default: '200000' },
		ops: { type: 'string', default: '300000' },
		concurrency: { type: 'string', default: '128' },
		threads: { type: 'string', default: '8' },
		shards: { type: 'string', default: '6' },
		reps: { type: 'string', default: '2' },
		// Disjoint, homogeneous CPU sets for server and load generator. See pinProcesses().
		serverCpus: { type: 'string' },
		driverCpus: { type: 'string' },
	},
});

const RECORDS = Number(values.records);
const OPS = Number(values.ops);
const CONCURRENCY = Number(values.concurrency);
const THREADS = Number(values.threads);
const SHARDS = Number(values.shards);
const REPS = Number(values.reps);
const RATIOS = (values.ratios as string).split(',').map(Number);

async function waitForRoute(url: string, deadlineMs: number): Promise<void> {
	const deadline = Date.now() + deadlineMs;
	while (Date.now() < deadline) {
		try {
			const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
			await res.body?.cancel();
			if (res.status >= 200 && res.status < 300) return;
		} catch {
			// not up yet
		}
		await delay(250);
	}
	throw new Error(`timed out waiting for ${url}`);
}

/** One freshly started server per ratio, matching run-compare's isolation. */
async function measureRatio(ratio: number): Promise<{ throughput: number; cpu: number; opsPerCore: number }> {
	const mix = ratio === 0 ? { read: 1 } : { read: 1 - ratio, update: ratio };
	const run = async (baseUrl: string, targets: ResourceTargets) => {
		if (values.serverCpus) {
			const n = await pinProcesses(Object.values(targets.processes)[0], values.serverCpus);
			console.log(`    pinned ${n} server process(es) to cpus ${values.serverCpus}`);
		}
		const driver = await startDriver({
			baseUrl,
			table: 'usertable',
			records: RECORDS,
			opsPerWorkload: OPS,
			concurrency: CONCURRENCY,
			shards: SHARDS,
			shape: { fieldCount: 10, fieldLength: 100 },
			keyWidth: 10,
			maxScanLength: 100,
		});
		try {
			if (values.driverCpus) {
				const n = await pinProcesses('shardWorker.mts', values.driverCpus);
				console.log(`    pinned ${n} shard worker(s) to cpus ${values.driverCpus}`);
			}
			await driver.runWorkload('C', 'uniform', RECORDS * 2);
			const reps: { throughput: number; cpu: number }[] = [];
			const clockCpus = values.serverCpus ? parseCpuList(values.serverCpus) : onlineCpus();
			for (let rep = 0; rep < REPS; rep++) {
				const clock = new ClockProbe(clockCpus);
				const before = await sampleResources(targets);
				clock.start();
				const result = await driver.runWorkload('C', 'zipfian', OPS, mix);
				const ghz = clock.stop();
				const delta = diffResources(before, await sampleResources(targets));
				reps.push({ throughput: result.throughput, cpu: delta.totalCpuSeconds });
				console.log(
					`    [${new Date().toTimeString().slice(0, 8)}] rep ${rep}: ${result.throughput.toFixed(0)} ops/sec, ` +
						`${delta.totalCpuSeconds.toFixed(1)} cpu-s @ ${ghz.toFixed(2)} GHz, ` +
						`${(OPS / Math.max(delta.totalCpuSeconds, 1e-9)).toFixed(0)} ops/core-s, ` +
						`${(OPS / Math.max(delta.totalCpuSeconds * (ghz || 1), 1e-9)).toFixed(0)} ops/Gcycle`
				);
			}
			// Reported point is the best rep. The slow mode under investigation is intermittent and
			// CPU-bound, so a worst-of-N summary reports how often it fires, not how the write ratio
			// costs — which is what this sweep is for. Per-rep lines above keep the outliers visible.
			const best = reps.reduce((a, b) => (a.throughput >= b.throughput ? a : b));
			return { ...best, opsPerCore: OPS / Math.max(best.cpu, 1e-9) };
		} finally {
			driver.close();
		}
	};

	if (values.target === 'harper') {
		const ctx = createHarperContext('ycsb-sweep');
		await setupHarperWithFixture(ctx, join(REPO_ROOT, 'benchmarks', 'ycsb', 'app'), {
			harperBinPath: join(REPO_ROOT, 'dist', 'bin', 'harper.js'),
			config: { threads: { count: THREADS }, analytics: { aggregatePeriod: -1 }, logging: { level: 'warn' } },
			// HARPER_NODE_OPTIONS reaches only the server, so a --cpu-prof run does not also
			// profile the driver and its shard workers.
			env: {
				HARPER_STORAGE_ENGINE: 'rocksdb',
				...(process.env.HARPER_NODE_OPTIONS ? { NODE_OPTIONS: process.env.HARPER_NODE_OPTIONS } : {}),
			},
			startupTimeoutMs: 120_000,
		});
		try {
			await waitForRoute(`${ctx.harper.httpURL}/usertable/`, 30_000);
			return await run(ctx.harper.httpURL, { processes: { harper: 'dist/bin/harper.js' }, cgroups: {} });
		} finally {
			await teardownHarper(ctx);
		}
	}

	const stack = await startPgStack({ workers: THREADS, useCache: true, fields: 10, poolSize: 20 });
	try {
		await waitForRoute(`${stack.baseUrl}/usertable/`, 30_000);
		return await run(stack.baseUrl, {
			processes: { fastify: 'pg-app/server.mjs' },
			cgroups: stack.cgroups,
			redisExec: stack.redisExec,
		});
	} finally {
		await stack.stop();
	}
}

async function main(): Promise<void> {
	const base = dataDir();
	await mkdir(join(base, 'harper'), { recursive: true });
	process.env.HARPER_INTEGRATION_TEST_INSTALL_PARENT_DIR = join(base, 'harper');
	statSync(base); // fail fast if the data dir is missing

	console.log(`write-ratio sweep — target=${values.target} records=${RECORDS} ops=${OPS} reps=${REPS}\n`);
	const rows: { ratio: number; throughput: number; cpu: number; opsPerCore: number }[] = [];
	for (const ratio of RATIOS) {
		const result = await measureRatio(ratio);
		rows.push({ ratio, ...result });
		console.log(
			`  updates ${(ratio * 100).toFixed(1).padStart(5)}%  ${result.throughput.toFixed(0).padStart(7)} ops/sec  ` +
				`${result.cpu.toFixed(1).padStart(7)} cpu-s  ${result.opsPerCore.toFixed(0).padStart(6)} ops/core-s`
		);
	}

	console.log('\nknee detection — efficiency relative to the read-only baseline');
	const baseline = rows[0].opsPerCore;
	for (const row of rows) {
		console.log(
			`  ${(row.ratio * 100).toFixed(1).padStart(5)}%  ${(row.opsPerCore / baseline).toFixed(2)}x baseline  ` +
				`(cpu per op ${((1 / row.opsPerCore) * 1e6).toFixed(1)} us)`
		);
	}
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
