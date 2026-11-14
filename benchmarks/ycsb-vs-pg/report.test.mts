/**
 * Unit tests for the reports: profile-report's bucket rules and folded-file lookup, matrix-report's cells. Run with:
 *   node --test benchmarks/ycsb-vs-pg/
 */
import { test } from 'node:test';
import { deepStrictEqual, strictEqual, throws } from 'node:assert';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classify, locatePrefix } from './profile-report.mts';
import { cells, phaseResults } from './gcp/matrix-report.mts';

const APP = '/opt/ycsb/harper/benchmarks/ycsb-vs-pg/pg-app';
const PARSE = [
	'v8::internal::Builtin_JsonParse(int, unsigned long*, v8::internal::Isolate*) (node)',
	'v8::internal::JsonParser<unsigned char>::ParseJson(bool) (node)',
];

test("the stack's JSON.parse of a cached record is record decode; a JWT's is authentication", () => {
	strictEqual(classify([`*'fetchRecord file://${APP}/server.mjs:123:28`, ...PARSE], 'fastify'), 'decode');
	strictEqual(
		classify(
			[`*' file://${APP}/server.mjs:79:28`, `*'decode ${APP}/node_modules/fast-jwt/src/decoder.js:12:16`, ...PARSE],
			'fastify'
		),
		'auth'
	);
	strictEqual(classify([`*'fetchRecord file://${APP}/server.mjs:123:28`], 'fastify'), 'routing');
});

test('folded files copied off the generator are found under the results file', () => {
	const dir = mkdtempSync(join(tmpdir(), 'profile-report-'));
	try {
		mkdirSync(join(dir, 'results', 'profiles', 'stamp'), { recursive: true });
		writeFileSync(join(dir, 'results', 'profiles', 'stamp', 'pg-redis-C-warm-rep1.fastify.folded'), '');
		const remote = '/opt/ycsb/harper/benchmarks/ycsb-vs-pg/results/profiles/stamp/pg-redis-C-warm-rep1';
		strictEqual(
			locatePrefix(remote, join(dir, 'results', 'compare.json'), ['fastify']),
			join(dir, 'results', 'profiles', 'stamp', 'pg-redis-C-warm-rep1')
		);
		throws(() => locatePrefix(remote, join(dir, 'results', 'compare.json'), ['redis']), /no folded files/);
	} finally {
		rmSync(dir, { recursive: true });
	}
});

const sample = (throughput: number, extra: Record<string, unknown> = {}) => ({
	target: 'pg-redis',
	workload: 'C',
	rep: 0,
	...extra,
	measured: {
		cpuMicrosPerOp: 1e6 / throughput,
		perf: { total: { instructionsUser: 200_000 * 1000, instructionsKernel: 50_000 * 1000 } },
		result: { throughput, ops: 1000, errors: 0, latency: { read: { p50: 0.5, p99: 3 } } },
	},
});

test('a cell is its median rep by throughput, with the spread of all reps and what did not settle', () => {
	const [cell] = cells(
		[
			sample(90_000),
			sample(100_000, { status: 'warmup-ceiling', settled: false }),
			sample(80_000),
			{ ...sample(1), measured: undefined } as any,
		],
		'8x'
	);
	strictEqual(cell.opsPerSec, 90_000);
	strictEqual(cell.reps, 3);
	strictEqual(Math.round(cell.spread * 1000), 222);
	strictEqual(cell.instructionsPerOp, 250_000);
	deepStrictEqual([cell.p50, cell.p99, cell.notes], [0.5, 3, ['1/3 warmup-ceiling']]);
});

test("a phase's results file is the one its log names, under the copied results directory", () => {
	const dir = mkdtempSync(join(tmpdir(), 'matrix-report-'));
	try {
		mkdirSync(join(dir, 'logs'));
		mkdirSync(join(dir, 'results'));
		writeFileSync(join(dir, 'results', 'memory-sweep-b.json'), '{}');
		writeFileSync(
			join(dir, 'logs', 'sweep-8x.log'),
			'Results written to /opt/ycsb/harper/benchmarks/ycsb-vs-pg/results/memory-sweep-a.json\n' +
				'Results written to /opt/ycsb/harper/benchmarks/ycsb-vs-pg/results/memory-sweep-b.json\n'
		);
		strictEqual(phaseResults(dir, 'sweep-8x'), join(dir, 'results', 'memory-sweep-b.json'));
		strictEqual(phaseResults(dir, 'warm'), undefined);
	} finally {
		rmSync(dir, { recursive: true });
	}
});
