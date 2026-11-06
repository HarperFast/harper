import assert from 'node:assert';
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';

export function parseOptions(kind: 'http' | 'concurrency' | 'cost', args = process.argv.slice(2)) {
	const common = { scale: { type: 'string' }, output: { type: 'string' }, help: { type: 'boolean' } } as const;
	const definitions = {
		http: {
			'rows': { type: 'string' },
			'clients': { type: 'string' },
			'writes': { type: 'string' },
			'cases': { type: 'string' },
			'duration': { type: 'string' },
			'expected-workers': { type: 'string' },
			'large': { type: 'boolean' },
		},
		concurrency: {
			'clauses': { type: 'string' },
			'clients': { type: 'string' },
			'writes': { type: 'string' },
			'duration': { type: 'string' },
			'freshness': { type: 'string' },
			'relevance-control': { type: 'boolean' },
		},
		cost: { warmups: { type: 'string' }, samples: { type: 'string' } },
	} as const;
	const { values } = parseArgs({ args, options: { ...common, ...definitions[kind] }, allowPositionals: false });
	if (values.help) return { help: true };
	const scale = values.scale ?? 'quick';
	assert(['quick', 'nightly'].includes(scale), '--scale must be quick or nightly');
	const quick = scale === 'quick';
	const integer = (name: string, fallback: number, minimum: number, maximum: number) => {
		const raw = values[name];
		assert(raw === undefined || (typeof raw === 'string' && raw.trim() !== ''), `--${name} requires a value`);
		const value = raw === undefined ? fallback : Number(raw);
		assert(Number.isInteger(value) && value >= minimum && value <= maximum, `Invalid --${name}`);
		return value;
	};
	const list = (name: string, fallback: string) => {
		const value = values[name] ?? fallback;
		assert(typeof value === 'string' && value.trim() !== '', `--${name} requires a value`);
		const entries = value.split(',').map((entry) => entry.trim());
		assert(entries.every(Boolean) && new Set(entries).size === entries.length, `Invalid --${name}`);
		return entries;
	};
	const numbers = (name: string, fallback: string, allowed: number[]) => {
		const entries = list(name, fallback).map(Number);
		assert(
			entries.every((entry) => allowed.includes(entry)),
			`Invalid --${name}`
		);
		assert(new Set(entries).size === entries.length, `Duplicate --${name}`);
		return entries;
	};
	assert(
		values.output === undefined || (typeof values.output === 'string' && values.output.trim() !== ''),
		'Invalid --output'
	);
	const output = resolve(values.output ?? resolve(tmpdir(), `harper-fulltext-${kind}-${Date.now()}-${process.pid}`));
	if (kind === 'cost')
		return {
			scale,
			output,
			warmups: integer('warmups', quick ? 1 : 3, 0, 100),
			samples: integer('samples', quick ? 2 : 10, 1, 1000),
		};
	const duration = integer('duration', quick ? 1 : 60, 1, 300) * 1000;
	if (kind === 'concurrency') {
		const freshness = values.freshness ?? 'strict';
		assert(['strict', 'bounded-lag'].includes(freshness), 'Invalid --freshness');
		return {
			scale,
			output,
			duration,
			freshness,
			widths: numbers('clauses', quick ? '1' : '1,32', [1, 32]),
			clients: numbers('clients', quick ? '1' : '1,4', [1, 4]),
			writes: numbers('writes', quick ? '0' : '0,10', [0, 10]),
			relevanceControl: values['relevance-control'] === true,
		};
	}
	const large = values.large === true;
	const rows = list('rows', quick ? '1000' : '100000,1000000').map(Number);
	assert(
		rows.every((n) => Number.isInteger(n) && n >= 1000 && n % 1000 === 0 && n <= (large ? 20000000 : 1000000)),
		'Invalid --rows (large catalogs require --large)'
	);
	assert(new Set(rows).size === rows.length, 'Duplicate --rows');
	const cases = list('cases', 'relevance,sort,highlights,exact,structured');
	assert(
		cases.every((name) => ['relevance', 'sort', 'highlights', 'exact', 'structured'].includes(name)),
		'Invalid --cases'
	);
	return {
		scale,
		output,
		duration,
		rows,
		cases,
		large,
		clients: numbers(
			'clients',
			quick ? '1' : '8,32',
			Array.from({ length: 32 }, (_, i) => i + 1)
		),
		writes: numbers('writes', quick ? '0' : '0,10', [0, 10]),
		expectedWorkers: integer('expected-workers', process.platform === 'darwin' ? 1 : 2, 1, 2),
	};
}

export function printHelp(kind: 'http' | 'concurrency' | 'cost') {
	const flags = {
		http: '--rows=1000 --clients=1 --writes=0 --cases=relevance,sort,highlights,exact,structured --duration=1 --expected-workers=1 --large',
		concurrency: '--clauses=1 --clients=1 --writes=0 --duration=1 --freshness=strict --relevance-control',
		cost: '--warmups=1 --samples=2',
	};
	console.log(
		`Full-text ${kind}: --scale=quick|nightly --output=<new-directory> --help\n${flags[kind]}\nDuration is in seconds. Quick is a smoke workload; nightly enables the larger workload. Reports use a new directory; existing directories are rejected.`
	);
}

export function cellEnvironment(options, cell, ambient = process.env) {
	return {
		...ambient,
		FULLTEXT_QUALIFICATION_WIDTH: String(cell.width),
		FULLTEXT_QUALIFICATION_CONCURRENCY: String(cell.concurrency),
		FULLTEXT_QUALIFICATION_WRITES: String(cell.writes),
		FULLTEXT_QUALIFICATION_DURATION_MS: String(options.duration),
		FULLTEXT_QUALIFICATION_FRESHNESS: options.freshness,
		FULLTEXT_QUALIFICATION_CELL_REPORT: cell.output,
	};
}

export function formatResult(prefix: string, fields: Record<string, string | number | boolean>) {
	assert(/^FULLTEXT_[A-Z_]+_RESULT$/.test(prefix));
	return `${prefix} ${Object.entries(fields)
		.map(([key, value]) => {
			assert(/^[a-z][a-z0-9_]*$/.test(key));
			assert(typeof value !== 'number' || Number.isFinite(value));
			assert(/^[a-zA-Z0-9_.:/+-]+$/.test(String(value)));
			return `${key}=${value}`;
		})
		.join(' ')}`;
}
