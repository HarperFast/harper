/**
 * QA-promoted regression anchor — promoted from QA-647 (P-432), a gated qa-explorer finding.
 * Originating QA scenario: QA-647 (source: gh#1865).
 * Coverage anchored: restart + attribute-adding schema change never makes existing rows
 * invisible on any read surface (6-surface matrix, two restarts).
 *
 * Upgrade-boot read visibility across every read surface.
 *
 * #1865 reports that pre-restart rows in COMPONENT tables can go missing on some read surfaces
 * after an in-place upgrade boot (same dataRootDir, process restarts, config may be backfilled),
 * while other surfaces still see them. This probe writes rows into a component table, restarts
 * the CURRENT build over the SAME dataRootDir (simulating the in-place upgrade), and re-reads
 * those rows through every distinct read surface:
 *   - cached point-GET   : in-process Resource `table.get(id)` (/PointGet/)
 *   - uncached scan       : index-INDEPENDENT full base-store scan (/ScanAll/) — the ORACLE,
 *                           since a cached/indexed surface must never judge itself
 *   - ops search_by_value : secondary-index bulk scan via the legacy ops API (search_by_value)
 *   - SQL                 : `operation: 'sql'`
 *   - REST                : `GET /Widget/<id>`
 *   - ops search_by_id    : legacy ops API primary-key point lookup
 *
 * Also probes:
 *   - write-then-read heal: does re-putting a missed row's known original fields repair the
 *     cached point-GET surface? (/Touch/)
 *   - boot-order dependence: does a SECOND restart (no further config change) clear a miss seen
 *     after the first restart, or is the miss stable/growing?
 *   - config change across the boot: between restart #1's kill and start, the on-disk
 *     schema.graphql is overwritten to ADD a table attribute (`category`) to the SAME component,
 *     matching #1865's report that this reproduces on component tables specifically.
 *
 * Every "restart" reuses setupHarperWithFixture/startHarper's own dataRootDir + hostname
 * (ctx.harper is never reset), and re-passes the EXACT same `config` object used on the initial
 * boot on every subsequent startHarper call — omitting it on a restart wipes config and would
 * invalidate the experiment (per the investigation brief for this suite).
 *
 * Per eviction-secondary-index.test.ts's pattern: readiness after a restart is confirmed by
 * polling a real route directly until it stops 404-ing — restartHttpWorkers() is NOT used here,
 * since it races against a pre-installed fixture and flakes on CI.
 *
 * Harper SHA under test: 1e1edc666 (main).
 * Repro: timeout 900 npm run test:integration -- "integrationTests/upgrade/upgrade-boot-schema-change.test.ts"
 */
import { suite, test, before, after } from 'node:test';
import { ok, strictEqual, deepStrictEqual } from 'node:assert';
import { resolve, join, basename } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import {
	startHarper,
	setupHarperWithFixture,
	killHarper,
	teardownHarper,
	sendOperation,
	type ContextWithHarper,
} from '@harperfast/integration-testing';
// @ts-expect-error utils/client.mjs has no type declarations; runtime resolves fine
import { createApiClient } from '../apiTests/utils/client.mjs';

const FIXTURE_PATH = resolve(import.meta.dirname, 'upgrade-boot-schema-change');
const COMPONENT_DIR_NAME = basename(FIXTURE_PATH);
const DB = 'qa647';
const TABLE = 'Widget';
const ROW_COUNT = 24;
const BATCH = 'waveA';
const skipSuite = process.platform === 'win32';

// Passed verbatim to setupHarperWithFixture AND to every subsequent startHarper call across every
// restart in this suite — never omitted, so a restart never silently wipes config.
const BOOT_CONFIG = { logging: { console: true, level: 'error' } };

// v2 schema written to disk between restart #1's kill and start: adds a table attribute
// (`category`) to the SAME component, on the SAME dataRootDir, simulating a config/schema change
// riding along with an in-place upgrade boot.
const SCHEMA_V2 = `# QA-647 v2 — category attribute added across restart #1's boot.
type Widget @table(database: "qa647") @export {
	id: ID @primaryKey
	sku: String @indexed
	batch: String @indexed
	name: String
	category: String @indexed
}
`;

interface Row {
	id: string;
	sku: string;
	batch: string;
	name: string;
}

interface SurfaceMatrix {
	label: string;
	oracleIds: Set<string>;
	opsScanIds: Set<string>;
	cachedGetHits: string[];
	cachedGetMisses: string[];
	restHits: string[];
	restMisses: string[];
	opsByIdHits: string[];
	opsByIdMisses: string[];
	sqlHits: string[];
	sqlMisses: string[];
}

suite('QA-647 upgrade-boot read visibility across surfaces (#1865)', { skip: skipSuite }, (ctx: ContextWithHarper) => {
	let client: ReturnType<typeof createApiClient>;
	let httpURL: string;
	let rows: Row[] = [];
	const findings: string[] = [];
	function log(line: string) {
		findings.push(line);
		console.log(`[QA-647] ${line}`);
	}

	function get(path: string): Promise<Response> {
		return fetch(`${httpURL}${path}`, { headers: { Authorization: client.headers.Authorization } });
	}
	function post(path: string, body: unknown): Promise<Response> {
		return fetch(`${httpURL}${path}`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', 'Authorization': client.headers.Authorization },
			body: JSON.stringify(body),
		});
	}

	async function pollReady(path: string, maxWaitMs = 60_000): Promise<void> {
		const deadline = Date.now() + maxWaitMs;
		while (Date.now() < deadline) {
			try {
				const r = await get(path);
				if (r.status !== 404) return;
			} catch {
				/* not up yet */
			}
			await sleep(250);
		}
		throw new Error(`route ${path} still 404 after ${maxWaitMs}ms`);
	}

	async function oracleScan(batch: string): Promise<Set<string>> {
		const r = await get(`/ScanAll/?batch=${batch}`);
		strictEqual(r.status, 200, `/ScanAll/ should return 200, got ${r.status}`);
		const body = (await r.json()) as { ids: string[] };
		return new Set(body.ids);
	}

	async function opsScan(batch: string): Promise<Set<string>> {
		const res = await sendOperation(ctx.harper, {
			operation: 'search_by_value',
			schema: DB,
			table: TABLE,
			search_attribute: 'batch',
			search_value: batch,
			get_attributes: ['id'],
		});
		return new Set((res as Array<{ id: string }>).map((r) => r.id));
	}

	async function cachedGet(id: string): Promise<boolean> {
		const r = await get(`/PointGet/?id=${id}`);
		if (r.status !== 200) return false;
		const body = (await r.json()) as { found: boolean };
		return body.found;
	}

	async function restGet(id: string): Promise<boolean> {
		const r = await get(`/Widget/${id}`);
		return r.status === 200;
	}

	async function opsById(id: string): Promise<boolean> {
		const res = await sendOperation(ctx.harper, {
			operation: 'search_by_id',
			schema: DB,
			table: TABLE,
			ids: [id],
			get_attributes: ['id'],
		});
		return Array.isArray(res) && res.length === 1;
	}

	async function sqlById(id: string): Promise<boolean> {
		const res = await sendOperation(ctx.harper, {
			operation: 'sql',
			sql: `SELECT id FROM ${DB}.${TABLE} WHERE id = '${id}'`,
		});
		return Array.isArray(res) && res.length === 1;
	}

	/** Build the full per-surface visibility matrix for `rows` against a live instance. */
	async function buildMatrix(label: string): Promise<SurfaceMatrix> {
		const oracleIds = await oracleScan(BATCH);
		const opsScanIds = await opsScan(BATCH);
		const m: SurfaceMatrix = {
			label,
			oracleIds,
			opsScanIds,
			cachedGetHits: [],
			cachedGetMisses: [],
			restHits: [],
			restMisses: [],
			opsByIdHits: [],
			opsByIdMisses: [],
			sqlHits: [],
			sqlMisses: [],
		};
		for (const row of rows) {
			(await cachedGet(row.id)) ? m.cachedGetHits.push(row.id) : m.cachedGetMisses.push(row.id);
			(await restGet(row.id)) ? m.restHits.push(row.id) : m.restMisses.push(row.id);
			(await opsById(row.id)) ? m.opsByIdHits.push(row.id) : m.opsByIdMisses.push(row.id);
			(await sqlById(row.id)) ? m.sqlHits.push(row.id) : m.sqlMisses.push(row.id);
		}
		log(
			`${label}: oracle(scan)=${oracleIds.size}/${rows.length} opsScan=${opsScanIds.size}/${rows.length} ` +
				`cachedGET=${m.cachedGetHits.length}/${rows.length} REST=${m.restHits.length}/${rows.length} ` +
				`opsById=${m.opsByIdHits.length}/${rows.length} SQL=${m.sqlHits.length}/${rows.length}`
		);
		if (m.cachedGetMisses.length) log(`${label}: cachedGET MISSES: ${m.cachedGetMisses.join(',')}`);
		if (m.restMisses.length) log(`${label}: REST MISSES: ${m.restMisses.join(',')}`);
		if (m.opsByIdMisses.length) log(`${label}: opsById MISSES: ${m.opsByIdMisses.join(',')}`);
		if (m.sqlMisses.length) log(`${label}: SQL MISSES: ${m.sqlMisses.join(',')}`);
		return m;
	}

	async function refreshClient() {
		client = createApiClient(ctx.harper);
		httpURL = ctx.harper.httpURL;
	}

	let matrixBaseline: SurfaceMatrix;
	let matrixAfterRestart1: SurfaceMatrix;
	let matrixAfterHeal: SurfaceMatrix | null = null;
	let matrixAfterRestart2: SurfaceMatrix;

	before(async () => {
		await setupHarperWithFixture(ctx, FIXTURE_PATH, { config: BOOT_CONFIG, env: {} });
		await refreshClient();
		await pollReady('/ScanAll/');
		log(`cold boot complete at ${httpURL}, dataRootDir=${ctx.harper.dataRootDir}`);

		const loadRes = await post('/Load/', { count: ROW_COUNT, batch: BATCH });
		strictEqual(loadRes.status, 200, 'Load should return 200');
		const loadBody = (await loadRes.json()) as { ids: string[] };
		rows = loadBody.ids.map((id, i) => ({ id, sku: `SKU-${BATCH}-${i}`, batch: BATCH, name: `Widget ${BATCH} ${i}` }));
		log(`loaded ${rows.length} rows (batch=${BATCH})`);
	});

	after(async () => {
		await teardownHarper(ctx);
		log('--- FINDINGS SUMMARY ---');
		for (const line of findings) console.log(`[QA-647][summary] ${line}`);
	});

	test('Q0 PRE-RESTART baseline: every surface sees every row (precondition)', { timeout: 60_000 }, async () => {
		matrixBaseline = await buildMatrix('PRE-RESTART');
		strictEqual(matrixBaseline.oracleIds.size, ROW_COUNT, 'PRECONDITION: oracle scan must see all rows pre-restart');
		strictEqual(
			matrixBaseline.opsScanIds.size,
			ROW_COUNT,
			'PRECONDITION: ops search_by_value scan must see all rows pre-restart'
		);
		strictEqual(
			matrixBaseline.cachedGetHits.length,
			ROW_COUNT,
			'PRECONDITION: cached point-GET must hit every row pre-restart'
		);
		strictEqual(matrixBaseline.restHits.length, ROW_COUNT, 'PRECONDITION: REST must hit every row pre-restart');
		strictEqual(
			matrixBaseline.opsByIdHits.length,
			ROW_COUNT,
			'PRECONDITION: ops search_by_id must hit every row pre-restart'
		);
		strictEqual(matrixBaseline.sqlHits.length, ROW_COUNT, 'PRECONDITION: SQL must hit every row pre-restart');
	});

	test(
		'Q1 RESTART #1 (+ config change: schema gains a table attribute across the boot)',
		{ timeout: 90_000 },
		async () => {
			// Config change across the boot: mutate the on-disk component schema (adds `category`)
			// while Harper is down, same dataRootDir, same component directory.
			const schemaPath = join(ctx.harper.dataRootDir, 'components', COMPONENT_DIR_NAME, 'schema.graphql');
			await writeFile(schemaPath, SCHEMA_V2, 'utf8');
			log(`rewrote ${schemaPath} to v2 (adds category:String @indexed) while Harper is down`);

			await killHarper(ctx);
			log('killed Harper cleanly (SIGTERM)');

			// Critical: re-pass the SAME config object used on the initial boot.
			await startHarper(ctx, { config: BOOT_CONFIG, env: {} });
			await refreshClient();
			await pollReady('/ScanAll/');
			log(`restart #1 (upgrade-boot simulation) complete at ${httpURL}`);

			matrixAfterRestart1 = await buildMatrix('POST-RESTART-1');

			// Oracle must hold regardless of what any other surface reports — if this fails, rows
			// were actually lost (a much larger problem than a read-visibility miss), and everything
			// below is moot.
			strictEqual(
				matrixAfterRestart1.oracleIds.size,
				ROW_COUNT,
				`ORACLE: uncached index-independent full scan must still see all ${ROW_COUNT} rows after the upgrade-boot restart (proves data is on disk)`
			);
			deepStrictEqual(
				[...matrixAfterRestart1.oracleIds].sort(),
				rows.map((r) => r.id).sort(),
				'ORACLE: post-restart scan id set must exactly match the pre-restart row set'
			);
		}
	);

	test('Q2 POST-RESTART-1: does the cached point-GET / SQL / REST / ops surface miss what the oracle sees?', () => {
		const m = matrixAfterRestart1;
		strictEqual(
			m.opsScanIds.size,
			ROW_COUNT,
			`[#1865 CHECK] ops search_by_value(batch) scan expected ${ROW_COUNT}, got ${m.opsScanIds.size} — secondary-index scan miss`
		);
		strictEqual(
			m.cachedGetHits.length,
			ROW_COUNT,
			`[#1865 CHECK] cached point-GET expected ${ROW_COUNT} hits, got ${m.cachedGetHits.length} (misses: ${m.cachedGetMisses.join(',')})`
		);
		strictEqual(
			m.restHits.length,
			ROW_COUNT,
			`[#1865 CHECK] REST GET /Widget/<id> expected ${ROW_COUNT} hits, got ${m.restHits.length} (misses: ${m.restMisses.join(',')})`
		);
		strictEqual(
			m.opsByIdHits.length,
			ROW_COUNT,
			`[#1865 CHECK] ops search_by_id expected ${ROW_COUNT} hits, got ${m.opsByIdHits.length} (misses: ${m.opsByIdMisses.join(',')})`
		);
		strictEqual(
			m.sqlHits.length,
			ROW_COUNT,
			`[#1865 CHECK] SQL expected ${ROW_COUNT} hits, got ${m.sqlHits.length} (misses: ${m.sqlMisses.join(',')})`
		);
	});

	test('Q3 write-then-read heal: does re-putting a missed row repair it?', { timeout: 30_000 }, async (t) => {
		const anyMisses =
			matrixAfterRestart1.cachedGetMisses.length ||
			matrixAfterRestart1.restMisses.length ||
			matrixAfterRestart1.opsByIdMisses.length ||
			matrixAfterRestart1.sqlMisses.length;
		if (!anyMisses) {
			t.skip('no miss observed after restart #1 on any point surface — nothing to heal');
			return;
		}
		// Prefer a row missed on cached point-GET (the surface #1865 names); fall back to any miss.
		const targetId =
			matrixAfterRestart1.cachedGetMisses[0] ??
			matrixAfterRestart1.restMisses[0] ??
			matrixAfterRestart1.opsByIdMisses[0] ??
			matrixAfterRestart1.sqlMisses[0];
		const row = rows.find((r) => r.id === targetId)!;
		log(`Q3: healing probe targets ${targetId} (missed pre-heal)`);

		const beforeHeal = await cachedGet(targetId);
		const r = await post('/Touch/', row);
		strictEqual(r.status, 200, 'Touch should return 200');
		const touchBody = (await r.json()) as { foundAfterTouch: boolean };
		const afterHeal = await cachedGet(targetId);
		log(
			`Q3: ${targetId} cachedGET before-write=${beforeHeal}, Touch.foundAfterTouch=${touchBody.foundAfterTouch}, ` +
				`cachedGET after-write=${afterHeal} -> ${afterHeal ? 'WRITE HEALS the miss' : 'STILL MISSING after the write'}`
		);
		matrixAfterHeal = await buildMatrix('POST-HEAL');
		ok(true, `heal probe recorded (before=${beforeHeal}, after=${afterHeal})`);
	});

	test(
		'Q4 RESTART #2 (no further config change): is the miss stable, cleared, or does it grow?',
		{ timeout: 90_000 },
		async () => {
			await killHarper(ctx);
			log('killed Harper cleanly (SIGTERM) for restart #2');

			// Same config again — no further schema mutation this time (isolates "does a SECOND boot
			// alone change anything" from "does another config change").
			await startHarper(ctx, { config: BOOT_CONFIG, env: {} });
			await refreshClient();
			await pollReady('/ScanAll/');
			log(`restart #2 complete at ${httpURL}`);

			matrixAfterRestart2 = await buildMatrix('POST-RESTART-2');

			strictEqual(
				matrixAfterRestart2.oracleIds.size,
				ROW_COUNT,
				`ORACLE: uncached full scan must still see all ${ROW_COUNT} rows after the SECOND restart`
			);

			const cmp = (a: string[], b: string[], name: string) => {
				log(
					`Q4 boot-order check (${name}): restart#1 misses=${b.length}, ` +
						`restart#2 misses=${a.length} -> ${
							a.length === 0 && b.length > 0
								? 'CLEARED on 2nd boot (order-dependent)'
								: a.length > 0 && b.length === 0
									? 'NEW MISS introduced by 2nd boot alone'
									: a.length === b.length
										? 'UNCHANGED across boots (stable)'
										: 'CHANGED (different miss set/count)'
						}`
				);
			};
			cmp(matrixAfterRestart2.cachedGetMisses, matrixAfterRestart1.cachedGetMisses, 'cachedGetMisses');
			cmp(matrixAfterRestart2.restMisses, matrixAfterRestart1.restMisses, 'restMisses');
			cmp(matrixAfterRestart2.opsByIdMisses, matrixAfterRestart1.opsByIdMisses, 'opsByIdMisses');
			cmp(matrixAfterRestart2.sqlMisses, matrixAfterRestart1.sqlMisses, 'sqlMisses');

			log(
				`FINAL VISIBILITY MATRIX SUMMARY:\n` +
					`  PRE-RESTART      : oracle=${matrixBaseline.oracleIds.size}/${ROW_COUNT} opsScan=${matrixBaseline.opsScanIds.size}/${ROW_COUNT} ` +
					`cachedGET=${matrixBaseline.cachedGetHits.length}/${ROW_COUNT} REST=${matrixBaseline.restHits.length}/${ROW_COUNT} ` +
					`opsById=${matrixBaseline.opsByIdHits.length}/${ROW_COUNT} SQL=${matrixBaseline.sqlHits.length}/${ROW_COUNT}\n` +
					`  POST-RESTART-1    : oracle=${matrixAfterRestart1.oracleIds.size}/${ROW_COUNT} opsScan=${matrixAfterRestart1.opsScanIds.size}/${ROW_COUNT} ` +
					`cachedGET=${matrixAfterRestart1.cachedGetHits.length}/${ROW_COUNT} REST=${matrixAfterRestart1.restHits.length}/${ROW_COUNT} ` +
					`opsById=${matrixAfterRestart1.opsByIdHits.length}/${ROW_COUNT} SQL=${matrixAfterRestart1.sqlHits.length}/${ROW_COUNT}\n` +
					(matrixAfterHeal
						? `  POST-HEAL         : oracle=${matrixAfterHeal.oracleIds.size}/${ROW_COUNT} cachedGET=${matrixAfterHeal.cachedGetHits.length}/${ROW_COUNT} REST=${matrixAfterHeal.restHits.length}/${ROW_COUNT} opsById=${matrixAfterHeal.opsByIdHits.length}/${ROW_COUNT} SQL=${matrixAfterHeal.sqlHits.length}/${ROW_COUNT}\n`
						: '') +
					`  POST-RESTART-2    : oracle=${matrixAfterRestart2.oracleIds.size}/${ROW_COUNT} opsScan=${matrixAfterRestart2.opsScanIds.size}/${ROW_COUNT} ` +
					`cachedGET=${matrixAfterRestart2.cachedGetHits.length}/${ROW_COUNT} REST=${matrixAfterRestart2.restHits.length}/${ROW_COUNT} ` +
					`opsById=${matrixAfterRestart2.opsByIdHits.length}/${ROW_COUNT} SQL=${matrixAfterRestart2.sqlHits.length}/${ROW_COUNT}`
			);
		}
	);
});
