/**
 * Unit tests for the storage-benchmark -> github-action-benchmark converter. Run standalone with:
 *   node --test benchmarks/storage-to-benchmark-json.test.mts
 */
import { test } from 'node:test';
import { strictEqual, deepStrictEqual } from 'node:assert';
import { convert } from './storage-to-benchmark-json.mts';

test('parses indexed-write RESULT lines into per-variant throughput points', () => {
	const indexedWrite = [
		'INDEXED_WRITE_RESULT variant=baseline ops_per_sec=12345',
		'INDEXED_WRITE_RESULT variant=indexed3 ops_per_sec=9800 ratio_vs_baseline=0.794',
		'INDEXED_WRITE_RESULT variant=indexed5 ops_per_sec=8100 ratio_vs_baseline=0.656',
	].join('\n');
	const { throughput } = convert({ indexedWrite });
	deepStrictEqual(throughput, [
		{ name: 'indexed-write baseline', unit: 'ops/sec', value: 12345 },
		{ name: 'indexed-write indexed3', unit: 'ops/sec', value: 9800 },
		{ name: 'indexed-write indexed5', unit: 'ops/sec', value: 8100 },
	]);
});

test('parses ttl-churn RESULT line into an inserts throughput point plus size latency points', () => {
	const ttlChurn =
		'TTL_CHURN_RESULT duration_s=1800 peak_bytes=524288000 final_bytes=419430400 total_inserts=1000000 bounded=true';
	const { throughput, latency } = convert({ ttlChurn });
	deepStrictEqual(throughput, [{ name: 'ttl-churn total inserts', unit: 'records', value: 1000000 }]);
	deepStrictEqual(latency, [
		{ name: 'ttl-churn peak size', unit: 'MB', value: 524.29 },
		{ name: 'ttl-churn final size', unit: 'MB', value: 419.43 },
	]);
});

test('parses concurrent-rw RESULT line into read/write throughput plus read-latency points', () => {
	const concurrentRw =
		'CONCURRENT_RW_RESULT read_ops=54321 write_ops=9876 read_p50_ms=1.2 read_p95_ms=4.5 read_p99_ms=8.9 p99_ceiling_ms=200 ceiling_ok=true';
	const { throughput, latency } = convert({ concurrentRw });
	deepStrictEqual(throughput, [
		{ name: 'concurrent-rw read ops', unit: 'ops', value: 54321 },
		{ name: 'concurrent-rw write ops', unit: 'ops', value: 9876 },
	]);
	deepStrictEqual(latency, [
		{ name: 'concurrent-rw read p50', unit: 'ms', value: 1.2 },
		{ name: 'concurrent-rw read p95', unit: 'ms', value: 4.5 },
		{ name: 'concurrent-rw read p99', unit: 'ms', value: 8.9 },
	]);
});

test('skips a benchmark whose log is absent rather than throwing', () => {
	const { throughput, latency } = convert({ indexedWrite: 'no result lines here' });
	strictEqual(throughput.length, 0);
	strictEqual(latency.length, 0);
});
