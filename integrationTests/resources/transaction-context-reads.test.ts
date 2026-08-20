/**
 * Transaction context read semantics — a closed per-request transaction left in the
 * AsyncLocalStorage context must NOT cause subsequent table reads to return empty.
 *
 * Regression guard for a misdiagnosis: a dashboard that read one table and then searched
 * another in the same request was reported to return empty results on the second search,
 * attributed to txnForContext() propagating CLOSED state into the second table's
 * transaction slot (Table.ts) — with a proposed fix to start a fresh ImmediateTransaction
 * instead of inheriting CLOSED.
 *
 * That mechanism does not hold: a closed transaction slot returns `undefined` from
 * getReadTxn() (DatabaseTransaction.ts), which by design reads the latest committed state
 * rather than an empty snapshot. This test pins that contract across the access patterns
 * that were suspected, including one that deterministically commits (and thus closes) the
 * per-request transaction before the second search, and one that returns the search
 * iterable lazily so it is consumed during response serialization after the commit.
 *
 * Component fixture: integrationTests/fixtures/transaction-context-reads/.
 * Skipped on Windows (restart_service http_workers crashes the Harper instance on
 * Windows — see HarperFast/harper#549).
 */
import { suite, test, before, after } from 'node:test';
import { ok, strictEqual } from 'node:assert';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
// @ts-expect-error utils/client.mjs has no type declarations; runtime resolves fine
import { createApiClient } from '../apiTests/utils/client.mjs';

const FIXTURE_PATH = resolve(import.meta.dirname, '../fixtures/transaction-context-reads');
const skipSuite = process.platform === 'win32';

suite('Transaction context: closed txn in ALS still reads latest', { skip: skipSuite }, (ctx: ContextWithHarper) => {
	let client: ReturnType<typeof createApiClient>;
	let httpURL: string;
	let auth: string;

	const COMPANY = 'c1';
	const SNAP_IDS = ['s1', 's2', 's3'];

	before(async () => {
		await setupHarperWithFixture(ctx, FIXTURE_PATH, { config: {}, env: {} });
		client = createApiClient(ctx.harper);
		httpURL = ctx.harper.httpURL;
		auth = client.headers.Authorization;

		let ready = false;
		const deadline = Date.now() + 30_000;
		while (Date.now() < deadline) {
			try {
				const probe = await client.reqRest('/Company/').timeout(3_000);
				if (probe.status !== 404) {
					ready = true;
					break;
				}
			} catch {
				/* not ready */
			}
			await sleep(250);
		}
		ok(ready, 'Harper instance did not become ready within 30 seconds');

		await putJSON(`/Company/${COMPANY}`, { id: COMPANY, name: 'Acme' });
		for (const id of SNAP_IDS) {
			await putJSON(`/ScoreSnapshot/${id}`, { id, companyId: COMPANY, score: 10 });
		}
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	async function putJSON(path: string, body: unknown): Promise<Response> {
		const r = await fetch(`${httpURL}${path}`, {
			method: 'PUT',
			headers: { 'Content-Type': 'application/json', 'Authorization': auth },
			body: JSON.stringify(body),
		});
		ok(r.status < 300, `PUT ${path} expected 2xx, got ${r.status}`);
		return r;
	}

	async function dashCount(variantPath: string): Promise<any> {
		const r = await fetch(`${httpURL}${variantPath}?company=${COMPANY}`, { headers: { Authorization: auth } });
		ok(r.status < 300, `${variantPath} expected 2xx, got ${r.status}`);
		return r.json();
	}

	test('direct indexed search returns all seeded rows', async () => {
		const r = await fetch(`${httpURL}/ScoreSnapshot/?companyId=${COMPANY}`, { headers: { Authorization: auth } });
		ok(r.status < 300, `GET /ScoreSnapshot/ expected 2xx, got ${r.status}`);
		const body = await r.json();
		const ids = (Array.isArray(body) ? body : (body?.records ?? [])).map((x: any) => x.id).sort();
		strictEqual(ids.length, SNAP_IDS.length, 'seeded snapshots are present');
	});

	test('search-first (no prior txn) returns all rows', async () => {
		const body = await dashCount('/DashControl/');
		strictEqual(body.count, SNAP_IDS.length);
	});

	test('get-then-search within one open txn returns all rows', async () => {
		const body = await dashCount('/DashGetThenSearch/');
		strictEqual(body.count, SNAP_IDS.length);
	});

	test('commit-then-search still returns all rows, on the rotated generation', async () => {
		const body = await dashCount('/DashCommitThenSearch/');
		// The explicit commit closes the generation it committed and the scope rotates to a fresh
		// OPEN, snapshot-free one, because the request scope still owes a final commit. Either way the
		// search must read the latest committed state — which is what the original misdiagnosis
		// (empty results from a closed slot) claimed it would not.
		strictEqual(body.txnOpenBefore, 1, 'txn was open before the explicit commit');
		strictEqual(body.txnOpenAfter, 1, 'the scope rotates to a fresh open generation after its own commit');
		strictEqual(body.count, SNAP_IDS.length, 'the rotated generation must still see all snapshots');
	});

	test('writes made after a mid-handler commit roll back when the request fails', async () => {
		const r = await fetch(`${httpURL}/DashCommitWriteThrow/?company=rollback`, {
			headers: { Authorization: auth },
		});
		ok(r.status >= 500, `expected the handler failure to surface, got ${r.status}`);
		for (const path of ['/Company/atomic-company-rollback', '/ScoreSnapshot/atomic-snap-rollback']) {
			const probe = await fetch(`${httpURL}${path}`, { headers: { Authorization: auth } });
			strictEqual(probe.status, 404, `${path} must not exist: it was written after the mid-handler commit`);
		}
	});

	test('writes made after a mid-handler commit are durable when the request succeeds', async () => {
		const r = await fetch(`${httpURL}/DashCommitWriteOk/?company=keep`, { headers: { Authorization: auth } });
		ok(r.status < 300, `DashCommitWriteOk expected 2xx, got ${r.status}`);
		for (const path of ['/Company/ok-company-keep', '/ScoreSnapshot/ok-snap-keep']) {
			const probe = await fetch(`${httpURL}${path}`, { headers: { Authorization: auth } });
			ok(probe.status < 300, `${path} must be durable once the request completes, got ${probe.status}`);
		}
	});

	test('lazily-returned search iterated during post-commit serialization returns all rows', async () => {
		const r = await fetch(`${httpURL}/DashLazyIterable/?company=${COMPANY}`, { headers: { Authorization: auth } });
		ok(r.status < 300, `DashLazyIterable expected 2xx, got ${r.status}`);
		const body = await r.json();
		const ids = (Array.isArray(body) ? body : (body?.records ?? [])).map((x: any) => x.id).sort();
		strictEqual(ids.length, SNAP_IDS.length, 'lazily-returned search must serialize all snapshots');
	});

	test('write-then-search (txn closed after write) still returns all rows', async () => {
		const body = await dashCount('/DashWriteThenSearch/');
		strictEqual(body.count, SNAP_IDS.length);
	});
});
