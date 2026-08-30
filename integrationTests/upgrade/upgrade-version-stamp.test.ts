/**
 * Regression anchor for harper#2158: an upgrade boot must not report success unless the new data
 * version was actually recorded in `system.hdb_info`.
 *
 * The reported instance ran the 5.2.0 migration on two consecutive boots because the stamp from the
 * first run was never persisted, and boot reported success anyway. Nothing asserted the stamp
 * advanced, so the re-run was invisible. This suite asserts the postcondition directly, on the real
 * boot path:
 *
 *   1. a boot records the running version as the latest `data_version_num`;
 *   2. a boot over a deliberately staled `data_version_num` re-runs the directives AND advances the
 *      stamp to the running version;
 *   3. a further boot, with the stamp already current, adds no new record — i.e. the upgrade does
 *      not re-run, which is the observable the issue reported as broken.
 *
 * The stale version is written as a new `hdb_info` row with a higher `info_id`, which is how
 * `getLatestHdbInfoRecord` picks the current data version — the same "forced re-run on
 * already-migrated data" the QA finding behind this issue used. It goes through the fixture
 * component rather than the ops API, which answers 403 for writes to the `system` database.
 *
 * Repro: timeout 900 npm run test:integration -- "integrationTests/upgrade/upgrade-version-stamp.test.ts"
 */
import { suite, test, before, after } from 'node:test';
import { ok, strictEqual } from 'node:assert';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import {
	setupHarperWithFixture,
	startHarper,
	killHarper,
	teardownHarper,
	type ContextWithHarper,
} from '@harperfast/integration-testing';
// @ts-expect-error utils/client.mjs has no type declarations; runtime resolves fine
import { createApiClient } from '../apiTests/utils/client.mjs';

const FIXTURE_PATH = resolve(import.meta.dirname, 'upgrade-version-stamp');
const PACKAGE_VERSION = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../package.json'), 'utf8'))
	.version as string;

// Older than the 5.2.0 directive, so a boot over it takes bin/upgrade.js's runUpgrade path (the one
// that stamps) rather than the no-directives-needed path in hdbInfoController.getVersionUpdateInfo.
const STALE_DATA_VERSION = '5.1.5';

// Re-passed verbatim on every startHarper call: omitting it on a restart wipes config.
const BOOT_CONFIG = { logging: { console: true, level: 'error' } };

const skipSuite = process.platform === 'win32' || process.env.HARPER_RUNTIME === 'bun';

interface InfoRecord {
	info_id: number;
	data_version_num: string;
	hdb_version_num: string;
}

suite(
	'upgrade data-version stamp is recorded before boot reports success (#2158)',
	{ skip: skipSuite },
	(ctx: ContextWithHarper) => {
		let client: ReturnType<typeof createApiClient>;
		let httpURL: string;
		let recordsAfterUpgradeBoot: InfoRecord[];

		function request(method: string, body?: unknown): Promise<Response> {
			return fetch(`${httpURL}/VersionStamps/`, {
				method,
				headers: { 'Content-Type': 'application/json', 'Authorization': client.headers.Authorization },
				body: body === undefined ? undefined : JSON.stringify(body),
			});
		}

		function refreshClient() {
			client = createApiClient(ctx.harper);
			httpURL = ctx.harper.httpURL;
		}

		async function readStamps(): Promise<InfoRecord[]> {
			const response = await request('GET');
			strictEqual(response.status, 200, `/VersionStamps/ should return 200, got ${response.status}`);
			return ((await response.json()) as { records: InfoRecord[] }).records;
		}

		function latestOf(records: InfoRecord[]): InfoRecord {
			ok(records.length > 0, 'system.hdb_info must always hold at least one version record');
			return records[records.length - 1];
		}

		async function restartAndWait(): Promise<void> {
			await killHarper(ctx);
			await startHarper(ctx, { config: BOOT_CONFIG, env: {} });
			refreshClient();
			const deadline = Date.now() + 60_000;
			while (Date.now() < deadline) {
				try {
					if ((await request('GET')).status === 200) return;
				} catch {
					/* not up yet */
				}
				await sleep(250);
			}
			throw new Error('/VersionStamps/ never returned 200 within 60s of the restart');
		}

		before(async () => {
			await setupHarperWithFixture(ctx, FIXTURE_PATH, { config: BOOT_CONFIG, env: {} });
			refreshClient();
		});

		after(async () => {
			await teardownHarper(ctx);
		});

		test('a boot records the running version as the latest data version', async () => {
			strictEqual(latestOf(await readStamps()).data_version_num, PACKAGE_VERSION);
		});

		test('a boot over a stale data version advances the stamp to the running version', async () => {
			const staleId = latestOf(await readStamps()).info_id + 1;
			const seeded = await request('POST', { info_id: staleId, version: STALE_DATA_VERSION });
			strictEqual(seeded.status, 200, `seeding the stale stamp should return 200, got ${seeded.status}`);
			strictEqual(
				latestOf(await readStamps()).data_version_num,
				STALE_DATA_VERSION,
				'precondition: the instance must look like it is running on stale data before the restart'
			);

			await restartAndWait();

			recordsAfterUpgradeBoot = await readStamps();
			const latest = latestOf(recordsAfterUpgradeBoot);
			strictEqual(latest.data_version_num, PACKAGE_VERSION, 'the upgrade boot must record the running version');
			ok(latest.info_id > staleId, 'the stamp must be a new record, not the stale one it replaced');
		});

		test('a further boot with a current stamp does not re-run the upgrade', async () => {
			await restartAndWait();

			strictEqual(
				(await readStamps()).length,
				recordsAfterUpgradeBoot.length,
				'a boot whose data version is already current must not stamp again'
			);
		});
	}
);
