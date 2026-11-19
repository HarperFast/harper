/**
 * SQL engine A/B benchmark — new (Resource-API) engine vs legacy (AlaSQL) engine.
 *
 * Addresses PLAN.md phase-5 item 6 ("Performance regression: a subset of the
 * legacy corpus run with timings; budget <= legacy time") and the risk called
 * out in PLAN.md §Risks ("Performance regression on tiny queries" — a streaming
 * pipeline has more per-row overhead than AlaSQL on inputs that already fit in
 * memory).
 *
 * Method
 * ------
 * Engine selection is process-global (HARPER_SQL_ENGINE), so a fair A/B needs
 * TWO instances. Both are booted with identical config, fixture, and seed data,
 * on separate loopback addresses and data roots:
 *
 *   legacy — HARPER_SQL_ENGINE=legacy
 *   new    — HARPER_SQL_ENGINE=new   (NOT `auto`: `new` throws
 *            EngineUnsupportedError instead of silently falling back to legacy,
 *            so a query that the new engine cannot plan is reported as
 *            UNSUPPORTED rather than being timed as legacy-in-disguise. Timing
 *            `auto` would quietly benchmark legacy twice.)
 *
 * Measurements are **interleaved at the iteration level** (legacy, new, legacy,
 * new, ...) rather than run as two separate blocks. Both instances stay up for
 * the whole run and only one is driven at a time. Interleaving matters: a block
 * design attributes any machine drift (thermal, page cache, a background job)
 * entirely to whichever engine ran during it. Alternating means drift lands on
 * both engines and cancels in the ratio.
 *
 * Every query is also checked for **result parity** (row count + a normalized
 * body digest) before its timings are reported. A query that returns different
 * data on the two engines is a correctness signal, and its timing is
 * meaningless — those are reported as MISMATCH and excluded from the summary.
 *
 * Reported per query: p50 / p95 / mean per engine and the new/legacy p50 ratio
 * (<1.0 = new engine faster). The absolute numbers include HTTP + operations-API
 * overhead, which is measured separately and printed as the floor so ratios can
 * be read in context: a query whose engine time is far below the floor will show
 * a ratio near 1.0 regardless of engine cost.
 *
 * Usage (after `npm run build` from the repo root):
 *   node benchmarks/sql-engine/run.mts                  # quick (~2 min)
 *   node benchmarks/sql-engine/run.mts --scale=nightly
 *   node benchmarks/sql-engine/run.mts --records=50000 --iterations=100
 *   node benchmarks/sql-engine/run.mts --filter=join    # only queries whose name matches
 *
 * Result format (parseable by a regression gate):
 *   SQL_ENGINE_RESULT query=pk-lookup legacy_p50_ms=N.NN new_p50_ms=N.NN ratio=N.NN status=ok
 *   SQL_ENGINE_SUMMARY queries=N faster=N slower=N unsupported=N mismatch=N geomean_ratio=N.NN
 */
import { parseArgs } from 'node:util';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import http from 'node:http';
import { createHarperContext, setupHarperWithFixture, teardownHarper } from '@harperfast/integration-testing';

const REPO_ROOT = join(import.meta.dirname, '..', '..');
const HARPER_BIN = join(REPO_ROOT, 'dist', 'bin', 'harper.js');
const APP_DIR = join(import.meta.dirname, 'app');
const OPS_PORT = 9925;
const AUTH = 'Basic ' + Buffer.from('admin:Abc1234!').toString('base64');

const SCALE_PRESETS: Record<string, { records: number; iterations: number; warmup: number }> = {
	quick: { records: 10_000, iterations: 40, warmup: 10 },
	nightly: { records: 200_000, iterations: 200, warmup: 30 },
};

interface CliOptions {
	records: number;
	iterations: number;
	warmup: number;
	engine: string;
	threads: number;
	startupTimeoutMs: number;
	filter?: string;
}

function parseOptions(): CliOptions {
	const { values } = parseArgs({
		args: process.argv.slice(2),
		options: {
			'scale': { type: 'string', default: 'quick' },
			'records': { type: 'string' },
			'iterations': { type: 'string' },
			'warmup': { type: 'string' },
			'engine': { type: 'string', default: 'rocksdb' },
			'threads': { type: 'string', default: '4' },
			'startup-timeout': { type: 'string', default: '120000' },
			'filter': { type: 'string' },
		},
		allowPositionals: false,
	});

	const preset = SCALE_PRESETS[values.scale as string];
	if (!preset) throw new Error(`unknown scale "${values.scale}" (expected: ${Object.keys(SCALE_PRESETS).join(', ')})`);

	return {
		records: values.records ? Number(values.records) : preset.records,
		iterations: values.iterations ? Number(values.iterations) : preset.iterations,
		warmup: values.warmup !== undefined ? Number(values.warmup) : preset.warmup,
		engine: values.engine as string,
		threads: Number(values.threads),
		startupTimeoutMs: Number(values['startup-timeout']),
		filter: values.filter as string | undefined,
	};
}

// ---------------------------------------------------------------------------
// Operations-API client (no-dep, keep-alive, same pattern as ycsb/restClient.mts)
// ---------------------------------------------------------------------------

interface OpsResponse {
	status: number;
	body: unknown;
}

function postOp(agent: http.Agent, hostname: string, op: unknown): Promise<OpsResponse> {
	const payload = Buffer.from(JSON.stringify(op));
	return new Promise((resolve, reject) => {
		const req = http.request(
			{
				hostname,
				port: OPS_PORT,
				path: '/',
				method: 'POST',
				agent,
				headers: {
					'content-type': 'application/json',
					'content-length': String(payload.length),
					'authorization': AUTH,
				},
			},
			(res) => {
				const chunks: Buffer[] = [];
				res.on('data', (c) => chunks.push(c));
				res.on('end', () => {
					const text = Buffer.concat(chunks).toString('utf8');
					let body: unknown = text;
					try {
						body = JSON.parse(text);
					} catch {
						/* leave as text */
					}
					resolve({ status: res.statusCode ?? 0, body });
				});
				res.on('error', reject);
			}
		);
		req.on('error', reject);
		req.setTimeout(120_000, () => req.destroy(new Error('operation timed out')));
		req.write(payload);
		req.end();
	});
}

const sqlOp = (agent: http.Agent, hostname: string, sql: string) => postOp(agent, hostname, { operation: 'sql', sql });

// ---------------------------------------------------------------------------
// Instance lifecycle
// ---------------------------------------------------------------------------

interface Instance {
	name: string;
	ctx: ReturnType<typeof createHarperContext>;
	hostname: string;
	agent: http.Agent;
}

async function boot(name: string, sqlEngine: string, opts: CliOptions): Promise<Instance> {
	const ctx = createHarperContext(`sql-bench-${name}`);
	await setupHarperWithFixture(ctx, APP_DIR, {
		harperBinPath: HARPER_BIN,
		config: {
			threads: { count: opts.threads },
			analytics: { aggregatePeriod: -1 },
			logging: { level: 'warn' },
		},
		env: { HARPER_STORAGE_ENGINE: opts.engine, HARPER_SQL_ENGINE: sqlEngine },
		startupTimeoutMs: opts.startupTimeoutMs,
	});
	const hostname = new URL((ctx as any).harper.httpURL).hostname;
	return { name, ctx, hostname, agent: new http.Agent({ keepAlive: true, maxSockets: 8 }) };
}

/** Seed identical data into an instance. Deterministic — both engines get byte-identical rows. */
async function seed(inst: Instance, records: number): Promise<void> {
	const BATCH = 1_000;
	for (let start = 0; start < records; start += BATCH) {
		const rows = [];
		for (let i = start; i < Math.min(start + BATCH, records); i++) {
			rows.push({
				id: i,
				category: 'cat' + (i % 100),
				region: 'reg' + (i % 50),
				status: i % 7 === 0 ? 'active' : 'idle',
				qty: i % 1000,
				label: 'lbl' + String(i).padStart(8, '0'),
				name: 'name' + String(i).padStart(8, '0'),
				payload: 'p'.repeat(64),
			});
		}
		const res = await postOp(inst.agent, inst.hostname, {
			operation: 'insert',
			database: 'data',
			table: 'sqlbench',
			records: rows,
		});
		if (res.status !== 200)
			throw new Error(`${inst.name}: seed insert failed ${res.status}: ${JSON.stringify(res.body)}`);
	}

	// Join target: ~3 orders per widget over the first 1/10th of the widgets.
	const orderWidgets = Math.max(1, Math.floor(records / 10));
	for (let start = 0; start < orderWidgets * 3; start += BATCH) {
		const rows = [];
		for (let i = start; i < Math.min(start + BATCH, orderWidgets * 3); i++) {
			rows.push({ id: i, widget_id: i % orderWidgets, amt: (i % 50) + 1 });
		}
		const res = await postOp(inst.agent, inst.hostname, {
			operation: 'insert',
			database: 'data',
			table: 'sqlorder',
			records: rows,
		});
		if (res.status !== 200)
			throw new Error(`${inst.name}: seed orders failed ${res.status}: ${JSON.stringify(res.body)}`);
	}
}

// ---------------------------------------------------------------------------
// Query battery
// ---------------------------------------------------------------------------

interface Query {
	name: string;
	sql: string;
	note: string;
}

/** `scale` sizes predicates so selectivity stays comparable across --records. */
function battery(records: number): Query[] {
	const mid = Math.floor(records / 2);
	return [
		// --- tiny result sets: the PLAN.md per-row-overhead risk lives here ---
		{ name: 'pk-lookup', sql: `SELECT * FROM data.sqlbench WHERE id = ${mid}`, note: '1 row via primary key' },
		{ name: 'pk-in-list', sql: `SELECT * FROM data.sqlbench WHERE id IN (1, 2, 3, 4, 5)`, note: '5 rows, IN list' },
		{
			name: 'pk-range-small',
			sql: `SELECT * FROM data.sqlbench WHERE id >= ${mid} AND id < ${mid + 10}`,
			note: '10 rows, PK range',
		},
		{
			// qty=i%1000 and region='reg'+(i%50), so qty must be =7 mod 50 for the
			// two predicates to be satisfiable together (507 % 50 === 7). Picking an
			// inconsistent pair here silently measures an always-empty query.
			name: 'indexed-eq-tiny',
			sql: `SELECT id, name FROM data.sqlbench WHERE region = 'reg7' AND qty = 507`,
			note: 'multi-condition indexed, few rows',
		},

		// --- medium/large result sets: streaming should win here ---
		{
			name: 'indexed-eq-medium',
			sql: `SELECT id, name, qty FROM data.sqlbench WHERE category = 'cat42'`,
			note: `~${Math.round(records / 100)} rows, indexed equality`,
		},
		{
			name: 'pk-range-large',
			sql: `SELECT id, qty FROM data.sqlbench WHERE id >= ${mid} AND id < ${mid + Math.max(100, Math.floor(records / 10))}`,
			note: `~${Math.max(100, Math.floor(records / 10))} rows, PK range`,
		},
		{
			name: 'range-plus-filter',
			sql: `SELECT id, qty FROM data.sqlbench WHERE qty > 900 AND status = 'active'`,
			note: 'indexed range + filter',
		},

		// --- ORDER BY / LIMIT: index-order scan (D-219) vs sort ---
		{
			name: 'orderby-limit-pk',
			sql: `SELECT id, name FROM data.sqlbench ORDER BY id LIMIT 20`,
			note: 'no-WHERE ORDER BY pk LIMIT (index-order scan)',
		},
		{
			name: 'orderby-limit-indexed',
			sql: `SELECT id, qty FROM data.sqlbench WHERE category = 'cat42' ORDER BY qty DESC LIMIT 10`,
			note: 'indexed filter + sort + limit',
		},

		// --- aggregates ---
		{
			name: 'count-star-indexed',
			sql: `SELECT COUNT(*) FROM data.sqlbench WHERE region = 'reg7'`,
			note: 'COUNT over index',
		},
		{
			name: 'group-by',
			sql: `SELECT region, COUNT(*) AS n, AVG(qty) AS avg_qty FROM data.sqlbench WHERE category = 'cat42' GROUP BY region`,
			note: 'GROUP BY + aggregates',
		},
		{
			name: 'distinct',
			sql: `SELECT DISTINCT status FROM data.sqlbench WHERE category = 'cat42'`,
			note: 'DISTINCT over indexed filter',
		},

		// --- joins ---
		{
			name: 'inner-join-small',
			sql: `SELECT w.id, w.name, o.amt FROM data.sqlbench w INNER JOIN data.sqlorder o ON w.id = o.widget_id WHERE w.id = ${Math.floor(records / 20)}`,
			note: 'index nested-loop join, 1 driving row',
		},
		{
			name: 'inner-join-medium',
			sql: `SELECT w.id, o.amt FROM data.sqlbench w INNER JOIN data.sqlorder o ON w.id = o.widget_id WHERE w.category = 'cat42'`,
			note: 'index nested-loop join, ~N driving rows',
		},
		{
			name: 'left-join-small',
			sql: `SELECT w.id, o.amt FROM data.sqlbench w LEFT JOIN data.sqlorder o ON w.id = o.widget_id WHERE w.id >= 1 AND w.id < 20`,
			note: 'LEFT OUTER join with null-fill',
		},

		// --- LIKE ---
		{
			// `label` is @indexed, so a prefix LIKE lowers to an index-served
			// starts_with. Run against the unindexed `name` this is (correctly)
			// EngineUnsupportedError -> legacy fallback, which is the `like-unindexed`
			// case below rather than an engine limitation.
			name: 'like-prefix',
			sql: `SELECT id, name FROM data.sqlbench WHERE label LIKE 'lbl0000001%'`,
			note: 'prefix LIKE on indexed column (starts_with)',
		},
		{
			// Documents the fallback boundary: no index driver, so engine=new rejects
			// and production `auto` would route this to legacy. Expected UNSUPPORTED.
			name: 'like-unindexed',
			sql: `SELECT id, name FROM data.sqlbench WHERE name LIKE 'name0000001%'`,
			note: 'prefix LIKE on UNindexed column (expected fallback to legacy)',
		},
	];
}

// ---------------------------------------------------------------------------
// Measurement
// ---------------------------------------------------------------------------

function percentile(sorted: number[], p: number): number {
	if (sorted.length === 0) return NaN;
	const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
	return sorted[idx];
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

/** Row count + stable digest of the response, for cross-engine parity checking. */
function digest(body: unknown): { rows: number; hash: string } {
	const rows = Array.isArray(body) ? body.length : -1;
	const normalize = (v: unknown): unknown => {
		if (Array.isArray(v)) {
			return [...v]
				.map(normalize)
				.map((x) => JSON.stringify(x))
				.sort();
		}
		if (v && typeof v === 'object') {
			const out: Record<string, unknown> = {};
			for (const k of Object.keys(v as object).sort()) {
				if (k === '__createdtime__' || k === '__updatedtime__' || k === 'txn_time') continue;
				out[k] = normalize((v as Record<string, unknown>)[k]);
			}
			return out;
		}
		// Legacy AlaSQL and the new engine can differ in numeric vs string typing on
		// aggregate outputs; compare loosely so cosmetic typing doesn't read as a
		// data mismatch (a real row difference still changes the digest).
		if (typeof v === 'number') return Number(v.toPrecision(10));
		return v;
	};
	return {
		rows,
		hash: createHash('sha1')
			.update(JSON.stringify(normalize(body)))
			.digest('hex')
			.slice(0, 12),
	};
}

type QueryStatus = 'ok' | 'unsupported' | 'mismatch' | 'error';

interface QueryResult {
	query: Query;
	status: QueryStatus;
	detail?: string;
	rows?: number;
	legacy?: { p50: number; p95: number; mean: number };
	fresh?: { p50: number; p95: number; mean: number };
}

async function timeOne(inst: Instance, sql: string): Promise<{ ms: number; res: OpsResponse }> {
	const t0 = performance.now();
	const res = await sqlOp(inst.agent, inst.hostname, sql);
	return { ms: performance.now() - t0, res };
}

async function measureQuery(legacy: Instance, fresh: Instance, q: Query, opts: CliOptions): Promise<QueryResult> {
	// --- correctness gate: both engines must answer, and answer the same ---
	const [lProbe, nProbe] = [await timeOne(legacy, q.sql), await timeOne(fresh, q.sql)];

	if (nProbe.res.status !== 200) {
		const msg = JSON.stringify(nProbe.res.body);
		// engine=new surfaces EngineUnsupportedError rather than falling back
		const unsupported = /unsupported|cannot plan|EngineUnsupported|full scan/i.test(msg);
		return {
			query: q,
			status: unsupported ? 'unsupported' : 'error',
			detail: `new engine -> ${nProbe.res.status}: ${msg.slice(0, 160)}`,
		};
	}
	if (lProbe.res.status !== 200) {
		return {
			query: q,
			status: 'error',
			detail: `legacy -> ${lProbe.res.status}: ${JSON.stringify(lProbe.res.body).slice(0, 160)}`,
		};
	}

	const lDig = digest(lProbe.res.body);
	const nDig = digest(nProbe.res.body);
	if (lDig.rows !== nDig.rows || lDig.hash !== nDig.hash) {
		return {
			query: q,
			status: 'mismatch',
			detail: `legacy rows=${lDig.rows} hash=${lDig.hash} vs new rows=${nDig.rows} hash=${nDig.hash}`,
			rows: lDig.rows,
		};
	}

	// --- warmup (untimed) ---
	for (let i = 0; i < opts.warmup; i++) {
		await timeOne(legacy, q.sql);
		await timeOne(fresh, q.sql);
	}

	// --- interleaved measurement; alternate which engine leads each iteration ---
	const lTimes: number[] = [];
	const nTimes: number[] = [];
	for (let i = 0; i < opts.iterations; i++) {
		if (i % 2 === 0) {
			lTimes.push((await timeOne(legacy, q.sql)).ms);
			nTimes.push((await timeOne(fresh, q.sql)).ms);
		} else {
			nTimes.push((await timeOne(fresh, q.sql)).ms);
			lTimes.push((await timeOne(legacy, q.sql)).ms);
		}
	}

	const lSorted = [...lTimes].sort((a, b) => a - b);
	const nSorted = [...nTimes].sort((a, b) => a - b);
	return {
		query: q,
		status: 'ok',
		rows: lDig.rows,
		legacy: { p50: percentile(lSorted, 50), p95: percentile(lSorted, 95), mean: mean(lTimes) },
		fresh: { p50: percentile(nSorted, 50), p95: percentile(nSorted, 95), mean: mean(nTimes) },
	};
}

/**
 * Estimate the HTTP + operations-API floor: the cost of a round trip that does
 * essentially no query work. Ratios for queries near this floor are compressed
 * toward 1.0 and should not be read as "the engines are equivalent".
 */
async function measureFloor(inst: Instance, iterations: number): Promise<number> {
	const times: number[] = [];
	for (let i = 0; i < iterations; i++) {
		const t0 = performance.now();
		await postOp(inst.agent, inst.hostname, { operation: 'system_information', attributes: ['version'] });
		times.push(performance.now() - t0);
	}
	return percentile(
		[...times].sort((a, b) => a - b),
		50
	);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
	const opts = parseOptions();
	const queries = battery(opts.records).filter((q) => !opts.filter || q.name.includes(opts.filter));

	console.log('='.repeat(78));
	console.log('SQL engine A/B benchmark — new (Resource API) vs legacy (AlaSQL)');
	console.log('='.repeat(78));
	console.log(`records=${opts.records.toLocaleString()}  iterations=${opts.iterations}  warmup=${opts.warmup}`);
	console.log(`storage=${opts.engine}  threads=${opts.threads}  queries=${queries.length}`);
	console.log('='.repeat(78));

	let legacy: Instance | undefined;
	let fresh: Instance | undefined;
	const results: QueryResult[] = [];
	try {
		console.log('\nBooting legacy instance (HARPER_SQL_ENGINE=legacy)...');
		legacy = await boot('legacy', 'legacy', opts);
		console.log('Booting new instance (HARPER_SQL_ENGINE=new)...');
		fresh = await boot('new', 'new', opts);

		console.log(`\nSeeding ${opts.records.toLocaleString()} records into both instances...`);
		await Promise.all([seed(legacy, opts.records), seed(fresh, opts.records)]);
		console.log('Seed complete.');

		const floor = await measureFloor(legacy, 30);
		console.log(`HTTP + ops-API floor (p50, no query work): ${floor.toFixed(3)} ms\n`);

		console.log(
			'query'.padEnd(22) +
				'rows'.padStart(8) +
				'legacy p50'.padStart(12) +
				'new p50'.padStart(11) +
				'ratio'.padStart(9) +
				'  status'
		);
		console.log('-'.repeat(78));

		for (const q of queries) {
			const r = await measureQuery(legacy, fresh, q, opts);
			results.push(r);
			if (r.status === 'ok') {
				const ratio = r.fresh!.p50 / r.legacy!.p50;
				const verdict = ratio < 0.95 ? 'FASTER' : ratio > 1.05 ? 'SLOWER' : 'even';
				console.log(
					q.name.padEnd(22) +
						String(r.rows).padStart(8) +
						r.legacy!.p50.toFixed(3).padStart(12) +
						r.fresh!.p50.toFixed(3).padStart(11) +
						ratio.toFixed(3).padStart(9) +
						'  ' +
						verdict
				);
			} else {
				console.log(
					q.name.padEnd(22) +
						String(r.rows ?? '-').padStart(8) +
						'-'.padStart(12) +
						'-'.padStart(11) +
						'-'.padStart(9) +
						'  ' +
						r.status.toUpperCase()
				);
			}
		}

		// -------------------------------------------------------------------
		// Report
		// -------------------------------------------------------------------
		console.log('\n' + '='.repeat(78));
		console.log('Detail');
		console.log('='.repeat(78));
		for (const r of results) {
			console.log(`\n${r.query.name} — ${r.query.note}`);
			console.log(`  ${r.query.sql}`);
			if (r.status === 'ok') {
				console.log(
					`  legacy  p50=${r.legacy!.p50.toFixed(3)}ms  p95=${r.legacy!.p95.toFixed(3)}ms  mean=${r.legacy!.mean.toFixed(3)}ms`
				);
				console.log(
					`  new     p50=${r.fresh!.p50.toFixed(3)}ms  p95=${r.fresh!.p95.toFixed(3)}ms  mean=${r.fresh!.mean.toFixed(3)}ms`
				);
			} else {
				console.log(`  ${r.status.toUpperCase()}: ${r.detail}`);
			}
		}

		const ok = results.filter((r) => r.status === 'ok');
		const ratios = ok.map((r) => r.fresh!.p50 / r.legacy!.p50);
		const geomean = ratios.length ? Math.exp(mean(ratios.map(Math.log))) : NaN;

		console.log('\n' + '='.repeat(78));
		console.log('Machine-parseable results');
		console.log('='.repeat(78));
		for (const r of results) {
			if (r.status === 'ok') {
				console.log(
					`SQL_ENGINE_RESULT query=${r.query.name} rows=${r.rows} legacy_p50_ms=${r.legacy!.p50.toFixed(3)} new_p50_ms=${r.fresh!.p50.toFixed(3)} ratio=${(r.fresh!.p50 / r.legacy!.p50).toFixed(3)} status=ok`
				);
			} else {
				console.log(`SQL_ENGINE_RESULT query=${r.query.name} status=${r.status}`);
			}
		}
		console.log(
			`SQL_ENGINE_SUMMARY queries=${results.length} faster=${ratios.filter((x) => x < 0.95).length} slower=${ratios.filter((x) => x > 1.05).length} even=${ratios.filter((x) => x >= 0.95 && x <= 1.05).length} unsupported=${results.filter((r) => r.status === 'unsupported').length} mismatch=${results.filter((r) => r.status === 'mismatch').length} error=${results.filter((r) => r.status === 'error').length} geomean_ratio=${geomean.toFixed(3)}`
		);
	} finally {
		if (legacy) await teardownHarper(legacy.ctx).catch(() => {});
		if (fresh) await teardownHarper(fresh.ctx).catch(() => {});
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
