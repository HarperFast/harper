/**
 * #1407/#1411 — custom-resource-handler over-time atomicity regression anchor.
 *
 * Follow-up to the PR #1411 review comment flagging a reproduction from the custom-resource
 * handler side (qa-explorer, main 28db4fde4): a handler whose transaction exceeds
 * storage.maxTransactionOpenTime (default 30s) got FORCE-COMMITTED mid-handler by the
 * long-transaction monitor pre-#1411. Writes made before the fire point were silently lost;
 * writes after it landed on a fresh implicit txn and survived; the request still returned
 * HTTP 200. Narrow trigger: write(s) -> idle async suspend with no intervening write (a bare
 * await/slow external I/O > maxTransactionOpenTime) -> write(s). Bulk writes do not trigger it
 * (each put() resets txn.timeout — see resources/DatabaseTransaction.ts getReadTxn()).
 *
 * The #1411 fix aborts and poisons the transaction instead of force-committing it (both the
 * RocksDB and LMDB engines): addWrite()/commit() throw transactionOpenTooLongError once the
 * monitor has fired, so the request must roll back atomically instead of silently dropping half
 * its writes behind a 200.
 *
 * Oracle: drive the Handler resource (integrationTests/resources/txn-overtime-atomicity/resources.js)
 * with a hold long enough to guarantee the monitor fires between its two writes, then assert:
 *   (a) the request does NOT return a 2xx status, and
 *   (b) NEITHER the pre-await nor the post-await row was durably committed (true atomicity, not
 *       a partial drop).
 *
 * Skipped on Windows (restart_service http_workers crashes the Harper instance on Windows —
 * see HarperFast/harper#549), matching the other custom-resource integration suites.
 */
import { suite, test, before, after } from 'node:test';
import { ok, strictEqual } from 'node:assert/strict';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
// @ts-expect-error utils/client.mjs has no type declarations; runtime resolves fine
import { createApiClient } from '../apiTests/utils/client.mjs';

const FIXTURE_PATH = resolve(import.meta.dirname, 'txn-overtime-atomicity');
// Low threshold so a single held request crosses it quickly. The monitor fires ~2 ticks of this
// interval after the last write reset the timeout (see DESIGN.md "Over-time transactions are
// aborted, not force-committed").
const MAX_TXN_OPEN_MS = 500;
// Comfortably more than 2x the threshold so the monitor is guaranteed to have fired by the time
// the handler resumes and issues its second write.
const HOLD_MS = 3000;
const skipSuite = process.platform === 'win32';

suite('#1407/#1411 custom-resource handler over-time atomicity', { skip: skipSuite }, (ctx: ContextWithHarper) => {
	let client: ReturnType<typeof createApiClient>;
	let httpURL: string;

	before(async () => {
		await setupHarperWithFixture(ctx, FIXTURE_PATH, {
			config: {
				storage: { maxTransactionOpenTime: MAX_TXN_OPEN_MS, debugLongTransactions: true },
			},
			env: {},
		});
		client = createApiClient(ctx.harper);
		httpURL = ctx.harper.httpURL;

		// Readiness poll: workers register routes async (same pattern as sibling long-txn suites).
		const deadline = Date.now() + 30_000;
		while (Date.now() < deadline) {
			try {
				const probe = await fetch(`${httpURL}/Row/`, { headers: { Authorization: client.headers.Authorization } });
				if (probe.status !== 404) break;
			} catch {
				/* not ready */
			}
			await sleep(250);
		}
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	function getRow(id: string): Promise<Response> {
		return fetch(`${httpURL}/Row/${id}`, { headers: { Authorization: client.headers.Authorization } });
	}

	test(
		'aborts atomically: request is non-2xx and neither the pre- nor post-await write persists',
		{ timeout: 30_000 },
		async () => {
			const res = await fetch(`${httpURL}/Handler/`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', 'Authorization': client.headers.Authorization },
				body: JSON.stringify({ holdMs: HOLD_MS }),
			});
			const status = res.status;
			await res.text().catch(() => undefined); // drain the body regardless of outcome

			const preRes = await getRow('pre');
			const postRes = await getRow('post');

			console.log(
				`\n[#1407/#1411 atomicity] handler status=${status} preRowStatus=${preRes.status} postRowStatus=${postRes.status}`
			);

			ok(status < 200 || status >= 300, `expected a non-2xx response from the handler, got ${status}`);
			strictEqual(preRes.status, 404, 'pre-await write must not have been durably committed (atomicity)');
			strictEqual(postRes.status, 404, 'post-await write must not have been committed either (no partial drop)');
		}
	);
});
