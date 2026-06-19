/**
 * Unit tests for the YCSB results -> github-action-benchmark converter. Run standalone with:
 *   node --test benchmarks/ycsb/
 */
import { test } from 'node:test';
import { strictEqual, deepStrictEqual } from 'node:assert/strict';
import { convert, type Results } from './to-benchmark-json.mts';

const latency = { read: { p50: 1, p99: 2 } };

test('emits the load series plus per-workload throughput/latency for a normal run', () => {
	const results: Results = {
		load: { throughput: 1000 },
		workloads: [{ name: 'A', throughput: 500, latency }],
	};
	const { throughput, latency: lat } = convert(results);
	deepStrictEqual(
		throughput.map((p) => p.name),
		['load — bulk insert', 'workload A — Update heavy (50% read / 50% update)']
	);
	// Latency tag is the descriptive phrase before the parenthetical op-mix.
	strictEqual(lat[0].name, 'A read p99 — update heavy');
});

test('omits the load series when the load phase is absent (does not throw)', () => {
	const results: Results = {
		workloads: [{ name: 'C', throughput: 700, latency }],
	};
	const { throughput } = convert(results);
	strictEqual(
		throughput.some((p) => p.name.startsWith('load')),
		false,
		'no load series when results.load is undefined'
	);
	strictEqual(throughput[0].name, 'workload C — Read only (100% read)');
});

test('omits a redundant description/tag when the workload has no known description', () => {
	const results: Results = {
		load: { throughput: 10 },
		// Unknown name with no description: must not echo the name as its own description.
		workloads: [{ name: 'FOO', throughput: 5, latency }],
	};
	const { throughput, latency: lat } = convert(results);
	strictEqual(throughput[1].name, 'workload FOO', 'no "workload FOO — FOO" redundancy');
	strictEqual(lat[0].name, 'FOO read p99', 'no redundant "— foo" tag');
});

test('uses a description carried on the result over the WorkloadSpec fallback', () => {
	const results: Results = {
		workloads: [{ name: 'A', description: 'Custom mix (40% read / 60% update)', throughput: 5, latency }],
	};
	const { throughput, latency: lat } = convert(results);
	strictEqual(throughput[0].name, 'workload A — Custom mix (40% read / 60% update)');
	strictEqual(lat[0].name, 'A read p99 — custom mix');
});
