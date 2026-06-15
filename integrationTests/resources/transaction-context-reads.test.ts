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
import { ok, strictEqual } from 'node:assert/strict';
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

		const deadline = Date.now() + 30_000;
		while (Date.now() < deadline) {
			try {
				const probe = await client.reqRest('/Company/').timeout(3_000);
				if (probe.status !== 404) break;
			} catch {
				/* not ready */
			}
			await sleep(250);
		}

		await putJSON(`/Company/${COMPANY}`, { id: COMPANY, name: 'Acme' });
		for (const id of SNAP_IDS) {
			await putJSON(`/ScoreSnapshot/${id}`, { id, companyId: COMPANY, score: 10 });
		}
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	function putJSON(path: string, body: unknown): Promise<Response> {
		return fetch(`${httpURL}${path}`, {
			method: 'PUT',
			headers: { 'Content-Type': 'application/json', 'Authorization': auth },
			body: JSON.stringify(body),
		});
	}

	async function dashCount(variantPath: string): Promise<any> {
		const r = await fetch(`${httpURL}${variantPath}?company=${COMPANY}`, { headers: { Authorization: auth } });
		ok(r.status < 300, `${variantPath} expected 2xx, got ${r.status}`);
		return r.json();
	}

	test('direct indexed search returns all seeded rows', async () => {
		const r = await fetch(`${httpURL}/ScoreSnapshot/?companyId=${COMPANY}`, { headers: { Authorization: auth } });
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

	test('commit-then-search (txn closed in ALS) still returns all rows', async () => {
		const body = await dashCount('/DashCommitThenSearch/');
		// Guards the misdiagnosis: the request txn is genuinely closed before the search
		// (open: 1 -> 0), yet the closed slot reads latest committed state, not empty.
		strictEqual(body.txnOpenBefore, 1, 'txn was open before the explicit commit');
		strictEqual(body.txnOpenAfter, 0, 'txn is closed in ALS before the search');
		strictEqual(body.count, SNAP_IDS.length, 'closed-txn-in-ALS must still see all snapshots');
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
