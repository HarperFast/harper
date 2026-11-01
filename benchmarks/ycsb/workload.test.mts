/**
 * Unit tests for the YCSB workload generator (distributions, op-mix selection,
 * key model, latency stats). Run standalone with: node --test benchmarks/ycsb/
 */
import { test } from 'node:test';
import { strictEqual, ok, notStrictEqual, rejects, throws } from 'node:assert';
import {
	WORKLOADS,
	DENY_EVERY,
	assertLinksFit,
	makeKeyChooser,
	formatKey,
	buildRecord,
	linkTarget,
	ownerOf,
	recordReadsPerOp,
	KeyState,
	LatencyRecorder,
	ZipfianGenerator,
	runOperations,
	type OpExecutor,
	type OperationType,
} from './workload.mts';
import { parseLink } from './app/dependentReads.mjs';

function countingExecutor(counts: Record<string, number>): OpExecutor {
	const bump = (k: string) => {
		counts[k] = (counts[k] ?? 0) + 1;
	};
	return {
		async read() {
			bump('read');
		},
		async insert() {
			bump('insert');
		},
		async update() {
			bump('update');
		},
		async readModifyWrite() {
			bump('rmw');
		},
		async scan() {
			bump('scan');
		},
		async inspect(_key, _caller, forbidden) {
			bump(forbidden ? 'inspectForbidden' : 'inspect');
		},
		async chain(_key, hops) {
			bump(`chain-${hops}`);
		},
	};
}

test('formatKey zero-pads to a fixed width', () => {
	strictEqual(formatKey(42, 8), 'user00000042');
	strictEqual(formatKey(0, 4), 'user0000');
});

test('buildRecord produces the requested field count and length', () => {
	const record = buildRecord({ fieldCount: 5, fieldLength: 20 });
	strictEqual(Object.keys(record).length, 5);
	ok('field0' in record && 'field4' in record);
	strictEqual(record.field0.length, 20);
});

test('uniform chooser stays within the keyspace', () => {
	const chooser = makeKeyChooser('uniform');
	for (let i = 0; i < 10000; i++) {
		const v = chooser.next(1000);
		ok(v >= 0 && v < 1000, `out of range: ${v}`);
	}
});

test('raw ZipfianGenerator concentrates mass on low indices', () => {
	// Validates the zeta math directly (no FNV scramble): under Zipf(0.99) the
	// lowest 10% of the value range should absorb a clear majority of draws.
	const n = 1000;
	const gen = new ZipfianGenerator(0, n - 1);
	const samples = 50000;
	let inLowDecile = 0;
	for (let i = 0; i < samples; i++) {
		const v = gen.nextLong(n);
		ok(v >= 0 && v < n, `out of range: ${v}`);
		if (v < n * 0.1) inLowDecile++;
	}
	ok(inLowDecile / samples > 0.55, `expected skew, low decile got ${(inLowDecile / samples).toFixed(2)}`);
});

test('scrambled zipfian chooser is skewed across a realistic keyspace', () => {
	// The scrambled generator draws from a 10^10 universe and hashes into the
	// keyspace, so its skew is only pronounced at realistic sizes (here 100k).
	const chooser = makeKeyChooser('zipfian');
	const keyCount = 100_000;
	const hits = new Map<number, number>();
	const samples = 300_000;
	for (let i = 0; i < samples; i++) {
		const v = chooser.next(keyCount);
		ok(v >= 0 && v < keyCount, `out of range: ${v}`);
		hits.set(v, (hits.get(v) ?? 0) + 1);
	}
	const sorted = [...hits.values()].sort((a, b) => b - a);
	const top10pct = sorted.slice(0, keyCount * 0.1).reduce((a, b) => a + b, 0);
	ok(top10pct / samples > 0.35, `expected skew, top 10% got ${(top10pct / samples).toFixed(2)}`);
});

test('latest chooser is biased toward the newest keys', () => {
	const chooser = makeKeyChooser('latest');
	const keyCount = 100_000;
	let inTopDecile = 0;
	const samples = 300_000;
	for (let i = 0; i < samples; i++) {
		const v = chooser.next(keyCount);
		ok(v >= 0 && v < keyCount, `out of range: ${v}`);
		if (v >= keyCount * 0.9) inTopDecile++;
	}
	ok(inTopDecile / samples > 0.3, `expected recency bias, got ${(inTopDecile / samples).toFixed(2)}`);
});

test('KeyState allocates inserts sequentially and gates reads on acknowledgement', () => {
	const keys = new KeyState({
		distribution: 'uniform',
		initialKeyCount: 100,
		keyWidth: 8,
		shape: { fieldCount: 1, fieldLength: 4 },
		maxScanLength: 10,
	});
	const a = keys.nextInsert();
	const b = keys.nextInsert();
	strictEqual(a.key, formatKey(100, 8));
	strictEqual(b.key, formatKey(101, 8));
	// Out-of-order ack: 101 done first must NOT make index 101 readable past the gap at 100.
	keys.acknowledgeInsert(b.index);
	for (let i = 0; i < 1000; i++) ok(keys.existingKey() < formatKey(101, 8), 'must not expose unacked key');
	keys.acknowledgeInsert(a.index);
	// Now both 100 and 101 are contiguously acknowledged and readable.
	let sawNew = false;
	for (let i = 0; i < 5000; i++) if (keys.existingKey() === formatKey(101, 8)) sawNew = true;
	ok(sawNew, 'acknowledged key should become readable');
});

test('KeyState.keyCount tracks the acknowledged frontier so reps can carry the keyspace forward', () => {
	const keys = new KeyState({
		distribution: 'uniform',
		initialKeyCount: 100,
		keyWidth: 8,
		shape: { fieldCount: 1, fieldLength: 4 },
		maxScanLength: 10,
	});
	strictEqual(keys.keyCount, 100, 'starts at initialKeyCount');
	const a = keys.nextInsert();
	const b = keys.nextInsert();
	strictEqual(keys.keyCount, 100, 'allocation alone does not advance the readable frontier');
	keys.acknowledgeInsert(b.index);
	strictEqual(keys.keyCount, 100, 'a gap at 100 holds the frontier despite 101 being acked');
	keys.acknowledgeInsert(a.index);
	strictEqual(keys.keyCount, 102, 'contiguous acks advance the frontier — next rep seeds from here');
});

test('LatencyRecorder computes ordered percentiles', () => {
	const recorder = new LatencyRecorder();
	for (let i = 1; i <= 1000; i++) recorder.record('read', i);
	const stats = recorder.statsByType().read!;
	strictEqual(stats.count, 1000);
	strictEqual(stats.min, 1);
	strictEqual(stats.max, 1000);
	ok(Math.abs(stats.p50 - 500) <= 1, `p50 ~500, got ${stats.p50}`);
	ok(stats.p99 >= 990, `p99 >=990, got ${stats.p99}`);
});

test('runOperations honors the workload mix within tolerance', async () => {
	const counts: Record<string, number> = {};
	const keys = new KeyState({
		distribution: 'uniform',
		initialKeyCount: 1000,
		keyWidth: 8,
		shape: { fieldCount: 2, fieldLength: 100 },
		maxScanLength: 10,
	});
	const opCount = 20000;
	const result = await runOperations({
		opCount,
		concurrency: 16,
		mix: WORKLOADS.A.mix,
		executor: countingExecutor(counts),
		keys,
	});
	strictEqual(result.ops, opCount);
	strictEqual(result.errors, 0);
	const readFrac = (counts.read ?? 0) / opCount;
	const updateFrac = (counts.update ?? 0) / opCount;
	ok(Math.abs(readFrac - 0.5) < 0.05, `read frac ${readFrac}`);
	ok(Math.abs(updateFrac - 0.5) < 0.05, `update frac ${updateFrac}`);
});

test('every declared workload has a normalized op mix', () => {
	for (const spec of Object.values(WORKLOADS)) {
		const total = Object.values(spec.mix).reduce((a, b) => a + (b ?? 0), 0);
		ok(Math.abs(total - 1) < 1e-9, `${spec.name} mix sums to ${total}`);
		for (const type of Object.keys(spec.mix) as OperationType[]) {
			ok(['read', 'update', 'insert', 'scan', 'rmw', 'inspect', 'chain'].includes(type), `bad op ${type}`);
		}
	}
});

test('links are fixed per key, never point to themselves, and favor the most requested keys', () => {
	const keys = 50_000;
	const linked = new Map<number, number>();
	for (let index = 0; index < keys; index++) {
		const target = linkTarget(index, keys);
		strictEqual(target, linkTarget(index, keys));
		ok(target >= 0 && target < keys && target !== index, `link ${index} -> ${target}`);
		linked.set(target, (linked.get(target) ?? 0) + 1);
	}
	const requested = new Map<number, number>();
	const chooser = makeKeyChooser('zipfian');
	for (let i = 0; i < keys; i++) {
		const index = chooser.next(keys);
		requested.set(index, (requested.get(index) ?? 0) + 1);
	}
	const top = (counts: Map<number, number>, n: number) =>
		[...counts.entries()]
			.sort((a, b) => b[1] - a[1])
			.slice(0, n)
			.map(([index]) => index);
	// Rank 0 of the scrambled zipfian draws ~3.8% (1 / zeta(10^10, 0.99)) in both.
	strictEqual(top(linked, 1)[0], top(requested, 1)[0]);
	const hottestShare = linked.get(top(linked, 1)[0])! / keys;
	ok(hottestShare > 0.03 && hottestShare < 0.047, `hottest key holds ${hottestShare} of links`);
	const shared = top(linked, 20).filter((index) => top(requested, 20).includes(index)).length;
	ok(shared >= 15, `only ${shared} of the 20 most linked keys are among the 20 most requested`);
});

test('every written record carries its own link and owner, padded to the field length', async () => {
	const keyWidth = 10;
	const records = 1000;
	const record = buildRecord({ fieldCount: 2, fieldLength: 100 }, { index: 42, keyCount: records, keyWidth });
	strictEqual(record.field0.length, 100);
	strictEqual(parseLink({ id: 'x', ...record }).next, formatKey(linkTarget(42, records), keyWidth));
	strictEqual(parseLink({ id: 'x', ...record }).owner, 'owner02');
	const short = buildRecord({ fieldCount: 1, fieldLength: 10 }, { index: 0, keyCount: records, keyWidth });
	strictEqual(short.field0.length, 10);
	throws(() => parseLink({ id: 'x', ...short }), { statusCode: 500 }, 'a field too short for the link gets none');
	assertLinksFit(['C', 'B'], { fieldCount: 1, fieldLength: 10 }, keyWidth);
	throws(() => assertLinksFit(['C', 'chain-4'], { fieldCount: 1, fieldLength: 22 }, keyWidth), /chain-4 need/);
	assertLinksFit(['inspect'], { fieldCount: 1, fieldLength: 23 }, keyWidth);

	const writes: [string, Record<string, string>][] = [];
	const capture = (key: string, value: Record<string, string>) => {
		writes.push([key, value]);
		return Promise.resolve();
	};
	const keys = new KeyState({
		distribution: 'zipfian',
		initialKeyCount: records,
		keyWidth,
		shape: { fieldCount: 2, fieldLength: 100 },
		maxScanLength: 10,
	});
	await runOperations({
		opCount: 300,
		concurrency: 4,
		mix: { update: 0.5, rmw: 0.5 },
		executor: { ...countingExecutor({}), update: capture, readModifyWrite: capture },
		keys,
	});
	strictEqual(writes.length, 300);
	for (const [key, value] of writes) {
		const index = Number(key.slice(4));
		const link = parseLink({ id: key, ...value });
		strictEqual(link.next, formatKey(linkTarget(index, records), keyWidth));
		strictEqual(link.owner, ownerOf(index));
	}
	notStrictEqual(keys.record(7).field0, keys.record(7).field0, 'padding is fresh on every write');
});

test('inspect sends one request in DENY_EVERY as another owner; chain-N sends N hops', async () => {
	const calls: { key: string; caller: string; forbidden: boolean }[] = [];
	const counts: Record<string, number> = {};
	const keys = new KeyState({
		distribution: 'zipfian',
		initialKeyCount: 1000,
		keyWidth: 10,
		shape: { fieldCount: 2, fieldLength: 100 },
		maxScanLength: 10,
	});
	await runOperations({
		opCount: 400,
		concurrency: 4,
		mix: WORKLOADS.inspect.mix,
		executor: {
			...countingExecutor(counts),
			async inspect(key, caller, forbidden) {
				calls.push({ key, caller, forbidden });
			},
		},
		keys,
	});
	strictEqual(calls.filter((c) => c.forbidden).length, 400 / DENY_EVERY);
	for (const { key, caller, forbidden } of calls) {
		strictEqual(caller === ownerOf(Number(key.slice(4))), !forbidden, `${key} by ${caller}`);
	}

	for (const hops of [1, 2, 4]) {
		const spec = WORKLOADS[`chain-${hops}`];
		strictEqual(recordReadsPerOp(spec), hops + 1);
		await runOperations({
			opCount: 50,
			concurrency: 4,
			mix: spec.mix,
			chainHops: spec.chainHops,
			executor: countingExecutor(counts),
			keys,
		});
		strictEqual(counts[`chain-${hops}`], 50);
	}
	await rejects(
		runOperations({ opCount: 1, concurrency: 1, mix: { chain: 1 }, executor: countingExecutor(counts), keys }),
		/chainHops/
	);
});
