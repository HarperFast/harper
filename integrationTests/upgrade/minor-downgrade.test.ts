/**
 * Minor-version rollback: previous minor → current build → previous minor again → current build,
 * all on one data directory.
 *
 * `dataLayer/DESIGN.md` ("Version gate at startup: downgrades prompt, and only the minor direction is
 * confirmable") makes a confirmed minor downgrade a supported path, so the older binary must read
 * and write everything the newer build wrote, and the data must survive going forward again. Each
 * install in HARPER_PREVIOUS_MINOR_PATH (see minorVersionFixtures.ts) is a rollback target. Rolling
 * back to an older minor must refuse without CONFIRM_DOWNGRADE when there is no TTY; rolling back
 * within a minor (5.3.x while `package.json` says 5.3.x) must boot without it.
 *
 * A table created on 5.3.0 or later is unreadable on 5.2.x (#3102). The checks on that table report
 * TODO when they observe exactly that defect and fail on anything else; the runner fails a run on
 * any failing test, TODO or not.
 */
import { suite, test, before, after, type TestContext } from 'node:test';
import { deepStrictEqual, match, ok, strictEqual } from 'node:assert';
import { isDeepStrictEqual } from 'node:util';
import { resolve } from 'node:path';
import {
	HarperStartupError,
	killHarper,
	sendOperation,
	setupHarperWithFixture,
	startHarper,
	teardownHarper,
	type ContextWithHarper,
} from '@harperfast/integration-testing';
import {
	CURRENT_VERSION,
	FIRST_BOOT_ENV,
	NO_PREVIOUS_MINOR,
	SEEDED_AUDIT_IDS,
	buildAuditSubjects,
	buildThings,
	buildWidget,
	buildWidgets,
	previousMinorInstalls,
	seedMinorFixtures,
	skipCrossVersion,
} from './minorVersionFixtures.ts';

const FIXTURE_PATH = resolve(import.meta.dirname, 'minor-downgrade');
const KNOWN_ISSUE = 'https://github.com/HarperFast/harper/issues/3102';
// The gate exits about 2 s into boot; an absolute deadline also catches a gate that keeps logging while it waits.
const REFUSAL_DEADLINE_MS = 30_000;
const REQUEST_TIMEOUT_MS = 30_000;
const NEW_TABLE = 'born_on_current';
const NEW_TABLE_TARGET_ROW = { id: 'n-2', v: 'target' };

type Row = { id: string } & Record<string, unknown>;

const byId = (a: Row, b: Row) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const majorMinor = (version: string) => version.split('.').slice(0, 2).map(Number);

if (previousMinorInstalls.length === 0) suite('minor-version rollback', { skip: NO_PREVIOUS_MINOR }, () => {});

for (const target of previousMinorInstalls) {
	const [currentMajor, currentMinor] = majorMinor(CURRENT_VERSION);
	const [targetMajor, targetMinor] = majorMinor(target.version);
	const minorDowngrade = targetMajor === currentMajor && targetMinor < currentMinor;
	const knownIssueApplies = targetMajor === 5 && targetMinor < 3;
	const v = `v${target.version}`;

	suite(
		`rollback ${v} → current (${CURRENT_VERSION}) → ${v} → current: every binary's rows survive`,
		{ skip: skipCrossVersion },
		(ctx: ContextWithHarper) => {
			const expected = new Map<string, Map<string, Row>>();
			const expectedAudit = SEEDED_AUDIT_IDS.map((id) => `upsert:${id}`);
			const track = (table: string, rows: Row[]) => {
				const tableRows = expected.get(table) ?? new Map<string, Row>();
				for (const row of rows) tableRows.set(row.id, row);
				expected.set(table, tableRows);
			};
			const expectedRows = (table: string) => [...(expected.get(table)?.values() ?? [])].sort(byId);

			function adminAuthorization() {
				const { username, password } = ctx.harper.admin;
				return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
			}

			async function restGet(path: string) {
				const response = await fetch(`${ctx.harper.httpURL}${path}`, {
					headers: { Authorization: adminAuthorization() },
					signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
				});
				strictEqual(response.status, 200, `GET ${path}`);
				return response.json();
			}

			async function write(table: string, rows: Row[]) {
				const response = await sendOperation(ctx.harper, { operation: 'upsert', table, records: rows });
				deepStrictEqual([...response.upserted_hashes].sort(), rows.map(({ id }) => id).sort(), `upsert into ${table}`);
				track(table, rows);
				if (table === 'audit_subject') expectedAudit.push(`upsert:${rows.map(({ id }) => id).join(',')}`);
			}

			async function readAll(table: string): Promise<Row[]> {
				const rows: Row[] = await sendOperation(ctx.harper, {
					operation: 'search_by_value',
					table,
					search_attribute: 'id',
					search_value: '*',
					get_attributes: ['*'],
				});
				return rows.sort(byId);
			}

			async function readDataVersion(): Promise<string> {
				const records = await sendOperation(ctx.harper, {
					operation: 'search_by_value',
					database: 'system',
					table: 'hdb_info',
					search_attribute: 'info_id',
					search_value: '*',
					get_attributes: ['info_id', 'data_version_num'],
				});
				return records.sort((a, b) => a.info_id - b.info_id).at(-1).data_version_num;
			}

			async function conditionIds(table: string, attribute: string, value: string) {
				const rows: Row[] = await sendOperation(ctx.harper, {
					operation: 'search_by_conditions',
					table,
					conditions: [{ attribute, comparator: 'equals', value }],
				});
				return rows.map(({ id }) => id).sort();
			}
			const expectedIds = (table: string, attribute: string, value: string) =>
				expectedRows(table)
					.filter((row) => row[attribute] === value)
					.map(({ id }) => id)
					.sort();

			/** Reads every table through search_by_value, SQL, REST, indexed search and the audit log against the rows written so far. */
			async function assertEveryRow(phase: string) {
				for (const table of ['things', 'widgets', 'audit_subject', 'Gadget'])
					deepStrictEqual(await readAll(table), expectedRows(table), `${phase}: search_by_value on ${table}`);

				const sqlRows: Row[] = await sendOperation(ctx.harper, { operation: 'sql', sql: 'SELECT * FROM data.things' });
				deepStrictEqual(
					sqlRows
						.map((row) => Object.fromEntries(Object.entries(row).filter(([, value]) => value !== null)) as Row)
						.sort(byId),
					expectedRows('things'),
					`${phase}: SQL on things`
				);

				for (const gadget of expectedRows('Gadget'))
					deepStrictEqual(await restGet(`/Gadget/${gadget.id}`), gadget, `${phase}: REST GET /Gadget/${gadget.id}`);

				const indexProbes = [
					['widgets', 'name', 'widget-7'],
					['widgets', 'name', 'widget-44'],
					['widgets', 'name', 'widget-45'],
					['widgets', 'category', 'A'],
					['widgets', 'category', 'B'],
					['widgets', 'category', 'C'],
				];
				// searching an attribute the table does not have yet is a 400
				if (expectedRows('things').some((row) => 'extra' in row))
					indexProbes.push(['things', 'extra', 'x-current'], ['things', 'extra', 'x-target']);
				for (const [table, attribute, value] of indexProbes)
					deepStrictEqual(
						await conditionIds(table, attribute, value),
						expectedIds(table, attribute, value),
						`${phase}: indexed search ${table}.${attribute} = ${value}`
					);
				for (const name of ['gadget-0', 'gadget-0-current', 'gadget-6', 'gadget-8']) {
					const rows: Row[] = await restGet(`/Gadget/?name=${name}`);
					deepStrictEqual(
						rows.map(({ id }) => id).sort(),
						expectedIds('Gadget', 'name', name),
						`${phase}: REST GET /Gadget/?name=${name}`
					);
				}

				const audit = await sendOperation(ctx.harper, {
					operation: 'read_audit_log',
					schema: 'data',
					table: 'audit_subject',
				});
				deepStrictEqual(
					audit.map((entry: { operation: string; ids: string[] }) => `${entry.operation}:${entry.ids.join(',')}`),
					expectedAudit,
					`${phase}: read_audit_log on audit_subject`
				);
			}

			/**
			 * #3102: on a target before 5.3.0, the table the current build created reads as exactly
			 * `defect`. Anything else is an ordinary failure.
			 */
			function assertNewTable(t: TestContext, actual: Row[], defect: Row[], phase: string) {
				const rows = expectedRows(NEW_TABLE);
				if (knownIssueApplies && !isDeepStrictEqual(actual, rows) && isDeepStrictEqual(actual, defect)) {
					t.todo(`${KNOWN_ISSUE}: ${phase}`);
					t.diagnostic(`${phase}: read ${JSON.stringify(actual)}, expected ${JSON.stringify(rows)}`);
					return;
				}
				deepStrictEqual(actual, rows, `${phase}: search_by_value on ${NEW_TABLE}`);
			}

			before(async () => {
				await setupHarperWithFixture(ctx, FIXTURE_PATH, {
					config: {},
					env: FIRST_BOOT_ENV,
					harperBinPath: target.binPath,
				});
				await seedMinorFixtures(ctx.harper);
				track('things', buildThings());
				track('widgets', buildWidgets());
				track('audit_subject', buildAuditSubjects());
				await write(
					'Gadget',
					Array.from({ length: 5 }, (_, i) => ({ id: `g-${i}`, name: `gadget-${i}`, phase: 'previous' }))
				);
				await assertEveryRow(`${v} before upgrade`);
			});

			after(async () => {
				await teardownHarper(ctx);
			});

			test(`upgrade: the current build reads ${v} data, records ${CURRENT_VERSION}, and takes new rows, an attribute and a table`, async () => {
				await killHarper(ctx);
				await startHarper(ctx, { config: {}, env: {} });
				strictEqual(await readDataVersion(), CURRENT_VERSION, 'the current build records its version');
				await assertEveryRow('current build after upgrade');

				await write(
					'things',
					Array.from({ length: 5 }, (_, i) => ({ id: `t-${15 + i}`, label: `thing-${15 + i}-current`, count: 15 + i }))
				);
				await write('things', [{ id: 't-5', label: 'thing-5-current', count: 500 }]);
				await sendOperation(ctx.harper, { operation: 'create_attribute', table: 'things', attribute: 'extra' });
				await write('things', [
					{ id: 't-20', label: 'thing-20-current', count: 20, extra: 'x-current' },
					{ id: 't-6', label: 'thing-6-current', count: 600, extra: 'x-current' },
				]);
				await write(
					'widgets',
					Array.from({ length: 5 }, (_, i) => buildWidget(40 + i))
				);
				await write('widgets', [{ ...buildWidget(1), category: 'A' }]);
				await write('audit_subject', [{ id: 'a-5', value: 'val-5-current' }]);
				await write('audit_subject', [{ id: 'a-1', value: 'val-1-current' }]);
				await write('Gadget', [
					{ id: 'g-0', name: 'gadget-0-current', phase: 'current' },
					...Array.from({ length: 3 }, (_, i) => ({ id: `g-${5 + i}`, name: `gadget-${5 + i}`, phase: 'current' })),
				]);
				await sendOperation(ctx.harper, {
					operation: 'create_table',
					table: NEW_TABLE,
					primary_key: 'id',
					attributes: [
						{ name: 'id', type: 'ID' },
						{ name: 'v', type: 'String' },
					],
				});
				await write(NEW_TABLE, [
					{ id: 'n-0', v: 'current' },
					{ id: 'n-1', v: 'current' },
				]);

				await assertEveryRow('current build after its own writes');
				deepStrictEqual(await readAll(NEW_TABLE), expectedRows(NEW_TABLE), `current build: ${NEW_TABLE}`);
			});

			test(
				minorDowngrade
					? `gate: with no TTY and no CONFIRM_DOWNGRADE, ${v} exits within ${REFUSAL_DEADLINE_MS} ms naming the override`
					: `gate: ${v} shares the current minor and boots without CONFIRM_DOWNGRADE`,
				async (t) => {
					strictEqual(targetMajor, currentMajor, 'HARPER_PREVIOUS_MINOR_PATH must name installs of the current major');
					await killHarper(ctx);
					const options = { config: {}, env: { CONFIRM_DOWNGRADE: undefined }, harperBinPath: target.binPath };
					if (!minorDowngrade) {
						await startHarper(ctx, options);
						return;
					}
					const startedAt = Date.now();
					const refusal = await startHarper(ctx, { ...options, startupMaxMs: REFUSAL_DEADLINE_MS }).then(
						() => undefined,
						(error: unknown) => error
					);
					t.diagnostic(`${v} refused after ${Date.now() - startedAt} ms`);
					ok(
						refusal instanceof HarperStartupError,
						`${v} booted over ${CURRENT_VERSION} data without CONFIRM_DOWNGRADE`
					);
					match(
						refusal.message,
						/^Harper process failed with exit code\/signal [1-9]/,
						'the gate must refuse by exiting non-zero, not by waiting until the startup deadline'
					);
					match(refusal.stderr, /CONFIRM_DOWNGRADE=yes/, 'the refusal must name the override');
				}
			);

			test(`rollback: ${v} boots with CONFIRM_DOWNGRADE=yes and reads every row both binaries wrote`, async () => {
				await killHarper(ctx);
				await startHarper(ctx, { config: {}, env: { CONFIRM_DOWNGRADE: 'yes' }, harperBinPath: target.binPath });
				strictEqual(
					await readDataVersion(),
					minorDowngrade ? target.version : CURRENT_VERSION,
					minorDowngrade ? 'a confirmed downgrade records the older version' : 'a same-minor rollback keeps the stamp'
				);
				await assertEveryRow(`${v} after rollback`);
			});

			test(`rollback: ${v} writes to every table it can already read`, async () => {
				await write('things', [
					{ id: 't-21', label: 'thing-21-target', count: 21, extra: 'x-target' },
					{ id: 't-7', label: 'thing-7-target', count: 700, extra: 'x-target' },
				]);
				await write('widgets', [buildWidget(45), { ...buildWidget(2), category: 'B' }]);
				await write('audit_subject', [{ id: 'a-6', value: 'val-6-target' }]);
				await write('audit_subject', [{ id: 'a-2', value: 'val-2-target' }]);
				await write('Gadget', [{ id: 'g-8', name: 'gadget-8', phase: 'target' }]);
				await assertEveryRow(`${v} after its own writes`);
			});

			test(`rollback: ${v} reads the rows the current build wrote to the table it created`, async (t) => {
				assertNewTable(t, await readAll(NEW_TABLE), [], `${v} reading ${NEW_TABLE}`);
			});

			test(`rollback: ${v} writes to the table the current build created and reads the row back`, async (t) => {
				await write(NEW_TABLE, [NEW_TABLE_TARGET_ROW]);
				assertNewTable(
					t,
					await readAll(NEW_TABLE),
					[NEW_TABLE_TARGET_ROW],
					`${v} reading ${NEW_TABLE} after writing to it`
				);
			});

			test('round trip: the current build reads every row all three phases wrote', async () => {
				await killHarper(ctx);
				await startHarper(ctx, { config: {}, env: {} });
				strictEqual(await readDataVersion(), CURRENT_VERSION, 'the re-upgrade records the current version');
				await assertEveryRow('current build after round trip');
			});

			test(`round trip: the current build reads the row ${v} wrote to the table the current build created`, async (t) => {
				assertNewTable(
					t,
					await readAll(NEW_TABLE),
					expectedRows(NEW_TABLE).filter(({ id }) => id !== NEW_TABLE_TARGET_ROW.id),
					`current build reading ${NEW_TABLE} after round trip`
				);
			});
		}
	);
}
