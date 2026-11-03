import { test } from 'node:test';
import assert from 'node:assert';
import { resolve } from 'node:path';
import { parseOptions, cellEnvironment, formatResult } from './fulltext-options.mts';

test('default commands select bounded read-only smoke workloads; nightly explicitly restores larger matrices', () => {
	const http = parseOptions('http', []);
	assert.deepStrictEqual([http.rows, http.clients, http.writes, http.duration], [[1000], [1], [0], 1000]);
	assert.strictEqual(http.cases.length, 5);
	const nightly = parseOptions('http', ['--scale=nightly']);
	assert.deepStrictEqual(
		[nightly.rows, nightly.clients, nightly.writes, nightly.duration],
		[[100000, 1000000], [8, 32], [0, 10], 60000]
	);
	const cell = parseOptions('concurrency', []);
	assert.deepStrictEqual([cell.widths, cell.clients, cell.writes, cell.duration], [[1], [1], [0], 1000]);
	const matrix = parseOptions('concurrency', ['--scale=nightly']);
	assert.strictEqual(matrix.widths.length * matrix.clients.length * matrix.writes.length, 8);
	assert.deepStrictEqual([parseOptions('cost', []).warmups, parseOptions('cost', []).samples], [1, 2]);
	assert.strictEqual(parseOptions('cost', ['--scale=nightly']).samples, 10);
});

test('explicit flags override presets, duration uses seconds and supported boundaries remain available', () => {
	const http = parseOptions('http', [
		'--scale=nightly',
		'--rows=1000',
		'--clients=1',
		'--writes=0',
		'--duration=1',
		'--cases=exact',
		'--expected-workers=1',
		'--output=chosen',
	]);
	assert.deepStrictEqual(
		[http.rows, http.clients, http.writes, http.duration, http.cases, http.expectedWorkers],
		[[1000], [1], [0], 1000, ['exact'], 1]
	);
	assert.strictEqual(http.output, resolve('chosen'));
	assert.deepStrictEqual(parseOptions('http', ['--large', '--rows=20000000', '--duration=300']).rows, [20000000]);
	const cost = parseOptions('cost', ['--samples=1', '--warmups=0']);
	assert.deepStrictEqual([cost.samples, cost.warmups], [1, 0]);
	assert.strictEqual(
		parseOptions('concurrency', ['--relevance-control', '--freshness=bounded-lag']).relevanceControl,
		true
	);
});

test('invalid, empty and unknown inputs fail before workload setup', () => {
	for (const [kind, args] of [
		['http', ['--rows=']],
		['http', ['--rows=999']],
		['http', ['--rows=10000000']],
		['http', ['--large', '--rows=20001000']],
		['http', ['--clients=33']],
		['http', ['--writes=1']],
		['http', ['--clients=1,1']],
		['http', ['--clients=1,01']],
		['http', ['--cases=sort,']],
		['http', ['--cases=nope']],
		['http', ['--duration=0']],
		['http', ['--duration=301']],
		['http', ['--duration=NaN']],
		['http', ['--duration=1.5']],
		['http', ['--expected-workers=3']],
		['http', ['--scale=large']],
		['http', ['--output=']],
		['http', ['--unknown']],
		['concurrency', ['--clients=2']],
		['concurrency', ['--clauses=3']],
		['concurrency', ['--freshness=eventual']],
		['cost', ['--rows=1000']],
		['cost', ['--samples=0']],
		['cost', ['--warmups=-1']],
	])
		assert.throws(() => parseOptions(kind, args), `${kind}: ${args}`);
});

test('help returns without workload configuration or output allocation', () => {
	for (const kind of ['http', 'concurrency', 'cost'])
		assert.deepStrictEqual(parseOptions(kind, ['--help']), { help: true });
});

test('child environment replaces every internal cell setting rather than inheriting stale options', () => {
	const options = parseOptions('concurrency', ['--duration=2', '--freshness=bounded-lag']);
	const cell = { width: 32, concurrency: 4, writes: 10, output: '/new/cell.json' };
	const stale = Object.fromEntries(
		['WIDTH', 'CONCURRENCY', 'WRITES', 'DURATION_MS', 'FRESHNESS', 'CELL_REPORT'].map((key) => [
			`FULLTEXT_QUALIFICATION_${key}`,
			'stale',
		])
	);
	const env = cellEnvironment(options, cell, { ...stale, PATH: '/kept' });
	assert.deepStrictEqual(env, {
		PATH: '/kept',
		FULLTEXT_QUALIFICATION_WIDTH: '32',
		FULLTEXT_QUALIFICATION_CONCURRENCY: '4',
		FULLTEXT_QUALIFICATION_WRITES: '10',
		FULLTEXT_QUALIFICATION_DURATION_MS: '2000',
		FULLTEXT_QUALIFICATION_FRESHNESS: 'bounded-lag',
		FULLTEXT_QUALIFICATION_CELL_REPORT: '/new/cell.json',
	});
});

test('RESULT summaries are single-line parseable and zero completed requests cannot masquerade as fast', () => {
	const line = formatResult('FULLTEXT_HTTP_RESULT', {
		scale: 'quick',
		completed: 0,
		samples: 0,
		p95_ms: 'na',
		verdict: 'unqualified',
	});
	assert.match(line, /^FULLTEXT_HTTP_RESULT(?: [a-z][a-z0-9_]*=[^\s=]+)+$/);
	const fields = Object.fromEntries(
		line
			.split(' ')
			.slice(1)
			.map((entry) => entry.split('='))
	);
	assert.deepStrictEqual(fields, {
		scale: 'quick',
		completed: '0',
		samples: '0',
		p95_ms: 'na',
		verdict: 'unqualified',
	});
	assert.throws(() => formatResult('FULLTEXT_HTTP_RESULT', { p95_ms: NaN }));
	assert.throws(() => formatResult('FULLTEXT_HTTP_RESULT', { case: 'two lines\n' }));
});
