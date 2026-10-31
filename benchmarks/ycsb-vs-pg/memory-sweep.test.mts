/**
 * Unit tests for the memory sweep's pure pieces and the target descriptors. Run with:
 *   node --test benchmarks/ycsb-vs-pg/
 */
import { test } from 'node:test';
import { deepStrictEqual, strictEqual, throws } from 'node:assert';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordsForRatio, warmupConverged, checkHarperMemory, checkOwnCgroup, parseCells } from './memory-sweep.mts';
import { foreignPids } from './resources.mts';
import { parsePerfStat, frameName, dedupePerfMap } from './perfProfile.mts';
import { parseEventLog, summarizeEvents } from './rocksdbLog.mts';
import { classify, rocksdbPart } from './profile-report.mts';
import { TARGETS, parseTargets, writeJsonAtomic, MEMORY_BUDGET_BYTES } from './run-compare.mts';
import { SWEEP_STACK_MEMORY, WARM_STACK_MEMORY } from './pgStack.mts';

test('dataset ratios size the record count from the logical payload', () => {
	strictEqual(recordsForRatio(0.5, MEMORY_BUDGET_BYTES, 1000), 4_294_967);
	strictEqual(recordsForRatio(2, MEMORY_BUDGET_BYTES, 1000), 17_179_869);
	strictEqual(recordsForRatio(8, MEMORY_BUDGET_BYTES, 1000), 68_719_476);
	for (const bad of [0, -1, NaN, Infinity]) throws(() => recordsForRatio(bad, MEMORY_BUDGET_BYTES, 1000));
	throws(() => recordsForRatio(1e-12, MEMORY_BUDGET_BYTES, 1000), /no records/);
	throws(() => recordsForRatio(0.5, MEMORY_BUDGET_BYTES, 0), /records/);
});

test('warmup converges only when the whole window agrees', () => {
	const chunks = (...throughputs: number[]) => throughputs.map((throughput) => ({ throughput }));
	strictEqual(warmupConverged(chunks(100, 100)), false, 'needs a full window');
	strictEqual(warmupConverged(chunks(50, 100, 101, 102)), true);
	// Each step is within 5% of the last, but the window spans 6%: a drift, not a plateau.
	strictEqual(warmupConverged(chunks(100, 103, 106)), false);
	strictEqual(warmupConverged(chunks(0, 0, 0)), false);
});

test('warmup also waits for the Redis hit rate to settle', () => {
	const settled = [0.8, 0.802, 0.804].map((hitRate) => ({ throughput: 100, hitRate }));
	strictEqual(warmupConverged(settled), true);
	const climbing = [0.8, 0.803, 0.806].map((hitRate) => ({ throughput: 100, hitRate }));
	strictEqual(warmupConverged(climbing), false);
	const partial = [{ throughput: 100 }, { throughput: 100, hitRate: 0.8 }, { throughput: 100, hitRate: 0.8 }];
	strictEqual(warmupConverged(partial), false, 'a window missing a hit rate is not settled');
	const rateless = [{ throughput: 100 }, { throughput: 100 }, { throughput: 100 }];
	strictEqual(warmupConverged(rateless, { requireHitRate: true }), false, 'a Redis target needs hit rates');
	strictEqual(warmupConverged(rateless), true);
});

test('targets carry their HTTP backend and cache sizing', () => {
	const harperFlags = Object.fromEntries(
		Object.entries(TARGETS)
			.filter(([, spec]) => spec.kind === 'harper')
			.map(([name, spec]) => [name, spec.kind === 'harper' && { uws: spec.uws, sized: spec.sized }])
	);
	deepStrictEqual(harperFlags, {
		'harper': { uws: false, sized: false },
		'harper-sized': { uws: false, sized: true },
		'harper-uws': { uws: true, sized: false },
		'harper-uws-sized': { uws: true, sized: true },
		'harper-base': { uws: false, sized: false },
	});
	deepStrictEqual(parseTargets('harper-uws, pg-redis'), ['harper-uws', 'pg-redis']);
	throws(() => parseTargets('harper,uws'), /unknown target "uws"/);
});

test('every stack split sums to the memory budget', () => {
	for (const splits of [WARM_STACK_MEMORY, SWEEP_STACK_MEMORY]) {
		const redis = splits['pg-redis'];
		strictEqual((redis.fastifyMiB + redis.postgresMiB + redis.redisMiB) * 1024 ** 2, MEMORY_BUDGET_BYTES);
		// pg-only's Redis container runs idle and is not charged.
		const pgOnly = splits['pg-only'];
		strictEqual((pgOnly.fastifyMiB + pgOnly.postgresMiB) * 1024 ** 2, MEMORY_BUDGET_BYTES);
	}
});

test('results are replaced atomically, leaving no temp file', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'ycsb-atomic-'));
	try {
		const path = join(dir, 'results.json');
		await writeJsonAtomic(path, { a: 1 });
		await writeJsonAtomic(path, { a: 2 });
		deepStrictEqual(JSON.parse(await readFile(path, 'utf8')), { a: 2 });
		deepStrictEqual(await readdir(dir), ['results.json']);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test('an uncapped Harper needs an explicit opt-in, and the flag never reaches the option parser', () => {
	throws(() => checkHarperMemory(['--harper-memory=measured']), /--allow-uncapped/);
	deepStrictEqual(checkHarperMemory(['--harper-memory=measured', '--allow-uncapped', '--reps=3']), {
		argv: ['--harper-memory=measured', '--reps=3'],
		allowUncapped: true,
	});
	deepStrictEqual(checkHarperMemory(['--reps=3']), { argv: ['--reps=3'], allowUncapped: false });
});

test("the host gate's cgroup must hold only this run, its ancestors and descendants", () => {
	// 1 init -> 10 shell -> 20 harness -> 30 shard -> 40 its child; 11 is a sibling job of the harness
	const parents: Record<number, number> = { 1: 0, 10: 1, 11: 10, 20: 10, 30: 20, 40: 30, 50: 1 };
	const parentOf = (pid: number) => parents[pid];
	deepStrictEqual(foreignPids([10, 11, 20, 30, 40, 50, 99], 20, parentOf), [11, 50]);
	deepStrictEqual(foreignPids([20, 30], 20, parentOf), []);
	throws(() => checkOwnCgroup(['--reps=3'], ['11 (bash)']), /--allow-shared-cgroup/);
	deepStrictEqual(checkOwnCgroup(['--allow-shared-cgroup', '--reps=3'], ['11 (bash)']), {
		argv: ['--reps=3'],
		sharedCgroup: true,
	});
	deepStrictEqual(checkOwnCgroup(['--reps=3'], []), { argv: ['--reps=3'], sharedCgroup: false });
});

test('cells name ratio, workload and target', () => {
	deepStrictEqual(parseCells('0.5:B:harper-uws, 8:B:pg-redis'), [
		{ ratio: 0.5, workload: 'B', target: 'harper-uws' },
		{ ratio: 8, workload: 'B', target: 'pg-redis' },
	]);
	throws(() => parseCells('0.5:B'), /ratio:workload:target/);
	throws(() => parseCells('0.5:Z:harper'), /unknown workload/);
	throws(() => parseCells('0.5:B:redis'), /unknown target/);
});

test('perf stat output is read per cgroup', () => {
	const cg = 'user.slice/app.slice/x.scope';
	const lines = [
		['cpu_core/instructions/u', 1000],
		['cpu_core/instructions/k', 200],
		['cpu_core/cycles/u', 900],
		['cpu_core/cycles/k', 300],
		['context-switches', 5],
		['cpu-migrations', 0],
		['page-faults', 7],
	].map(([event, value]) => `${value},,${event},${cg},1000,100.00,,`);
	deepStrictEqual(parsePerfStat(lines.join('\n')), {
		[cg]: {
			instructionsUser: 1000,
			instructionsKernel: 200,
			cyclesUser: 900,
			cyclesKernel: 300,
			contextSwitches: 5,
			cpuMigrations: 0,
			pageFaults: 7,
		},
	});
	throws(() => parsePerfStat(`<not counted>,,cpu_core/cycles/u,${cg},0,0.00,,`), /could not count/);
});

test('perf script frames keep JS names and native libraries', () => {
	strictEqual(
		frameName('\t    7a7702000d60 JS:*get /app/resources/Table.js:10:3 (/tmp/perf-123.map)'),
		'*get /app/resources/Table.js:10:3'
	);
	strictEqual(
		frameName('\t  dbfd82 v8::internal::Heap::Scavenge()+0x12 (/usr/bin/node)'),
		'v8::internal::Heap::Scavenge() (node)'
	);
	strictEqual(frameName('\t  1234 [unknown] (/x/rocksdb-js.node)'), '[rocksdb-js.node]');
	strictEqual(frameName('\t ffffffff8a2b3c4d [unknown] ([unknown])'), '[kernel]');
});

test('RocksDB event-log lines are placed in the sample phases', () => {
	const at = (ms: number, event: string, extra = '') =>
		`2026/10/30-13:00:00.000000 1 EVENT_LOG_v1 {"time_micros": ${ms * 1000}, "job": 1, "event": "${event}"${extra}}`;
	const log = [
		'2026/10/30-13:00:00.000000 1 [db/db_impl.cc:1] some text',
		at(100, 'flush_started', ', "flush_reason": "Write Buffer Full"'),
		at(110, 'flush_finished'),
		at(200, 'compaction_finished', ', "compaction_time_cpu_micros": 5000, "total_output_size": 1048576'),
		'2026/10/30-13:00:00.000000 1 EVENT_LOG_v1 {"time_micros": 3', // truncated
	].join('\n');
	const events = parseEventLog(log, 'data');
	strictEqual(events.length, 3);
	deepStrictEqual(events[0], {
		db: 'data',
		timeMs: 100,
		event: 'flush_started',
		fields: {},
		reason: 'Write Buffer Full',
	});
	deepStrictEqual(summarizeEvents(events, 150, 250), {
		flushes: 0,
		compactions: 1,
		compactionCpuMs: 5,
		compactionOutputBytes: 1048576,
	});
	strictEqual(summarizeEvents(events, 0, 150).flushes, 1);
});

test('a perf map keeps the newest entry where code was reused', () => {
	const map = [
		'1000 100 JS:*old',
		'2000 10 JS:*kept',
		'1080 40 JS:*new',
		'1000 20 JS:*newest-at-start',
		'3000 8 JS:*x',
	].join('\n');
	strictEqual(
		dedupePerfMap(map),
		['1000 20 JS:*newest-at-start', '1080 40 JS:*new', '2000 10 JS:*kept', '3000 8 JS:*x'].join('\n') + '\n'
	);
});

test('profile stacks go to their innermost recognized frame, GC and JIT to themselves', () => {
	const js = (name: string, path: string) => `*${name} /w/dist/${path}:10:3`;
	const request = ['http', '[uws_linux_x64_147.node]', js('onRequest', 'server/serverHelpers/uwsServer.js')];
	strictEqual(classify([...request, js('authentication', 'security/auth.js'), 'malloc (libc.so.6)'], 'harper'), 'auth');
	strictEqual(classify([...request, 'send (libc.so.6)', '[kernel]'], 'harper'), 'http');
	const get = [
		...request,
		js('getEntry', 'resources/PrimaryRocksDatabase.js'),
		'rocksdb_js::Database::GetSync(napi_env__*) (rocksdb-js.node)',
	];
	strictEqual(classify([...get, 'rocksdb::MemTable::Get() (rocksdb-js.node)'], 'harper'), 'rocksdb');
	strictEqual(rocksdbPart([...get, 'rocksdb::MemTable::Get() (rocksdb-js.node)']), 'memtable');
	strictEqual(
		classify([...get, 'std::mutex::lock() (rocksdb-js.node)'], 'harper'),
		'rocksdb',
		'plumbing defers to its caller'
	);
	strictEqual(classify([...get, 'v8::internal::Scavenger::Process() (node)'], 'harper'), 'gc');
	strictEqual(classify(['redis-server', '[kernel]'], 'redis'), 'redis-server');
	// A socket write under ioredis is the client's; a handler resumed under ioredis's callback writing its response is HTTP's.
	const write = ['node:internal/stream_base_commons writeGeneric', 'uv__write (node)'];
	const ioredis = '*sendCommand /w/pg-app/node_modules/ioredis/built/Redis.js:338:16';
	const reply = '*Reply.send /w/pg-app/node_modules/fastify/lib/reply.js:156:33';
	strictEqual(classify(['node', ioredis, ...write], 'fastify'), 'cache-client');
	strictEqual(classify(['node', ioredis, reply, ...write], 'fastify'), 'http');
});
