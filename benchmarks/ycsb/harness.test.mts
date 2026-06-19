/**
 * Unit tests for the YCSB harness helpers. Run standalone with:
 *   node --test benchmarks/ycsb/
 */
import { test } from 'node:test';
import { strictEqual } from 'node:assert/strict';
import { medianByThroughput } from './harness.mts';
import type { PhaseResult } from './workload.mts';

function rep(throughput: number): PhaseResult {
	// Tag latency so we can assert the WHOLE rep is returned, not a recomputed metric.
	return {
		ops: 0,
		errors: 0,
		elapsedMs: 0,
		throughput,
		latency: {
			read: {
				count: 1,
				min: throughput,
				max: throughput,
				mean: throughput,
				p50: throughput,
				p95: throughput,
				p99: throughput,
				p999: throughput,
			},
		},
	};
}

test('medianByThroughput returns the middle rep and ignores a single degenerate run', () => {
	const chosen = medianByThroughput([rep(100), rep(50), rep(90)]);
	strictEqual(chosen.throughput, 90, 'median of [100,50,90] is 90; the low outlier is never selected');
	// The returned latency comes from that same rep, kept internally consistent.
	strictEqual(chosen.latency.read!.p99, 90);
});

test('medianByThroughput picks the conservative lower-middle for an even count', () => {
	strictEqual(medianByThroughput([rep(80), rep(120)]).throughput, 80);
	strictEqual(medianByThroughput([rep(120), rep(80)]).throughput, 80, 'order-independent');
});

test('medianByThroughput is a no-op for a single rep', () => {
	strictEqual(medianByThroughput([rep(42)]).throughput, 42);
});
