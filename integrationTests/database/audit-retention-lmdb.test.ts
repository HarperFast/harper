/**
 * QA-746 / F-218 — LMDB audit-log retention: the self-re-arming cleanup loop must purge aged
 * audit entries passively, with no operator intervention.
 *
 * Coverage anchored: `engine=lmdb | retention=auditRetention | driver=passive-self-rearm`.
 * Nothing in the tracked suite drives audit retention end-to-end on LMDB — `audit-log-
 * completeness-prune.test.ts` covers the EXPLICIT prune op (`delete_transaction_logs_before`)
 * and its concurrency seam, never the automatic retention driver.
 *
 * Why this matters (source read at Harper `b8c843a24`, re-verified rather than assumed):
 *   - `resources/auditStore.ts:224-226` — `scheduleAuditCleanup()` runs once at store-open, on
 *     the last worker only, for BOTH engines.
 *   - `resources/auditStore.ts:174-222` — the LMDB branch arms a `setTimeout`, walks
 *     `auditStore.getRange({start: 1, end: <cutoff>})` deleting aged entries, and re-schedules
 *     ITSELF from its own `finally` (line 216), backing off when idle. That self-re-arm is the
 *     whole mechanism under test: if it ever stops re-arming, audit entries grow without bound
 *     and the only recovery is an explicit operator prune.
 *   - `resources/auditStore.ts:164-172` — the RocksDB branch calls `purgeLogs()` once and
 *     returns with no re-arm (F-218). That asymmetry is deliberately NOT asserted here; this
 *     file pins only the behavior that is correct today, so it stays green.
 *   - `resources/databases.ts:862` — `HARPER_STORAGE_ENGINE` wins over config, which is how the
 *     LMDB arm is selected (same mechanism as `eviction-secondary-index.test.ts`).
 *
 * Oracle: audit-record COUNT from `read_audit_log`, not a disk-only proxy. Test 1 is a positive
 * control proving the counter demonstrably moves UP on insert before test 2's "it came back
 * down" conclusion is trusted, and test 0 hard-asserts the engine actually in effect (via a
 * fixture resource reading `primaryStore.path`) so the suite cannot pass against RocksDB by
 * accident. `delete_transaction_logs_before` is never called — a passive wait is the point.
 *
 * Promoted from QA-746 (qa-explorer), snapshot P-529 arm (a).
 */
import { suite, test, before, after } from 'node:test';
import { ok } from 'node:assert';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import {
	setupHarperWithFixture,
	teardownHarper,
	sendOperation,
	type ContextWithHarper,
} from '@harperfast/integration-testing';

const FIXTURE_PATH = resolve(import.meta.dirname, 'audit-retention-lmdb');
const SCHEMA = 'data';
const TABLE = 'Ledger';
const skipSuite = process.platform === 'win32' || process.env.HARPER_RUNTIME === 'bun';

// Short so we can observe the (claimed) automatic paths within a bounded test window.
const AUDIT_RETENTION_SECONDS = 5;

function authHeader(ctx: ContextWithHarper): string {
	const { username, password } = ctx.harper.admin;
	return 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');
}

async function rawOp(ctx: ContextWithHarper, operation: any): Promise<{ status: number; body: any; text: string }> {
	const res = await fetch(ctx.harper.operationsAPIURL, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', 'Authorization': authHeader(ctx) },
		body: JSON.stringify(operation),
		signal: AbortSignal.timeout(60_000),
	});
	const text = await res.text();
	let body: any;
	try {
		body = JSON.parse(text);
	} catch {
		body = text;
	}
	return { status: res.status, body, text };
}

async function readAuditCount(ctx: ContextWithHarper): Promise<number> {
	const res = await sendOperation(ctx.harper, { operation: 'read_audit_log', schema: SCHEMA, table: TABLE });
	// An unexpected (non-array) response — an error body, a shape change, a transient failure —
	// must not silently read as "0 records": that would be indistinguishable from a genuinely
	// empty audit log and could satisfy test 2's "count came back down" assertion for the wrong
	// reason. Fail loudly instead of defaulting to a number that looks like success.
	if (!Array.isArray(res)) {
		throw new Error(`read_audit_log returned a non-array response, cannot compute a count: ${JSON.stringify(res).slice(0, 300)}`);
	}
	return res.reduce((n: number, e: any) => n + (Array.isArray(e?.records) ? e.records.length : 1), 0);
}

async function pollReadiness(ctx: ContextWithHarper): Promise<void> {
	const deadline = Date.now() + 60_000;
	while (Date.now() < deadline) {
		try {
			const res = await fetch(`${ctx.harper.httpURL}/${TABLE}/`, { headers: { Authorization: authHeader(ctx) } });
			if (res.status !== 404) return;
		} catch {
			/* not ready */
		}
		await sleep(250);
	}
	throw new Error('QA-746: Ledger route never became ready within 60s');
}

async function storageEngineGuess(ctx: ContextWithHarper): Promise<string> {
	const res = await fetch(`${ctx.harper.httpURL}/StorageEngineInfo/`, { headers: { Authorization: authHeader(ctx) } });
	const body = await res.json();
	return body.engineGuess;
}

const lmdbFindings: string[] = [];

// =====================================================================================
// ARM (a) — LMDB comparison: does the self-re-arming branch actually honor auditRetention
// end-to-end, with no operator intervention, within a bounded wait?
// =====================================================================================
suite(
	'QA-746 — LMDB audit retention: the self-re-arming cleanup loop purges passively',
	{ skip: skipSuite },
	(ctx: ContextWithHarper) => {
		before(async () => {
			await setupHarperWithFixture(ctx, FIXTURE_PATH, {
				config: {
					threads: { count: 1 },
					logging: { auditLog: true, auditRetention: AUDIT_RETENTION_SECONDS, console: true, level: 'info' },
				},
				env: { HARPER_STORAGE_ENGINE: 'lmdb' },
			});
			await pollReadiness(ctx);
		});

		after(async () => {
			await teardownHarper(ctx);
			// eslint-disable-next-line no-console
			console.log(
				`\n=== QA-746(a) LMDB findings (auditRetention=${AUDIT_RETENTION_SECONDS}s) ===\n${lmdbFindings.map((f) => '  ' + f).join('\n')}\n`
			);
		});

		test('0. precondition: engine in effect is LMDB (hard assert, not assumed)', async () => {
			const guess = await storageEngineGuess(ctx);
			lmdbFindings.push(`0. StorageEngineInfo.engineGuess=${guess}`);
			ok(guess === 'lmdb', `PRECONDITION: engine in effect must be lmdb, got ${guess}`);
		});

		test(
			'0.5. let the initial one-shot cleanup delay elapse before seeding the measured cohort',
			{ timeout: 20_000 },
			async () => {
				// scheduleAuditCleanup() is armed once at store-open with DEFAULT_AUDIT_CLEANUP_DELAY
				// (10s, auditStore.ts:113/225) before any self-re-arm has happened. If the measured
				// cohort below were inserted before that first callback fires, a single one-shot
				// invocation — with NO working recursive re-arm at all (auditStore.ts:216) — could
				// still sweep it once it ages past auditRetention, and this suite would stay green
				// while the self-re-arming loop is entirely broken. Wait out that initial delay (with
				// margin) first, so the cohort can only be inserted after at least one re-arm has
				// already had to occur, and its later disappearance can only be explained by the loop
				// continuing to re-arm itself.
				await sleep(11_000);
				lmdbFindings.push('0.5. waited out the initial one-shot cleanup delay window (11s)');
			}
		);

		test('1. positive control: read_audit_log count actually grows on insert', async () => {
			const before = await readAuditCount(ctx);
			const records = Array.from({ length: 200 }, (_, i) => ({ id: `k${i}`, seq: i, payload: 'p'.repeat(200) }));
			const r = await rawOp(ctx, { operation: 'insert', schema: SCHEMA, table: TABLE, records });
			ok(r.status === 200, `control insert should succeed, got ${r.status}: ${r.text.slice(0, 300)}`);
			const after = await readAuditCount(ctx);
			lmdbFindings.push(
				`1. POSITIVE CONTROL: readAuditCount ${before} -> ${after} (delta=${after - before}) after 200-record insert`
			);
			ok(
				after > before,
				`POSITIVE CONTROL FAILED: audit count did not grow on insert (${before} -> ${after}); oracle cannot be trusted`
			);
		});

		test(
			'2. main measurement: bounded passive wait, NO explicit prune call — does the count come back down?',
			{ timeout: 90_000 },
			async () => {
				const peak = await readAuditCount(ctx);
				lmdbFindings.push(`2. peak audit count before passive wait: ${peak}`);

				// Poll (never call delete_audit_logs_before) until the self-re-arming loop has had
				// several retention windows' worth of chances to sweep. auditRetention=5s; the loop's
				// own backoff (auditStore.ts:206-214) drops to ~500ms once idle, so this is generously
				// bounded relative to the mechanism's own cadence.
				const deadline = Date.now() + 45_000;
				let last = peak;
				let low = peak;
				while (Date.now() < deadline) {
					last = await readAuditCount(ctx);
					if (last < low) low = last;
					if (last <= peak - 200 || last === 0) break; // the 200 control records are gone
					await sleep(2000);
				}
				lmdbFindings.push(
					`2. after bounded passive wait (no explicit prune): peak=${peak} final=${last} lowestObserved=${low}`
				);

				ok(
					last <= peak - 200 || last === 0,
					`LMDB self-re-arming retention loop did NOT fully purge the measured 200-record cohort within the bounded wait: peak=${peak} final=${last} (expected <= ${peak - 200} or 0). ` +
						`If this fails, F-218's "RocksDB-specific" framing does not hold — LMDB fails too, which is a bigger/different finding.`
				);
				lmdbFindings.push(
					`2. VERDICT: LMDB's self-re-arming scheduleAuditCleanup branch (auditStore.ts:174-222) DID purge aged audit entries with no operator intervention, confirming the RocksDB gap is engine-specific.`
				);
			}
		);
	}
);
