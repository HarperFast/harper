import assert from 'node:assert';
import test from 'node:test';

import { evaluateGates, parsePositiveIntegerList, summarizeLatencies } from './metrics.mts';

test('summarizes latency distributions without mutating the samples', () => {
	const samples = [100, 1, 10, 5];
	assert.deepStrictEqual(summarizeLatencies(samples), {
		count: 4,
		p50Milliseconds: 5,
		p95Milliseconds: 100,
		p99Milliseconds: 100,
		maxMilliseconds: 100,
	});
	assert.deepStrictEqual(samples, [100, 1, 10, 5]);
});

test('reports every failed architecture gate', () => {
	assert.deepStrictEqual(
		evaluateGates({
			searchP99Milliseconds: 50,
			searchSampleCount: 100,
			eventLoopP99Milliseconds: 20,
			eventLoopSampleCount: 500,
			foregroundP99Milliseconds: 13,
			foregroundSampleCount: 1_000,
			foregroundWindowMilliseconds: 10_000,
			baselineForegroundP99Milliseconds: 10,
			baselineForegroundWindowMilliseconds: 10_000,
			maxSyncMilliseconds: 251,
			syncSampleCount: 1,
			synchronousCommittedEvents: 1,
		}),
		{
			passed: false,
			failures: [
				'search p99 50.000ms is not below 50ms',
				'event-loop p99 20.000ms is not below 20ms',
				'foreground p99 13.000ms exceeds the 20% regression limit 12.000ms',
				'sync max 251.000ms exceeds 250ms',
				'1 committed events re-entered host storage writes',
			],
		}
	);
});

test('accepts values strictly inside every gate', () => {
	assert.deepStrictEqual(
		evaluateGates({
			searchP99Milliseconds: 49.9,
			searchSampleCount: 100,
			eventLoopP99Milliseconds: 19.9,
			eventLoopSampleCount: 500,
			foregroundP99Milliseconds: 12,
			foregroundSampleCount: 1_000,
			foregroundWindowMilliseconds: 10_000,
			baselineForegroundP99Milliseconds: 10,
			baselineForegroundWindowMilliseconds: 10_000,
			maxSyncMilliseconds: 250,
			syncSampleCount: 1,
			synchronousCommittedEvents: 0,
		}),
		{ passed: true, failures: [] }
	);
});

test('fails closed when a gated measurement has too few samples', () => {
	assert.deepStrictEqual(
		evaluateGates({
			searchP99Milliseconds: 1,
			searchSampleCount: 0,
			eventLoopP99Milliseconds: 1,
			eventLoopSampleCount: 0,
			foregroundP99Milliseconds: 1,
			foregroundSampleCount: 0,
			foregroundWindowMilliseconds: 10_000,
			baselineForegroundP99Milliseconds: 1,
			baselineForegroundWindowMilliseconds: 10_000,
			maxSyncMilliseconds: 0,
			syncSampleCount: 0,
		}),
		{
			passed: false,
			failures: [
				'concurrent search has 0 samples; at least 100 are required',
				'event-loop delay has 0 samples; at least 500 are required',
				'foreground writes have 0 samples; at least 1000 are required',
				'host storage reported no sync callbacks',
			],
		}
	);
});

test('fails closed when foreground comparison windows materially differ', () => {
	assert.deepStrictEqual(
		evaluateGates({
			searchP99Milliseconds: 1,
			searchSampleCount: 100,
			eventLoopP99Milliseconds: 1,
			eventLoopSampleCount: 500,
			foregroundP99Milliseconds: 1,
			foregroundSampleCount: 1_000,
			foregroundWindowMilliseconds: 12_001,
			baselineForegroundP99Milliseconds: 1,
			baselineForegroundWindowMilliseconds: 10_000,
			maxSyncMilliseconds: 1,
			syncSampleCount: 1,
			synchronousCommittedEvents: 0,
		}),
		{
			passed: false,
			failures: ['foreground comparison windows differ by more than 20%: 12001ms vs 10000ms baseline'],
		}
	);
});

test('parses and deduplicates positive integer sweeps', () => {
	assert.deepStrictEqual(parsePositiveIntegerList('1,16,1', 'table counts'), [1, 16]);
	assert.throws(() => parsePositiveIntegerList('1,0', 'table counts'), /comma-separated list of positive integers/);
});
