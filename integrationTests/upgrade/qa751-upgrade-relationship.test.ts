/**
 * QA-751 — does an in-place previous-minor → current upgrade leave `@relationship` graph
 * foreign-key indices intact?
 *
 * ## Why this is not covered by the existing upgrade suite
 *
 * QA-727 established that a secondary-index dbi can go dangling relative to its primary store
 * under a long-transaction force-commit/abort, and that `search_by_value`/REST-join oracles are
 * STRUCTURALLY BLIND to that: `transformToEntries()` in resources/Table.ts joins an index hit
 * through the primary record and silently SKIPs when the primary is absent, so a "0 phantom"
 * result from a join-style oracle is unfalsifiable (the "oracle-masking fallacy"). No suite asked
 * the same question of a `@relationship` graph specifically, nor of the in-place UPGRADE code path
 * (as opposed to a live long-transaction abort). minor-upgrade.test.ts in this directory covers
 * plain/indexed/audit tables, not relationship graphs.
 *
 * `@relationship` itself is virtual and unstored (the resolver setup inside `makeTable`,
 * resources/Table.ts ~6449-6560): the `to:` direction resolves via a live `search()` against the
 * OTHER table's FK index (skip-on-absent, same blindness as `search_by_value`); the `from:`
 * direction resolves via a direct primary-key `getSync()` using the FK scalar value (it doesn't
 * consult the index at all). So the only thing that can actually survive-or-not across an in-place
 * upgrade is the underlying `@indexed` FK scalar's secondary-index dbi — `Order/customerId` and
 * `LineItem/orderId` here (dbi naming from resources/databases.ts: `${tableName}/` primary,
 * `${tableName}/${attribute}` secondary).
 *
 * ## Oracle
 *
 * A second, independent, read-only `lmdb` handle opened directly against
 * `{dataRootDir}/database/data.mdb` (the same on-disk env Harper itself writes to), reading the FK
 * index dbis' raw dupSort key/value pairs. Zero dependency on `search_by_value`, REST select
 * expansion, GraphQL, or even Harper's own in-process `tables[x].indices` accessor.
 *
 * Two "expected index membership" facts are tracked directly (not decoded from raw primary
 * records): every Put this file issues is logged into `expectedIndexEntries`, so "missing" is
 * checked against ground truth we ourselves wrote, and "phantom" is checked purely from raw
 * primary-key existence (`rawPrimaryKeys`), matching QA-727's approach.
 *
 * ## Positive control (load-bearing — a green without it proves nothing)
 *
 * After the real upgrade-consistency checks pass, a raw index entry is planted directly into
 * `Order/customerId` for an `id` that does NOT exist in Order's primary store (bypassing Table.ts's
 * write path entirely via `t.indices.customerId.put(...)`). The raw oracle must detect it; REST
 * relationship expansion (Customer → orders, the `to:` direction, which resolves via `search()`)
 * must NOT surface it — proving the REST-expansion oracle really is blind to exactly the defect
 * class this suite is worried about, so the "0 phantom / 0 missing" result from the real upgrade
 * checks above is earned, not assumed. If this test ever passes vacuously the whole suite is
 * worthless, which is why it asserts on BOTH halves (oracle sees it, REST does not).
 *
 * ## Version seeding / parameterization
 *
 * Reuses minor-upgrade.test.ts's mechanism, with the same env-only gate and no default:
 *
 *   HARPER_PREVIOUS_MINOR_PATH  — absolute path to the previous-minor Harper install root (the
 *                                 directory containing dist/bin/harper.js and package.json).
 *
 * The suite skips cleanly when the variable is unset — CI slots that lack a prior-minor install
 * simply skip; no suite-level failure. There is deliberately NO derived default path here: a
 * machine-specific default is how a gated suite goes quietly vacuous in CI.
 *
 * Storage engine: forced to LMDB (`HARPER_STORAGE_ENGINE: 'lmdb'`) on BOTH boots via the SAME
 * `env` object reference passed to both startHarper() calls. This is load-bearing, not incidental:
 * resources/databases.ts picks the engine purely from `process.env.HARPER_STORAGE_ENGINE` at each
 * process boot (not auto-detected from what's on disk) — dropping the env var on the post-upgrade
 * boot would make the current build default to RocksDB, silently open an unrelated empty RocksDB
 * directory, and invalidate the entire experiment (it would look like "records vanished" when
 * really the upgraded process just never looked at the old data). The `config` object is likewise
 * the SAME reference across both boots, per the "identical config object on restart" requirement.
 *
 * ## Regression anchor
 *
 * Pins that an in-place previous-minor → current upgrade leaves `@relationship` FK secondary
 * indices consistent (0 phantom / 0 missing) for pre-upgrade-only rows, for depth-2 forward and
 * reverse traversal, and for mixed pre/post-upgrade referencing — i.e. that the QA-638 upgrade/index
 * red does NOT generalize to `@relationship` foreign-key indices. Promoted from qa-explorer QA-751 /
 * candidate P-528, which was GREEN (0 phantom / 0 missing, positive control fired) against
 * harper@5.0.31 → main.
 *
 * Reproduction:
 *   # Install the previous minor into a temp dir outside the worktree:
 *   mkdir -p /path/to/tmp/harper-prev-minor && cd /path/to/tmp/harper-prev-minor
 *   npm install harper@5.0.31
 *
 *   HARPER_PREVIOUS_MINOR_PATH=/path/to/tmp/harper-prev-minor/node_modules/harper \
 *     npm run test:integration -- "integrationTests/upgrade/qa751-upgrade-relationship.test.ts"
 */
import { suite, test, before, after } from 'node:test';
import { ok, strictEqual, deepStrictEqual } from 'node:assert';
import { resolve, join } from 'node:path';
import { existsSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { open, type RootDatabase, type Database } from 'lmdb';
import {
	setupHarperWithFixture,
	startHarper,
	killHarper,
	teardownHarper,
	type ContextWithHarper,
} from '@harperfast/integration-testing';
import { createApiClient } from '../apiTests/utils/client.mjs';

const FIXTURE_PATH = resolve(import.meta.dirname, 'qa751-upgrade-relationship');
const SCHEMA = 'data';

// Env-only gate, matching integrationTests/upgrade/minor-upgrade.test.ts: no derived default, no
// existsSync fallback -- an unset variable must skip, never silently point at a local install.
const previousMinorPath = process.env.HARPER_PREVIOUS_MINOR_PATH;

const testsBun = process.env.HARPER_RUNTIME === 'bun';
const skipSuite = !previousMinorPath || testsBun || process.platform === 'win32';

// SAME object references passed to both the pre-upgrade and post-upgrade startHarper() calls --
// load-bearing, see header. HARPER_STORAGE_ENGINE=lmdb keeps both builds on the same engine so
// the upgraded process actually opens the data the previous-minor process wrote.
const SHARED_CONFIG = {};
const SHARED_ENV = {
	HARPER_STORAGE_ENGINE: 'lmdb',
	TC_AGREEMENT: 'yes',
	REPLICATION_HOSTNAME: 'localhost',
};

suite(
	'QA-751 @relationship graph indexes across an in-place cross-version upgrade',
	{ skip: skipSuite },
	(ctx: ContextWithHarper) => {
		let client: ReturnType<typeof createApiClient>;
		let httpURL: string;
		let externalEnv: RootDatabase;
		const dbiCache = new Map<string, Database>();
		const findings: string[] = [];

		// Ground truth for "missing index entry" checks: every {table, attribute, value, id} this
		// file has written via /Put/. Phantom checks don't need this (they only need raw primary-key
		// existence), but missing checks do -- we compare against what we know we wrote, not a
		// decode of the raw primary record.
		const expectedIndexEntries: Array<{ table: string; attribute: string; value: string; id: string }> = [];

		async function waitForProbe(): Promise<void> {
			const deadline = Date.now() + 120_000;
			let ready = false;
			while (Date.now() < deadline) {
				try {
					const probe = await fetch(`${httpURL}/Probe/`, { headers: { Authorization: client.headers.Authorization } });
					if (probe.status !== 404) {
						ready = true;
						break;
					}
				} catch {
					/* not ready yet */
				}
				await sleep(250);
			}
			ok(ready, 'Probe route should become available before proceeding');
		}

		function postJSON(path: string, body: unknown): Promise<Response> {
			return fetch(`${httpURL}${path}`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', 'Authorization': client.headers.Authorization },
				body: JSON.stringify(body),
			});
		}

		async function put(table: string, record: Record<string, unknown>, fk?: { attribute: string; value: string }) {
			const res = await postJSON('/Put/', { table, record });
			strictEqual(res.status, 200, `PUT ${table}/${record.id} should succeed`);
			if (fk) expectedIndexEntries.push({ table, attribute: fk.attribute, value: fk.value, id: String(record.id) });
		}

		function restGet(path: string) {
			return client.reqRest(path);
		}

		// ---- external, non-blind raw oracle primitives (mirrors qa727-dangling-index.test.ts) ----
		function primaryDbi(table: string): Database {
			const name = `${table}/`;
			if (!dbiCache.has(name)) dbiCache.set(name, externalEnv.openDB(name, {}) as Database);
			return dbiCache.get(name)!;
		}
		function indexDbi(table: string, attribute: string): Database {
			const name = `${table}/${attribute}`;
			if (!dbiCache.has(name))
				dbiCache.set(name, externalEnv.openDB(name, { dupSort: true, encoding: 'ordered-binary' } as any) as Database);
			return dbiCache.get(name)!;
		}
		function rawPrimaryKeys(table: string): Set<string> {
			return new Set([...primaryDbi(table).getKeys({ snapshot: true } as any)].map(String));
		}
		function rawIndexEntries(table: string, attribute: string): Array<{ key: string; id: string }> {
			return [...indexDbi(table, attribute).getRange({ values: true, snapshot: true } as any)].map((e: any) => ({
				key: String(e.key),
				id: String(e.value),
			}));
		}
		/** Raw index entries whose id has no raw primary key at all -- a dangling/phantom entry. */
		function findPhantoms(table: string, attribute: string): Array<{ key: string; id: string }> {
			const primaryKeys = rawPrimaryKeys(table);
			return rawIndexEntries(table, attribute).filter((e) => !primaryKeys.has(e.id));
		}
		/** Expected {value,id} pairs (from expectedIndexEntries, for this table+attribute) with no matching raw index entry. */
		function findMissing(table: string, attribute: string): Array<{ value: string; id: string }> {
			const actual = new Set(rawIndexEntries(table, attribute).map((e) => `${e.key}\u0000${e.id}`));
			return expectedIndexEntries
				.filter((e) => e.table === table && e.attribute === attribute)
				.filter((e) => !actual.has(`${e.value}\u0000${e.id}`))
				.map((e) => ({ value: e.value, id: e.id }));
		}

		before(async () => {
			// --- Boot the PREVIOUS-minor Harper build with the fixture pre-installed ---
			await setupHarperWithFixture(ctx, FIXTURE_PATH, {
				config: SHARED_CONFIG,
				env: SHARED_ENV,
				harperBinPath: join(previousMinorPath!, 'dist', 'bin', 'harper.js'),
			});
			client = createApiClient(ctx.harper);
			httpURL = ctx.harper.httpURL;
			await waitForProbe();

			// --- Seed PRE-upgrade data: a small Customer/Order/LineItem graph, 2 levels deep ---
			// Customers
			await put('Customer', { id: 'C1', name: 'Acme' });
			await put('Customer', { id: 'C2', name: 'Globex' });
			await put('Customer', { id: 'C3', name: 'Initech' });
			// Orders (FK: customerId) -- some per customer
			await put('Order', { id: 'O1', customerId: 'C1', amount: 100 }, { attribute: 'customerId', value: 'C1' });
			await put('Order', { id: 'O2', customerId: 'C1', amount: 150 }, { attribute: 'customerId', value: 'C1' });
			await put('Order', { id: 'O3', customerId: 'C2', amount: 200 }, { attribute: 'customerId', value: 'C2' });
			await put('Order', { id: 'O4', customerId: 'C3', amount: 50 }, { attribute: 'customerId', value: 'C3' });
			// LineItems (FK: orderId)
			await put('LineItem', { id: 'L1', orderId: 'O1', sku: 'sku-1' }, { attribute: 'orderId', value: 'O1' });
			await put('LineItem', { id: 'L2', orderId: 'O1', sku: 'sku-2' }, { attribute: 'orderId', value: 'O1' });
			await put('LineItem', { id: 'L3', orderId: 'O2', sku: 'sku-3' }, { attribute: 'orderId', value: 'O2' });
			await put('LineItem', { id: 'L4', orderId: 'O3', sku: 'sku-4' }, { attribute: 'orderId', value: 'O3' });

			findings.push(
				`Pre-upgrade seed: 3 Customers, 4 Orders, 4 LineItems on previous-minor build (${previousMinorPath}).`
			);

			// --- In-place upgrade: stop the previous-minor process, restart the CURRENT build ---
			// against the SAME dataRootDir. Re-pass the SAME config/env object references -- see
			// header; this is load-bearing for the LMDB engine choice, not incidental.
			await killHarper(ctx);
			await startHarper(ctx, { config: SHARED_CONFIG, env: SHARED_ENV });
			httpURL = ctx.harper.httpURL;
			client = createApiClient(ctx.harper);
			await waitForProbe();
			findings.push('In-place upgrade: current build restarted against the same dataRootDir.');

			// --- Open the external, read-only, second-process oracle against the SAME on-disk LMDB env ---
			const dataMdbPath = join(ctx.harper.dataRootDir, 'database', `${SCHEMA}.mdb`);
			{
				const deadline = Date.now() + 30_000;
				while (!existsSync(dataMdbPath) && Date.now() < deadline) await sleep(200);
				ok(existsSync(dataMdbPath), `expected LMDB file at ${dataMdbPath}`);
			}
			externalEnv = open({
				path: dataMdbPath,
				readOnly: true,
				maxDbs: 20,
				mapSize: 1024 * 1024 * 1024,
			}) as RootDatabase;
			findings.push(`External raw oracle opened at ${dataMdbPath}`);
		});

		after(async () => {
			try {
				externalEnv?.close();
			} catch {
				/* ignore */
			}
			await teardownHarper(ctx);
			console.log('\n[QA-751] FINDINGS');
			for (const f of findings) console.log('  ' + f);
		});

		// ====================================================================================
		// 1. Raw oracle: pre-upgrade FK indices are consistent immediately after the upgrade.
		// ====================================================================================
		test('raw oracle: pre-upgrade FK indices (Order/customerId, LineItem/orderId) are consistent after upgrade', () => {
			const phantomsOrder = findPhantoms('Order', 'customerId');
			const missingOrder = findMissing('Order', 'customerId');
			const phantomsLineItem = findPhantoms('LineItem', 'orderId');
			const missingLineItem = findMissing('LineItem', 'orderId');

			console.log(
				`\n[QA-751 raw-oracle pre-upgrade] Order/customerId phantoms=${phantomsOrder.length} missing=${missingOrder.length}; ` +
					`LineItem/orderId phantoms=${phantomsLineItem.length} missing=${missingLineItem.length}`
			);
			findings.push(
				`Post-upgrade raw scan (pre-upgrade rows only): Order/customerId phantoms=${phantomsOrder.length} missing=${missingOrder.length}; ` +
					`LineItem/orderId phantoms=${phantomsLineItem.length} missing=${missingLineItem.length}.`
			);

			strictEqual(
				phantomsOrder.length,
				0,
				`Order/customerId phantom raw index entries: ${JSON.stringify(phantomsOrder)}`
			);
			strictEqual(
				missingOrder.length,
				0,
				`Order/customerId missing raw index entries: ${JSON.stringify(missingOrder)}`
			);
			strictEqual(
				phantomsLineItem.length,
				0,
				`LineItem/orderId phantom raw index entries: ${JSON.stringify(phantomsLineItem)}`
			);
			strictEqual(
				missingLineItem.length,
				0,
				`LineItem/orderId missing raw index entries: ${JSON.stringify(missingLineItem)}`
			);
		});

		// ====================================================================================
		// 2. Functional traversal on pre-upgrade rows only: forward + reverse, depth > 1.
		// ====================================================================================
		test('traversal: forward and reverse relationship expansion, depth > 1, on pre-upgrade rows', async () => {
			// Reverse-reverse (Customer -> orders -> items), depth 2.
			const rev = await restGet('/Customer/C1?select(id,name,orders{id,amount,items{id,sku}})').expect(200);
			const revBody = Array.isArray(rev.body) ? rev.body[0] : rev.body;
			const orderIds = (revBody.orders ?? []).map((o: any) => o.id).sort();
			deepStrictEqual(
				orderIds,
				['O1', 'O2'],
				`Customer C1 reverse-expansion should list its 2 orders, got ${JSON.stringify(orderIds)}`
			);
			const o1 = (revBody.orders ?? []).find((o: any) => o.id === 'O1');
			const o1Items = (o1?.items ?? []).map((i: any) => i.id).sort();
			deepStrictEqual(o1Items, ['L1', 'L2'], `Order O1 depth-2 items should be L1/L2, got ${JSON.stringify(o1Items)}`);

			// Forward-forward (LineItem -> order -> customer), depth 2.
			const fwd = await restGet('/LineItem/L1?select(id,sku,order{id,amount,customer{id,name}})').expect(200);
			const fwdBody = Array.isArray(fwd.body) ? fwd.body[0] : fwd.body;
			strictEqual(fwdBody.order?.id, 'O1', 'LineItem L1 forward-expansion order should be O1');
			strictEqual(fwdBody.order?.customer?.id, 'C1', 'LineItem L1 depth-2 forward-expansion customer should be C1');

			findings.push('Depth-2 forward and reverse traversal on pre-upgrade rows resolved correctly post-upgrade.');
		});

		// ====================================================================================
		// 3. Mixed case: POST-upgrade writes referencing PRE-upgrade targets (both graph levels).
		// ====================================================================================
		test('mixed case: post-upgrade referencing rows against pre-upgrade target rows are correctly indexed and traversable', async () => {
			// Order written POST-upgrade, referencing Customer C1 written PRE-upgrade.
			await put('Order', { id: 'O-post-1', customerId: 'C1', amount: 999 }, { attribute: 'customerId', value: 'C1' });
			// LineItem written POST-upgrade, referencing Order O1 written PRE-upgrade (2nd graph level).
			await put('LineItem', { id: 'L-post-1', orderId: 'O1', sku: 'sku-post' }, { attribute: 'orderId', value: 'O1' });
			// LineItem written POST-upgrade, referencing the Order that was ALSO written post-upgrade
			// (both sides post-upgrade -- baseline comparison for the mixed cases above).
			await put(
				'LineItem',
				{ id: 'L-post-2', orderId: 'O-post-1', sku: 'sku-post-2' },
				{ attribute: 'orderId', value: 'O-post-1' }
			);

			// Reverse: Customer C1 (pre-upgrade target) must now show O1, O2 (pre) AND O-post-1 (post).
			const rev = await restGet('/Customer/C1?select(id,name,orders{id,amount,items{id,sku}})').expect(200);
			const revBody = Array.isArray(rev.body) ? rev.body[0] : rev.body;
			const orderIds = (revBody.orders ?? []).map((o: any) => o.id).sort();
			deepStrictEqual(
				orderIds,
				['O-post-1', 'O1', 'O2'],
				`Customer C1 reverse-expansion post-mix should list O1,O2,O-post-1, got ${JSON.stringify(orderIds)}`
			);
			const o1 = (revBody.orders ?? []).find((o: any) => o.id === 'O1');
			const o1Items = (o1?.items ?? []).map((i: any) => i.id).sort();
			deepStrictEqual(
				o1Items,
				['L-post-1', 'L1', 'L2'],
				`Order O1 (pre-upgrade target) depth-2 items after post-upgrade write should include L-post-1, got ${JSON.stringify(o1Items)}`
			);
			const oPost = (revBody.orders ?? []).find((o: any) => o.id === 'O-post-1');
			const oPostItems = (oPost?.items ?? []).map((i: any) => i.id).sort();
			deepStrictEqual(
				oPostItems,
				['L-post-2'],
				`Order O-post-1 (post-upgrade target) items should be L-post-2, got ${JSON.stringify(oPostItems)}`
			);

			// Forward: LineItem L-post-1 (post-upgrade row) -> order O1 (pre) -> customer C1 (pre).
			const fwd = await restGet('/LineItem/L-post-1?select(id,sku,order{id,amount,customer{id,name}})').expect(200);
			const fwdBody = Array.isArray(fwd.body) ? fwd.body[0] : fwd.body;
			strictEqual(fwdBody.order?.id, 'O1', 'LineItem L-post-1 forward-expansion order should be pre-upgrade O1');
			strictEqual(
				fwdBody.order?.customer?.id,
				'C1',
				'LineItem L-post-1 depth-2 forward-expansion customer should be pre-upgrade C1'
			);

			findings.push(
				'Mixed pre/post-upgrade writes (post-upgrade referencing row -> pre-upgrade target row, both graph levels) correctly indexed and traversable in both directions.'
			);
		});

		// ====================================================================================
		// 4. Raw oracle: full-graph consistency after mixed pre/post-upgrade writes.
		// ====================================================================================
		test('raw oracle: full-graph FK index consistency after mixed pre/post-upgrade writes', () => {
			const phantomsOrder = findPhantoms('Order', 'customerId');
			const missingOrder = findMissing('Order', 'customerId');
			const phantomsLineItem = findPhantoms('LineItem', 'orderId');
			const missingLineItem = findMissing('LineItem', 'orderId');

			console.log(
				`\n[QA-751 raw-oracle post-mix] Order/customerId phantoms=${phantomsOrder.length} missing=${missingOrder.length}; ` +
					`LineItem/orderId phantoms=${phantomsLineItem.length} missing=${missingLineItem.length}`
			);
			findings.push(
				`Post-mix raw scan (pre + post-upgrade rows): Order/customerId phantoms=${phantomsOrder.length} missing=${missingOrder.length}; ` +
					`LineItem/orderId phantoms=${phantomsLineItem.length} missing=${missingLineItem.length}.`
			);

			strictEqual(
				phantomsOrder.length,
				0,
				`Order/customerId phantom raw index entries: ${JSON.stringify(phantomsOrder)}`
			);
			strictEqual(
				missingOrder.length,
				0,
				`Order/customerId missing raw index entries: ${JSON.stringify(missingOrder)}`
			);
			strictEqual(
				phantomsLineItem.length,
				0,
				`LineItem/orderId phantom raw index entries: ${JSON.stringify(phantomsLineItem)}`
			);
			strictEqual(
				missingLineItem.length,
				0,
				`LineItem/orderId missing raw index entries: ${JSON.stringify(missingLineItem)}`
			);
		});

		// ====================================================================================
		// 5. PLANTED-PHANTOM POSITIVE CONTROL -- proves the raw oracle is not blind, and that REST
		//    relationship expansion (the thing we'd otherwise be tempted to trust) IS blind.
		// ====================================================================================
		test('positive control: planted phantom FK index entry is caught by raw oracle, invisible to REST relationship traversal', async () => {
			// Plant a raw index entry in Order/customerId pointing FROM real Customer C1 TO an Order
			// id that does not exist in Order's primary store -- bypasses Table.ts's write path
			// entirely (no primaryStore.put, no updateIndices call site).
			const res = await postJSON('/InjectPhantom/', {
				table: 'Order',
				attribute: 'customerId',
				value: 'C1',
				id: 'O-ghost',
			});
			strictEqual(res.status, 200, 'InjectPhantom control should succeed (O-ghost must not already exist)');

			// Ground truth: O-ghost was never written to Order's primary store.
			const primaryKeys = rawPrimaryKeys('Order');
			ok(
				!primaryKeys.has('O-ghost'),
				'O-ghost should never appear in the raw Order primary store (bypassed on purpose)'
			);

			// Raw oracle DETECTS it.
			const phantoms = findPhantoms('Order', 'customerId');
			const ghost = phantoms.find((p) => p.id === 'O-ghost' && p.key === 'C1');
			ok(
				ghost,
				`raw oracle should detect the injected phantom (C1 -> O-ghost); phantoms seen: ${JSON.stringify(phantoms)}`
			);
			findings.push(
				'Positive control: raw oracle DETECTED the planted phantom Order/customerId entry (C1 -> O-ghost).'
			);

			// REST relationship expansion (Customer.orders, the `to:` direction -- resolves via a
			// live search() against Order/customerId, same skip-on-absent join as search_by_value)
			// must NOT surface it for the exact same on-disk state.
			const rev = await restGet('/Customer/C1?select(id,name,orders{id})').expect(200);
			const revBody = Array.isArray(rev.body) ? rev.body[0] : rev.body;
			const orderIds = (revBody.orders ?? []).map((o: any) => o.id);
			ok(
				!orderIds.includes('O-ghost'),
				`REST relationship expansion must NOT surface the phantom O-ghost (structurally blind, skip-on-absent join); got ${JSON.stringify(orderIds)}`
			);
			findings.push(
				`Positive control: REST relationship expansion (Customer/C1?select(orders)) did NOT surface O-ghost -- confirms the skip-on-absent blindness this scenario's raw oracle does not share. orders seen: ${JSON.stringify(orderIds)}`
			);

			// Cleanup so the planted artifact doesn't contaminate any later run of this suite.
			const cleanup = await postJSON('/RemoveIndexEntry/', {
				table: 'Order',
				attribute: 'customerId',
				value: 'C1',
				id: 'O-ghost',
			});
			strictEqual(cleanup.status, 200, 'positive-control cleanup should succeed');
			ok(
				findPhantoms('Order', 'customerId').every((p) => p.id !== 'O-ghost'),
				'O-ghost phantom should be gone after cleanup'
			);
		});
	}
);
