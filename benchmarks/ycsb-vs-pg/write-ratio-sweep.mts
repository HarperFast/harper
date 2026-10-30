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
import { startDriver } from './shardedDriver.mts';
import { startPgStack, dataDir, WARM_STACK_MEMORY } from './pgStack.mts';
import {
	sampleResources,
	diffResources,
	ClockProbe,
	parseCpuList,
	readTopology,
	chooseCpuSets,
	assertDisjointCores,
	pinPid,
	writePinnedRuntime,
	verifyAffinity,
	type ResourceTargets,
} from './resources.mts';
import { mkdir } from 'node:fs/promises';
import { statSync } from 'node:fs';

const REPO_ROOT = join(import.meta.dirname, '..', '..');

const { values } = parseArgs({
	options: {
		'target': { type: 'string', default: 'harper' },
		'ratios': { type: 'string', default: '0,0.005,0.01,0.02,0.05,0.1,0.25,0.5' },
		'records': { type: 'string', default: '200000' },
		'ops': { type: 'string', default: '300000' },
		'concurrency': { type: 'string', default: '128' },
		'shards': { type: 'string', default: '6' },
		'reps': { type: 'string', default: '2' },
		// Same placement rules as run-compare.mts: K target cores, generator on disjoint cores.
		'target-cpus': { type: 'string', default: '4' },
		'serverCpus': { type: 'string' },
		'driverCpus': { type: 'string' },
	},
});

const topology = readTopology();
const { server: SERVER_CPUS, driver: DRIVER_CPUS } =
	values.serverCpus && values.driverCpus
		? { server: parseCpuList(values.serverCpus), driver: parseCpuList(values.driverCpus) }
		: chooseCpuSets(topology, Number(values['target-cpus']));
assertDisjointCores(topology, SERVER_CPUS, DRIVER_CPUS);

const RECORDS = Number(values.records);
const OPS = Number(values.ops);
const CONCURRENCY = Number(values.concurrency);
const THREADS = SERVER_CPUS.length;
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
	const mix: Record<string, number> = ratio === 0 ? { read: 1 } : { read: 1 - ratio, update: ratio };
	const run = async (baseUrl: string, targets: ResourceTargets) => {
		for (const [name, pid] of Object.entries(targets.processes)) verifyAffinity(name, pid, SERVER_CPUS);
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
			await driver.runWorkload('C', 'uniform', RECORDS * 2);
			const reps: { throughput: number; cpu: number }[] = [];
			for (let rep = 0; rep < REPS; rep++) {
				const clock = new ClockProbe(SERVER_CPUS);
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
		const { createHarperContext, setupHarperWithFixture, teardownHarper } =
			await import('@harperfast/integration-testing');
		const ctx = createHarperContext('ycsb-sweep');
		const started = await setupHarperWithFixture(ctx, join(REPO_ROOT, 'benchmarks', 'ycsb', 'app'), {
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
			await waitForRoute(`${started.harper.httpURL}/usertable/`, 30_000);
			const pid = (started.harper as unknown as { process: { pid: number } }).process.pid;
			return await run(started.harper.httpURL, { processes: { harper: pid }, cgroups: {} });
		} finally {
			await teardownHarper(started);
		}
	}

	const stack = await startPgStack({
		workers: THREADS,
		useCache: true,
		fields: 10,
		poolSize: 20,
		serverCpus: SERVER_CPUS,
		memory: WARM_STACK_MEMORY,
		fastifyUnit: `ycsb-ratio-sweep-${process.pid}-${ratio}`.replace('.', '_'),
	});
	try {
		await waitForRoute(`${stack.baseUrl}/usertable/`, 30_000);
		return await run(stack.baseUrl, {
			processes: { fastify: stack.appPid },
			cgroups: { postgres: stack.cgroups.postgres, redis: stack.cgroups.redis },
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
	await pinPid(process.pid, DRIVER_CPUS);
	process.env.HARPER_RUNTIME = await writePinnedRuntime(join(import.meta.dirname, 'results'), SERVER_CPUS);

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
