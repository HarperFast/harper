/**
 * QA-162 — Multi-resource cross-table custom transaction + @relationship edge atomicity.
 *
 * A single HTTP request to a custom Resource creates a parent Order row AND a child
 * OrderItem row, implicitly establishing a @relationship edge (FK from child to parent
 * via orderId @indexed). Probes:
 *
 *   P1 mid-throw rollback
 *      Throw AFTER writing Order (parent) but BEFORE writing OrderItem (child).
 *      Atomic => Order must roll back. FK relationship index must be clean (no dangling
 *      entry for the rolled-back parent).
 *
 *   P2 success-path bidirectional resolution
 *      Happy-path parent+child write. Edge must resolve both ways:
 *        - Order.items (parent -> children list via reverse @relationship)
 *        - OrderItem.order (child -> parent via forward @relationship)
 *
 *   P3 multi-item single-transaction
 *      One request writes one Order + N OrderItems. Reverse edge must list exactly N items.
 *      Partial-write (< N items visible, or > N via phantom) = defect.
 *
 *   P4 concurrent children -> same parent (FK index consistency)
 *      Seed one parent Order, then fire CONCURRENT_ITEMS parallel AddOrderItem requests
 *      each writing a distinct child with the same orderId. After settle:
 *        - Reverse scan via @relationship must return exactly CONCURRENT_ITEMS children.
 *        - FK index (search_by_value on orderId) must equal @relationship reverse count.
 *        - No duplicate, missing, or phantom edges.
 *
 *   P5 lmdb parity (HARPER_STORAGE_ENGINE=lmdb)
 *      Same P1-P4 checks under lmdb. Run:
 *        HARPER_STORAGE_ENGINE=lmdb npm run test:integration -- "integrationTests/resources/relationship-transaction-atomicity.test.ts"
 *
 * Reproduction (rocksdb default):
 *   npm run test:integration -- "integrationTests/resources/relationship-transaction-atomicity.test.ts"
 * Reproduction (lmdb):
 *   HARPER_STORAGE_ENGINE=lmdb npm run test:integration -- "integrationTests/resources/relationship-transaction-atomicity.test.ts"
 * Harper SHA: 7aaa5a152
 */
import { suite, test, before, after } from 'node:test';
import { ok, strictEqual } from 'node:assert/strict';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
// @ts-expect-error utils/client.mjs has no type declarations; runtime resolves fine
import { createApiClient } from '../apiTests/utils/client.mjs';

const FIXTURE_PATH = resolve(import.meta.dirname, 'relationship-transaction-atomicity');
const skipSuite = process.platform === 'win32';
const ENGINE = process.env.HARPER_STORAGE_ENGINE || 'rocksdb(default)';

const CONCURRENT_ITEMS = 8; // parallel children per parent in P4

suite(
	`QA-162 cross-table @relationship transaction atomicity [engine=${ENGINE}]`,
	{ skip: skipSuite },
	(ctx: ContextWithHarper) => {
		let client: ReturnType<typeof createApiClient>;
		let httpURL: string;
		let auth: string;

		// ---- low-level helpers ----------------------------------------------------------------

		function postJSON(path: string, body: unknown): Promise<Response> {
			return fetch(`${httpURL}${path}`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', 'Authorization': auth },
				body: JSON.stringify(body),
			});
		}

		async function restGet(path: string): Promise<{ status: number; body: any }> {
			const r = await fetch(`${httpURL}${path}`, { headers: { Authorization: auth } });
			let body: any = null;
			try {
				body = await r.json();
			} catch {
				/* ignore */
			}
			return { status: r.status, body };
		}

		/** Raw NoSQL ops helper */
		async function op(payload: any): Promise<{ status: number; body: any }> {
			const r = await client.req().send(payload).timeout(20_000);
			return { status: r.status, body: r.body };
		}

		/** Fetch an Order by PK — returns null if 404/absent. */
		async function getOrder(id: string): Promise<any | null> {
			const r = await restGet(`/Order/${id}`);
			return r.status === 200 ? r.body : null;
		}

		/** Fetch an OrderItem by PK — returns null if 404/absent. */
		async function getItem(id: string): Promise<any | null> {
			const r = await restGet(`/OrderItem/${id}`);
			return r.status === 200 ? r.body : null;
		}

		/**
		 * Count OrderItems for a given orderId via the FK index (search_by_value).
		 * This is the raw index path — independent of @relationship traversal.
		 */
		async function fkIndexCount(orderId: string): Promise<number> {
			const r = await op({
				operation: 'search_by_value',
				schema: 'data',
				table: 'OrderItem',
				search_attribute: 'orderId',
				search_value: orderId,
				get_attributes: ['id'],
			});
			const rows: any[] = Array.isArray(r.body) ? r.body : [];
			return rows.length;
		}

		/**
		 * Fetch the reverse @relationship: Order.items via REST select expansion.
		 * Returns the items array or null if the Order is absent.
		 */
		async function relItems(orderId: string): Promise<any[] | null> {
			const r = await restGet(`/Order/${orderId}?select(id,total,items{id,orderId,name,price})`);
			if (r.status !== 200 || !r.body) return null;
			return Array.isArray(r.body.items) ? r.body.items : [];
		}

		/**
		 * Fetch the forward @relationship: OrderItem.order via REST select expansion.
		 * Returns the resolved Order object, or null (dangling/absent).
		 */
		async function relParent(itemId: string): Promise<any | null> {
			const r = await restGet(`/OrderItem/${itemId}?select(id,orderId,name,price,order{id,total})`);
			if (r.status !== 200 || !r.body) return null;
			return r.body.order ?? null;
		}

		/** Delete all rows in a table via NoSQL delete (uses search_by_value wildcard). */
		async function clearTable(table: string): Promise<void> {
			const r = await op({
				operation: 'search_by_value',
				schema: 'data',
				table,
				search_attribute: 'id',
				search_value: '*',
				get_attributes: ['id'],
			});
			const rows: any[] = Array.isArray(r.body) ? r.body : [];
			const ids = rows.map((x: any) => x.id).filter(Boolean);
			if (ids.length) await op({ operation: 'delete', schema: 'data', table, ids });
		}

		async function clearAll(): Promise<void> {
			await Promise.all([clearTable('Order'), clearTable('OrderItem')]);
		}

		// ---- lifecycle ------------------------------------------------------------------------

		before(async () => {
			await setupHarperWithFixture(ctx, FIXTURE_PATH, { config: {}, env: {} });
			client = createApiClient(ctx.harper);
			httpURL = ctx.harper.httpURL;
			auth = client.headers.Authorization;
			// Poll for route readiness (component is pre-installed; no restart needed)
			{
				const deadline = Date.now() + 120_000;
				while (Date.now() < deadline) {
					try {
						const probe = await client.reqRest('/Order/').timeout(2000);
						if (probe.status !== 404) break;
					} catch {
						/* not ready yet */
					}
					await sleep(250);
				}
			}
		});

		after(async () => {
			await teardownHarper(ctx);
		});

		// ---- P1: mid-throw rollback -----------------------------------------------------------

		test('P1 mid-throw: Order rolls back; FK index has no dangling entry for rolled-back parent', async () => {
			await clearAll();

			const orderId = 'ord-p1-throw';
			const itemId = 'item-p1-throw';

			const res = await postJSON('/CreateOrderWithItem/', { orderId, itemId, name: 'widget', price: 9.99, fail: true });
			const status = res.status;

			// Give any async indexing a moment to settle (should be nothing, but be fair).
			await sleep(300);

			const order = await getOrder(orderId);
			const item = await getItem(itemId);
			const fkCount = await fkIndexCount(orderId);

			const isAtomic = !order && !item && fkCount === 0;
			console.log(
				`\n[QA-162 P1 engine=${ENGINE}] throw status=${status} (expect 4xx/5xx)\n` +
					`  Order present=${!!order} (expect false)\n` +
					`  OrderItem present=${!!item} (expect false)\n` +
					`  FK index count for orderId=${orderId}: ${fkCount} (expect 0; >0 = DANGLING INDEX)\n` +
					`  >>> ${isAtomic ? 'ATOMIC — cross-table rollback clean, FK index empty' : 'DEFECT — partial write or dangling FK index'}`
			);

			ok(status >= 400, `throwing handler must not return 2xx; got ${status}`);
			ok(!order, 'Order (parent) must roll back after mid-handler throw');
			ok(!item, 'OrderItem (child) must not exist (was never written, but confirming index is clean)');
			strictEqual(
				fkCount,
				0,
				`FK index must have 0 entries for rolled-back orderId=${orderId}; got ${fkCount} (dangling index defect)`
			);
		});

		// ---- P2: success-path bidirectional edge ---------------------------------------------

		test('P2 success path: edge resolves both directions (Order.items + OrderItem.order)', async () => {
			await clearAll();

			const orderId = 'ord-p2-ok';
			const itemId = 'item-p2-ok';
			const price = 42.5;

			const res = await postJSON('/CreateOrderWithItem/', { orderId, itemId, name: 'gadget', price, fail: false });
			strictEqual(res.status, 200, `CreateOrderWithItem must succeed; got ${res.status}`);

			// Direct PK reads to confirm both rows written.
			const order = await getOrder(orderId);
			const item = await getItem(itemId);
			ok(order, 'Order row must be committed');
			ok(item, 'OrderItem row must be committed');
			strictEqual(item?.orderId, orderId, 'OrderItem.orderId FK must match parent id');

			// Forward edge: OrderItem.order -> Order
			const forwardParent = await relParent(itemId);
			ok(
				forwardParent,
				`OrderItem.order (forward @relationship) must resolve to a non-null parent; got ${JSON.stringify(forwardParent)}`
			);
			strictEqual(
				forwardParent?.id,
				orderId,
				`forward edge must resolve to parent id=${orderId}; got ${forwardParent?.id}`
			);

			// Reverse edge: Order.items -> [OrderItem]
			const reverseItems = await relItems(orderId);
			ok(reverseItems, `Order.items (reverse @relationship) must return an array; got ${JSON.stringify(reverseItems)}`);
			strictEqual(reverseItems!.length, 1, `reverse edge must list exactly 1 child; got ${reverseItems!.length}`);
			strictEqual(reverseItems![0]?.id, itemId, `reverse edge child id must be ${itemId}; got ${reverseItems![0]?.id}`);

			// FK index count must equal 1.
			const fkCount = await fkIndexCount(orderId);
			strictEqual(fkCount, 1, `FK index for orderId must be 1 after success write; got ${fkCount}`);

			console.log(
				`\n[QA-162 P2 engine=${ENGINE}] success\n` +
					`  Order=${JSON.stringify(order)}\n` +
					`  OrderItem=${JSON.stringify(item)}\n` +
					`  forward edge -> ${JSON.stringify(forwardParent)}\n` +
					`  reverse items (${reverseItems!.length}): ${JSON.stringify(reverseItems)}\n` +
					`  FK index count: ${fkCount}\n` +
					`  >>> CORRECT — bidirectional edge resolves immediately post-commit`
			);
		});

		// ---- P3: multi-item single transaction -----------------------------------------------

		test('P3 multi-item txn: all N children committed atomically; reverse edge lists exactly N', async () => {
			await clearAll();

			const orderId = 'ord-p3-multi';
			const N = 7;
			const items = Array.from({ length: N }, (_, i) => ({
				id: `item-p3-${i}`,
				name: `item-${i}`,
				price: (i + 1) * 1.5,
			}));
			const _expectedTotal = items.reduce((s, it) => s + it.price, 0);

			const res = await postJSON('/CreateOrderWithItems/', { orderId, items });
			strictEqual(res.status, 200, `CreateOrderWithItems must succeed; got ${res.status}`);

			await sleep(200);

			const order = await getOrder(orderId);
			ok(order, 'Order must exist after multi-item write');

			// FK index count.
			const fkCount = await fkIndexCount(orderId);

			// Reverse @relationship count.
			const reverseItems = await relItems(orderId);
			const reverseCount = reverseItems?.length ?? -1;

			const allItemsPresent = await Promise.all(items.map((it) => getItem(it.id)));
			const missingItems = allItemsPresent.filter((x) => !x).length;

			console.log(
				`\n[QA-162 P3 engine=${ENGINE}] N=${N}\n` +
					`  FK index count: ${fkCount} (expect ${N})\n` +
					`  @relationship reverse count: ${reverseCount} (expect ${N})\n` +
					`  missing items via PK reads: ${missingItems} (expect 0)\n` +
					`  >>> ${fkCount === N && reverseCount === N && missingItems === 0 ? 'ATOMIC — all N children committed + edge correct' : 'DEFECT — partial commit or edge count mismatch'}`
			);

			strictEqual(missingItems, 0, `all ${N} OrderItem rows must be committed; ${missingItems} missing`);
			strictEqual(fkCount, N, `FK index must list exactly ${N} children for orderId; got ${fkCount}`);
			strictEqual(reverseCount, N, `reverse @relationship must list exactly ${N} children; got ${reverseCount}`);
		});

		// ---- P4: concurrent children -> same parent ------------------------------------------

		test('P4 concurrent children: no duplicate/missing edges; FK index == @relationship reverse count', async () => {
			await clearAll();

			const orderId = 'ord-p4-conc';

			// Seed the parent Order first so all concurrent child writes target an existing parent.
			const seedRes = await postJSON('/CreateOrderWithItem/', {
				orderId,
				itemId: 'item-p4-seed',
				name: 'seed',
				price: 0,
				fail: false,
			});
			strictEqual(seedRes.status, 200, `Seeding parent must succeed; got ${seedRes.status}`);

			// Fire CONCURRENT_ITEMS parallel AddOrderItem requests, each creating a distinct child.
			const concItems = Array.from({ length: CONCURRENT_ITEMS }, (_, i) => ({
				id: `item-p4-${i}`,
				name: `ci-${i}`,
				price: i * 0.5,
			}));

			const concResults = await Promise.all(
				concItems.map((it) => postJSON('/AddOrderItem/', { orderId, itemId: it.id, name: it.name, price: it.price }))
			);

			// All should succeed (we're writing distinct child ids, no contention expected).
			const failedConcurrent = concResults.filter((r) => r.status !== 200);
			if (failedConcurrent.length) {
				for (const r of failedConcurrent.slice(0, 5)) {
					console.log(`  concurrent item failed: status=${r.status}`);
				}
			}

			// Settle.
			await sleep(500);

			// Expected total: seed item + CONCURRENT_ITEMS concurrent items.
			const expectedTotal = 1 + CONCURRENT_ITEMS;

			const fkCount = await fkIndexCount(orderId);
			const reverseItems = await relItems(orderId);
			const reverseCount = reverseItems?.length ?? -1;

			// Check for duplicates in reverse list.
			const reverseIds = (reverseItems ?? []).map((x: any) => x.id);
			const uniqueIds = new Set(reverseIds);
			const hasDuplicates = uniqueIds.size !== reverseCount;

			// FK index IDs via raw search.
			const fkRows = await op({
				operation: 'search_by_value',
				schema: 'data',
				table: 'OrderItem',
				search_attribute: 'orderId',
				search_value: orderId,
				get_attributes: ['id'],
			});
			const fkIds = new Set((Array.isArray(fkRows.body) ? fkRows.body : []).map((x: any) => String(x.id)));
			const indexRelDrift = fkIds.size !== uniqueIds.size || [...fkIds].some((id) => !uniqueIds.has(id));

			console.log(
				`\n[QA-162 P4 engine=${ENGINE}] CONCURRENT_ITEMS=${CONCURRENT_ITEMS} failedConcurrent=${failedConcurrent.length}\n` +
					`  FK index count: ${fkCount} (expect ${expectedTotal})\n` +
					`  reverse @relationship count: ${reverseCount} (expect ${expectedTotal})\n` +
					`  unique ids in reverse: ${uniqueIds.size} hasDuplicates=${hasDuplicates}\n` +
					`  FK index == @relationship set: ${!indexRelDrift}\n` +
					`  >>> ${fkCount === expectedTotal && reverseCount === expectedTotal && !hasDuplicates && !indexRelDrift ? 'CLEAN — no duplicate/missing edges, FK index matches relationship' : 'DEFECT — edge count mismatch or duplicate/missing edges'}`
			);

			strictEqual(failedConcurrent.length, 0, `all ${CONCURRENT_ITEMS} concurrent AddOrderItem requests must succeed`);
			strictEqual(fkCount, expectedTotal, `FK index must list exactly ${expectedTotal} children; got ${fkCount}`);
			strictEqual(
				reverseCount,
				expectedTotal,
				`reverse @relationship must list exactly ${expectedTotal} children; got ${reverseCount}`
			);
			ok(
				!hasDuplicates,
				`reverse @relationship must not contain duplicate child ids; found ${reverseCount - uniqueIds.size} duplicates`
			);
			ok(!indexRelDrift, `FK index set must match @relationship reverse set; drift detected`);
		});
	}
);
