/**
 * QA-promoted regression anchor — promoted from QA-658 (P-437), a gated qa-explorer finding.
 * Originating QA scenario: QA-658 (source: gh#1865).
 * Coverage anchored: a REAL 5.1.22 -> current cross-version upgrade boot keeps every
 * pre-upgrade component-table row visible on all six read surfaces — the gh#1865 refutation.
 *
 * GENUINE cross-version upgrade-boot read visibility (5.1.x -> current).
 *
 * upgrade-boot-schema-change.test.ts (formerly QA-647) ran the *same-build restart* arm of
 * #1865's investigation and found ZERO read-surface misses across 6 surfaces. That narrows
 * #1865 but cannot refute it: the untested variable is a genuine cross-version on-disk/dictionary
 * shape. This suite closes that gap: it seeds component-table rows under a REAL, npm-provisioned
 * Harper 5.1.x release, stops it cleanly, then boots the CURRENT build
 * (/home/kzyp/dev/harper/dist/bin/harper.js) over the SAME dataRootDir — the actual upgrade-boot
 * scenario #1865 reports.
 *
 * The 6-surface read matrix, the base-store-scan oracle, and the heal/boot-order arms are reused
 * verbatim from the same-build-restart arm (same fixture shape, same Resource surface set) so
 * results are directly comparable between the two arms:
 *   - cached point-GET   : in-process Resource `table.get(id)` (/PointGet/)
 *   - uncached scan       : index-INDEPENDENT full base-store scan (/ScanAll/) — the ORACLE
 *   - ops search_by_value : secondary-index bulk scan via the legacy ops API
 *   - SQL                 : `operation: 'sql'`
 *   - REST                : `GET /Widget/<id>`
 *   - ops search_by_id    : legacy ops API primary-key point lookup
 *
 * Also probes:
 *   - write-then-read heal: does re-putting a missed row's known original fields repair the
 *     cached point-GET surface? (/Touch/)
 *   - boot-order dependence: does a SECOND restart (current build, no further version change)
 *     clear a miss seen after the cross-version restart, or is the miss stable/growing?
 *
 * Provisioning: 5.1.x is installed via `npm install harper@5.1.22 --no-save` into an isolated
 * temp npm prefix (~/dev/tmp/qa658-harper51), NOT via HARPER_LEGACY_VERSION_PATH (that env var is
 * reserved for the 4.x-upgrade suite's convention of a pre-existing legacy install directory —
 * see integrationTests/upgrade/4.x-upgrade.test.ts). The resolved 5.1.x `dist/bin/harper.js` is
 * passed as `harperBinPath` to `setupHarperWithFixture`, exactly as 4.x-upgrade.test.ts passes
 * `bin/harperdb.js` for its legacy arm.
 *
 * Every "restart" reuses setupHarperWithFixture/startHarper's own dataRootDir + hostname
 * (ctx.harper is never reset), and re-passes the EXACT same `config` object used on the initial
 * boot on every subsequent startHarper call — omitting it on a restart wipes config.
 *
 * Readiness after a restart is confirmed by polling a real route directly until it stops
 * 404-ing — restartHttpWorkers() is NOT used, since it races against a pre-installed fixture and
 * flakes on CI.
 *
 * Harper SHA under test: 07c2bbcb9 (main) — re-run confirmed clean at this SHA on 2026-07-22;
 * originally authored at 77b46abf2 (an ancestor of 07c2bbcb9 on main), provisioning reused as-is.
 * 5.1.x version installed: harper@5.1.22 (latest 5.1 release on npm as of this run).
 * Repro: timeout 420 npm run test:integration -- "integrationTests/upgrade/cross-version-upgrade-visibility.test.ts"
 */
import { suite, test, before, after } from 'node:test';
import { ok, strictEqual, deepStrictEqual } from 'node:assert';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
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

const FIXTURE_PATH = resolve(import.meta.dirname, 'cross-version-upgrade-visibility');
const DB = 'qa658';
const TABLE = 'Widget';
const ROW_COUNT = 24;
const BATCH = 'waveA';

// Provisioned by: cd ~/dev/tmp/qa658-harper51 && npm install harper@5.1.22 --no-save
// Override with HARPER_LEGACY_51_PATH if provisioned elsewhere.
const LEGACY_51_BIN_PATH =
	process.env.HARPER_LEGACY_51_PATH ??
	resolve(process.env.HOME ?? '', 'dev/tmp/qa658-harper51/node_modules/harper/dist/bin/harper.js');
const legacy51Available = existsSync(LEGACY_51_BIN_PATH);

const skipSuite = process.platform === 'win32' || !legacy51Available;

// Passed verbatim to setupHarperWithFixture AND to every subsequent startHarper call across every
// restart in this suite — never omitted, so a restart never silently wipes config.
const BOOT_CONFIG = { logging: { console: true, level: 'error' } };

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

suite(
	'QA-658 cross-version (5.1.x -> current) upgrade-boot read visibility across surfaces (#1865)',
	{ skip: skipSuite },
	(ctx: ContextWithHarper) => {
		let client: ReturnType<typeof createApiClient>;
		let httpURL: string;
		let rows: Row[] = [];
		const findings: string[] = [];
		function log(line: string) {
			findings.push(line);
			console.log(`[QA-658] ${line}`);
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
		let matrixAfterCrossVerRestart: SurfaceMatrix;
		let matrixAfterHeal: SurfaceMatrix | null = null;
		let matrixAfterRestart2: SurfaceMatrix;

		before(async () => {
			log(`harper SHA under test: 07c2bbcb9; legacy 5.1.x bin: ${LEGACY_51_BIN_PATH}`);
			await setupHarperWithFixture(ctx, FIXTURE_PATH, {
				config: BOOT_CONFIG,
				env: { TC_AGREEMENT: 'yes' },
				harperBinPath: LEGACY_51_BIN_PATH,
			});
			await refreshClient();
			await pollReady('/ScanAll/');
			log(`cold boot (5.1.x) complete at ${httpURL}, dataRootDir=${ctx.harper.dataRootDir}`);

			const loadRes = await post('/Load/', { count: ROW_COUNT, batch: BATCH });
			strictEqual(loadRes.status, 200, 'Load should return 200');
			const loadBody = (await loadRes.json()) as { ids: string[] };
			rows = loadBody.ids.map((id, i) => ({
				id,
				sku: `SKU-${BATCH}-${i}`,
				batch: BATCH,
				name: `Widget ${BATCH} ${i}`,
			}));
			log(`loaded ${rows.length} rows under 5.1.x (batch=${BATCH})`);
		});

		after(async () => {
			await teardownHarper(ctx);
			log('--- FINDINGS SUMMARY ---');
			for (const line of findings) console.log(`[QA-658][summary] ${line}`);
		});

		test(
			'Q0 PRE-UPGRADE baseline (on 5.1.x): every surface sees every row (precondition)',
			{ timeout: 60_000 },
			async () => {
				matrixBaseline = await buildMatrix('PRE-UPGRADE (5.1.x)');
				strictEqual(
					matrixBaseline.oracleIds.size,
					ROW_COUNT,
					'PRECONDITION: oracle scan must see all rows pre-upgrade'
				);
				strictEqual(
					matrixBaseline.opsScanIds.size,
					ROW_COUNT,
					'PRECONDITION: ops search_by_value scan must see all rows pre-upgrade'
				);
				strictEqual(
					matrixBaseline.cachedGetHits.length,
					ROW_COUNT,
					'PRECONDITION: cached point-GET must hit every row pre-upgrade'
				);
				strictEqual(matrixBaseline.restHits.length, ROW_COUNT, 'PRECONDITION: REST must hit every row pre-upgrade');
				strictEqual(
					matrixBaseline.opsByIdHits.length,
					ROW_COUNT,
					'PRECONDITION: ops search_by_id must hit every row pre-upgrade'
				);
				strictEqual(matrixBaseline.sqlHits.length, ROW_COUNT, 'PRECONDITION: SQL must hit every row pre-upgrade');
			}
		);

		test(
			'Q1 CROSS-VERSION UPGRADE BOOT: stop 5.1.x cleanly, start CURRENT build over the same dataRootDir',
			{ timeout: 90_000 },
			async () => {
				await killHarper(ctx);
				log('killed 5.1.x cleanly (SIGTERM)');

				// No harperBinPath here -> resolves to the current build (dist/bin/harper.js) via the
				// 'harper' package in node_modules, which in this repo checkout is the repo itself.
				// Critical: re-pass the SAME config object used on the initial boot.
				await startHarper(ctx, { config: BOOT_CONFIG, env: {} });
				await refreshClient();
				await pollReady('/ScanAll/');
				log(`cross-version upgrade boot (current build over 5.1.x data) complete at ${httpURL}`);

				matrixAfterCrossVerRestart = await buildMatrix('POST-CROSSVER-UPGRADE');

				// Oracle must hold regardless of what any other surface reports — if this fails, rows
				// were actually lost (a much larger problem than a read-visibility miss), and everything
				// below is moot.
				strictEqual(
					matrixAfterCrossVerRestart.oracleIds.size,
					ROW_COUNT,
					`ORACLE: uncached index-independent full scan must still see all ${ROW_COUNT} rows after the cross-version upgrade boot (proves data is on disk)`
				);
				deepStrictEqual(
					[...matrixAfterCrossVerRestart.oracleIds].sort(),
					rows.map((r) => r.id).sort(),
					'ORACLE: post-upgrade scan id set must exactly match the pre-upgrade row set'
				);
			}
		);

		test('Q2 POST-CROSSVER-UPGRADE: does the cached point-GET / SQL / REST / ops surface miss what the oracle sees?', () => {
			const m = matrixAfterCrossVerRestart;
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
				matrixAfterCrossVerRestart.cachedGetMisses.length ||
				matrixAfterCrossVerRestart.restMisses.length ||
				matrixAfterCrossVerRestart.opsByIdMisses.length ||
				matrixAfterCrossVerRestart.sqlMisses.length;
			if (!anyMisses) {
				t.skip('no miss observed after the cross-version upgrade boot on any point surface — nothing to heal');
				return;
			}
			// Prefer a row missed on cached point-GET (the surface #1865 names); fall back to any miss.
			const targetId =
				matrixAfterCrossVerRestart.cachedGetMisses[0] ??
				matrixAfterCrossVerRestart.restMisses[0] ??
				matrixAfterCrossVerRestart.opsByIdMisses[0] ??
				matrixAfterCrossVerRestart.sqlMisses[0];
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
			'Q4 RESTART #2 (current build, no further version change): is the miss stable, cleared, or does it grow?',
			{ timeout: 90_000 },
			async () => {
				await killHarper(ctx);
				log('killed Harper cleanly (SIGTERM) for restart #2 (same-build, boot-order check)');

				// Same config again — no further version change this time (isolates "does a SECOND
				// boot on the current build alone change anything" from "does the cross-version boot").
				await startHarper(ctx, { config: BOOT_CONFIG, env: {} });
				await refreshClient();
				await pollReady('/ScanAll/');
				log(`restart #2 (same-build) complete at ${httpURL}`);

				matrixAfterRestart2 = await buildMatrix('POST-RESTART-2 (same-build)');

				strictEqual(
					matrixAfterRestart2.oracleIds.size,
					ROW_COUNT,
					`ORACLE: uncached full scan must still see all ${ROW_COUNT} rows after the SECOND restart`
				);

				const cmp = (a: string[], b: string[], name: string) => {
					log(
						`Q4 boot-order check (${name}): after-crossver-upgrade misses=${b.length}, ` +
							`after-restart#2 misses=${a.length} -> ${
								a.length === 0 && b.length > 0
									? 'CLEARED on 2nd (same-build) boot (order-dependent)'
									: a.length > 0 && b.length === 0
										? 'NEW MISS introduced by 2nd boot alone'
										: a.length === b.length
											? 'UNCHANGED across boots (stable)'
											: 'CHANGED (different miss set/count)'
							}`
					);
				};
				cmp(matrixAfterRestart2.cachedGetMisses, matrixAfterCrossVerRestart.cachedGetMisses, 'cachedGetMisses');
				cmp(matrixAfterRestart2.restMisses, matrixAfterCrossVerRestart.restMisses, 'restMisses');
				cmp(matrixAfterRestart2.opsByIdMisses, matrixAfterCrossVerRestart.opsByIdMisses, 'opsByIdMisses');
				cmp(matrixAfterRestart2.sqlMisses, matrixAfterCrossVerRestart.sqlMisses, 'sqlMisses');

				log(
					`FINAL VISIBILITY MATRIX SUMMARY:\n` +
						`  PRE-UPGRADE (5.1.x)     : oracle=${matrixBaseline.oracleIds.size}/${ROW_COUNT} opsScan=${matrixBaseline.opsScanIds.size}/${ROW_COUNT} ` +
						`cachedGET=${matrixBaseline.cachedGetHits.length}/${ROW_COUNT} REST=${matrixBaseline.restHits.length}/${ROW_COUNT} ` +
						`opsById=${matrixBaseline.opsByIdHits.length}/${ROW_COUNT} SQL=${matrixBaseline.sqlHits.length}/${ROW_COUNT}\n` +
						`  POST-CROSSVER-UPGRADE    : oracle=${matrixAfterCrossVerRestart.oracleIds.size}/${ROW_COUNT} opsScan=${matrixAfterCrossVerRestart.opsScanIds.size}/${ROW_COUNT} ` +
						`cachedGET=${matrixAfterCrossVerRestart.cachedGetHits.length}/${ROW_COUNT} REST=${matrixAfterCrossVerRestart.restHits.length}/${ROW_COUNT} ` +
						`opsById=${matrixAfterCrossVerRestart.opsByIdHits.length}/${ROW_COUNT} SQL=${matrixAfterCrossVerRestart.sqlHits.length}/${ROW_COUNT}\n` +
						(matrixAfterHeal
							? `  POST-HEAL         : oracle=${matrixAfterHeal.oracleIds.size}/${ROW_COUNT} cachedGET=${matrixAfterHeal.cachedGetHits.length}/${ROW_COUNT} REST=${matrixAfterHeal.restHits.length}/${ROW_COUNT} opsById=${matrixAfterHeal.opsByIdHits.length}/${ROW_COUNT} SQL=${matrixAfterHeal.sqlHits.length}/${ROW_COUNT}\n`
							: '') +
						`  POST-RESTART-2    : oracle=${matrixAfterRestart2.oracleIds.size}/${ROW_COUNT} opsScan=${matrixAfterRestart2.opsScanIds.size}/${ROW_COUNT} ` +
						`cachedGET=${matrixAfterRestart2.cachedGetHits.length}/${ROW_COUNT} REST=${matrixAfterRestart2.restHits.length}/${ROW_COUNT} ` +
						`opsById=${matrixAfterRestart2.opsByIdHits.length}/${ROW_COUNT} SQL=${matrixAfterRestart2.sqlHits.length}/${ROW_COUNT}`
				);
			}
		);
	}
);
