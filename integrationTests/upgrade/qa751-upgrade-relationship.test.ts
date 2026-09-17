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

const previousMinorPath = process.env.HARPER_PREVIOUS_MINOR_PATH;

const testsBun = process.env.HARPER_RUNTIME === 'bun';
const skipSuite = !previousMinorPath || testsBun || process.platform === 'win32';

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

		const expectedIndexEntries: Array<{ table: string; attribute: string; value: string; id: string }> = [];

		async function waitForProbe(): Promise<void> {
			const deadline = Date.now() + 120_000;
			let ready = false;
			while (Date.now() < deadline) {
				try {
					const probe = await fetch(`${httpURL}/Probe/`, {
						headers: { Authorization: client.headers.Authorization },
						signal: AbortSignal.timeout(5_000),
					});
					if (probe.ok) {
						ready = true;
						break;
					}
				} catch {}
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
		function findPhantoms(table: string, attribute: string): Array<{ key: string; id: string }> {
			const primaryKeys = rawPrimaryKeys(table);
			return rawIndexEntries(table, attribute).filter((e) => !primaryKeys.has(e.id));
		}
		function expectedPairs(table: string, attribute: string): Set<string> {
			return new Set(
				expectedIndexEntries
					.filter((e) => e.table === table && e.attribute === attribute)
					.map((e) => `${e.value}\u0000${e.id}`)
			);
		}
		function findMissing(table: string, attribute: string): Array<{ value: string; id: string }> {
			const actual = new Set(rawIndexEntries(table, attribute).map((e) => `${e.key}\u0000${e.id}`));
			return expectedIndexEntries
				.filter((e) => e.table === table && e.attribute === attribute)
				.filter((e) => !actual.has(`${e.value}\u0000${e.id}`))
				.map((e) => ({ value: e.value, id: e.id }));
		}
		function findUnexpected(table: string, attribute: string): Array<{ key: string; id: string }> {
			const expected = expectedPairs(table, attribute);
			return rawIndexEntries(table, attribute).filter((e) => !expected.has(`${e.key}\u0000${e.id}`));
		}
		function inspectIndex(table: string, attribute: string) {
			return {
				phantoms: findPhantoms(table, attribute),
				missing: findMissing(table, attribute),
				unexpected: findUnexpected(table, attribute),
			};
		}
		function assertIndexConsistency(table: string, attribute: string, inspection: ReturnType<typeof inspectIndex>) {
			strictEqual(
				inspection.phantoms.length,
				0,
				`${table}/${attribute} phantom raw index entries: ${JSON.stringify(inspection.phantoms)}`
			);
			strictEqual(
				inspection.missing.length,
				0,
				`${table}/${attribute} missing raw index entries: ${JSON.stringify(inspection.missing)}`
			);
			strictEqual(
				inspection.unexpected.length,
				0,
				`${table}/${attribute} unexpected raw index entries: ${JSON.stringify(inspection.unexpected)}`
			);
		}

		before(async () => {
			await setupHarperWithFixture(ctx, FIXTURE_PATH, {
				config: SHARED_CONFIG,
				env: SHARED_ENV,
				harperBinPath: join(previousMinorPath!, 'dist', 'bin', 'harper.js'),
			});
			client = createApiClient(ctx.harper);
			httpURL = ctx.harper.httpURL;
			await waitForProbe();

			await put('Customer', { id: 'C1', name: 'Acme' });
			await put('Customer', { id: 'C2', name: 'Globex' });
			await put('Customer', { id: 'C3', name: 'Initech' });
			await put('Order', { id: 'O1', customerId: 'C1', amount: 100 }, { attribute: 'customerId', value: 'C1' });
			await put('Order', { id: 'O2', customerId: 'C1', amount: 150 }, { attribute: 'customerId', value: 'C1' });
			await put('Order', { id: 'O3', customerId: 'C2', amount: 200 }, { attribute: 'customerId', value: 'C2' });
			await put('Order', { id: 'O4', customerId: 'C3', amount: 50 }, { attribute: 'customerId', value: 'C3' });
			await put('LineItem', { id: 'L1', orderId: 'O1', sku: 'sku-1' }, { attribute: 'orderId', value: 'O1' });
			await put('LineItem', { id: 'L2', orderId: 'O1', sku: 'sku-2' }, { attribute: 'orderId', value: 'O1' });
			await put('LineItem', { id: 'L3', orderId: 'O2', sku: 'sku-3' }, { attribute: 'orderId', value: 'O2' });
			await put('LineItem', { id: 'L4', orderId: 'O3', sku: 'sku-4' }, { attribute: 'orderId', value: 'O3' });

			findings.push(
				`Pre-upgrade seed: 3 Customers, 4 Orders, 4 LineItems on previous-minor build (${previousMinorPath}).`
			);

			await killHarper(ctx);
			await startHarper(ctx, { config: SHARED_CONFIG, env: SHARED_ENV });
			httpURL = ctx.harper.httpURL;
			client = createApiClient(ctx.harper);
			await waitForProbe();
			findings.push('In-place upgrade: current build restarted against the same dataRootDir.');

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
			} catch {}
			await teardownHarper(ctx);
			console.log('\n[QA-751] FINDINGS');
			for (const f of findings) console.log('  ' + f);
		});

		test('raw oracle: pre-upgrade FK indices (Order/customerId, LineItem/orderId) are consistent after upgrade', () => {
			const order = inspectIndex('Order', 'customerId');
			const lineItem = inspectIndex('LineItem', 'orderId');

			console.log(
				`\n[QA-751 raw-oracle pre-upgrade] Order/customerId phantoms=${order.phantoms.length} missing=${order.missing.length} unexpected=${order.unexpected.length}; ` +
					`LineItem/orderId phantoms=${lineItem.phantoms.length} missing=${lineItem.missing.length} unexpected=${lineItem.unexpected.length}`
			);
			findings.push(
				`Post-upgrade raw scan (pre-upgrade rows only): Order/customerId phantoms=${order.phantoms.length} missing=${order.missing.length} unexpected=${order.unexpected.length}; ` +
					`LineItem/orderId phantoms=${lineItem.phantoms.length} missing=${lineItem.missing.length} unexpected=${lineItem.unexpected.length}.`
			);

			assertIndexConsistency('Order', 'customerId', order);
			assertIndexConsistency('LineItem', 'orderId', lineItem);
		});

		test('traversal: forward and reverse relationship expansion, depth > 1, on pre-upgrade rows', async () => {
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

			const fwd = await restGet('/LineItem/L1?select(id,sku,order{id,amount,customer{id,name}})').expect(200);
			const fwdBody = Array.isArray(fwd.body) ? fwd.body[0] : fwd.body;
			strictEqual(fwdBody.order?.id, 'O1', 'LineItem L1 forward-expansion order should be O1');
			strictEqual(fwdBody.order?.customer?.id, 'C1', 'LineItem L1 depth-2 forward-expansion customer should be C1');

			findings.push('Depth-2 forward and reverse traversal on pre-upgrade rows resolved correctly post-upgrade.');
		});

		test('mixed case: post-upgrade referencing rows against pre-upgrade target rows are correctly indexed and traversable', async () => {
			await put('Order', { id: 'O-post-1', customerId: 'C1', amount: 999 }, { attribute: 'customerId', value: 'C1' });
			await put('LineItem', { id: 'L-post-1', orderId: 'O1', sku: 'sku-post' }, { attribute: 'orderId', value: 'O1' });
			await put(
				'LineItem',
				{ id: 'L-post-2', orderId: 'O-post-1', sku: 'sku-post-2' },
				{ attribute: 'orderId', value: 'O-post-1' }
			);

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

		test('raw oracle: full-graph FK index consistency after mixed pre/post-upgrade writes', () => {
			const order = inspectIndex('Order', 'customerId');
			const lineItem = inspectIndex('LineItem', 'orderId');

			console.log(
				`\n[QA-751 raw-oracle post-mix] Order/customerId phantoms=${order.phantoms.length} missing=${order.missing.length} unexpected=${order.unexpected.length}; ` +
					`LineItem/orderId phantoms=${lineItem.phantoms.length} missing=${lineItem.missing.length} unexpected=${lineItem.unexpected.length}`
			);
			findings.push(
				`Post-mix raw scan (pre + post-upgrade rows): Order/customerId phantoms=${order.phantoms.length} missing=${order.missing.length} unexpected=${order.unexpected.length}; ` +
					`LineItem/orderId phantoms=${lineItem.phantoms.length} missing=${lineItem.missing.length} unexpected=${lineItem.unexpected.length}.`
			);

			assertIndexConsistency('Order', 'customerId', order);
			assertIndexConsistency('LineItem', 'orderId', lineItem);
		});

		test('positive control: raw oracle detects dangling and wrong-key entries', async () => {
			const response = await postJSON('/InjectIndexEntry/', {
				table: 'Order',
				attribute: 'customerId',
				value: 'C1',
				id: 'O-ghost',
			});
			strictEqual(response.status, 200, 'dangling-entry control should succeed');

			const primaryKeys = rawPrimaryKeys('Order');
			ok(
				!primaryKeys.has('O-ghost'),
				'O-ghost should never appear in the raw Order primary store (bypassed on purpose)'
			);

			const phantoms = findPhantoms('Order', 'customerId');
			const ghost = phantoms.find((p) => p.id === 'O-ghost' && p.key === 'C1');
			ok(
				ghost,
				`raw oracle should detect the injected phantom (C1 -> O-ghost); phantoms seen: ${JSON.stringify(phantoms)}`
			);
			findings.push(
				'Positive control: raw oracle DETECTED the planted phantom Order/customerId entry (C1 -> O-ghost).'
			);

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

			const wrongKeyResponse = await postJSON('/InjectIndexEntry/', {
				table: 'Order',
				attribute: 'customerId',
				value: 'C2',
				id: 'O1',
			});
			strictEqual(wrongKeyResponse.status, 200, 'wrong-key control should succeed');
			const unexpected = findUnexpected('Order', 'customerId');
			ok(
				unexpected.some((entry) => entry.key === 'C2' && entry.id === 'O1'),
				`raw oracle should detect the wrong-key entry (C2 -> O1); unexpected entries: ${JSON.stringify(unexpected)}`
			);
			const c2 = await restGet('/Customer/C2?select(id,orders{id})').expect(200);
			const c2Body = Array.isArray(c2.body) ? c2.body[0] : c2.body;
			ok(
				(c2Body.orders ?? []).some((order: { id: string }) => order.id === 'O1'),
				'wrong-key control should alter reverse relationship traversal'
			);

			const ghostCleanup = await postJSON('/RemoveIndexEntry/', {
				table: 'Order',
				attribute: 'customerId',
				value: 'C1',
				id: 'O-ghost',
			});
			strictEqual(ghostCleanup.status, 200, 'dangling-entry cleanup should succeed');
			const wrongKeyCleanup = await postJSON('/RemoveIndexEntry/', {
				table: 'Order',
				attribute: 'customerId',
				value: 'C2',
				id: 'O1',
			});
			strictEqual(wrongKeyCleanup.status, 200, 'wrong-key cleanup should succeed');
			assertIndexConsistency('Order', 'customerId', inspectIndex('Order', 'customerId'));
		});
	}
);
