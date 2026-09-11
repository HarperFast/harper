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
			eventLoopP99Milliseconds: 20,
			foregroundP99Milliseconds: 13,
			baselineForegroundP99Milliseconds: 10,
			maxSyncMilliseconds: 251,
			emptyDrainsPerPublication: 2,
		}),
		{
			passed: false,
			failures: [
				'search p99 50.000ms is not below 50ms',
				'event-loop p99 20.000ms is not below 20ms',
				'foreground p99 13.000ms exceeds the 20% regression limit 12.000ms',
				'sync max 251.000ms exceeds 250ms',
				'empty drains per publication 2.000 exceeds 1',
			],
		}
	);
});

test('accepts values strictly inside every gate', () => {
	assert.deepStrictEqual(
		evaluateGates({
			searchP99Milliseconds: 49.9,
			eventLoopP99Milliseconds: 19.9,
			foregroundP99Milliseconds: 12,
			baselineForegroundP99Milliseconds: 10,
			maxSyncMilliseconds: 250,
			emptyDrainsPerPublication: 1,
		}),
		{ passed: true, failures: [] }
	);
});

test('parses and deduplicates positive integer sweeps', () => {
	assert.deepStrictEqual(parsePositiveIntegerList('1,16,1', 'table counts'), [1, 16]);
	assert.throws(() => parsePositiveIntegerList('1,0', 'table counts'), /comma-separated list of positive integers/);
});
