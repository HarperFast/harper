/**
 * Unit tests for the memory sweep's pure pieces and the target descriptors. Run with:
 *   node --test benchmarks/ycsb-vs-pg/
 */
import { test } from 'node:test';
import { deepStrictEqual, strictEqual, throws } from 'node:assert';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordsForRatio, warmupConverged } from './memory-sweep.mts';
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
