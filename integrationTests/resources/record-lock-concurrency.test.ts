/**
 * Exclusive record locks across worker threads (harper#483, Phase 0).
 *
 * With 4 HTTP workers, concurrent `tables.Counter.lock(id)` callers must admit exactly one holder at a
 * time: every increment lands (exact count) and the holder intervals never overlap, with holders spread
 * over more than one thread. A plain write to a record another party holds waits for the release, and
 * a holder that never releases loses the lock at the end of its lease while the record and its value
 * survive.
 *
 * Fails-on-base proof: `RECORD_LOCK_CONTROL=1` runs the same increment burst through the fixture's
 * per-worker mutex (`mode: 'worker-mutex'`), the shape a per-worker-only lock has — the serialization
 * and exact-count assertions go red there because workers do not see each other's holders.
 *
 * Repro:
 *   npm run test:integration -- "integrationTests/resources/record-lock-concurrency.test.ts"
 */
import { suite, test, before, after } from 'node:test';
import { ok, strictEqual } from 'node:assert';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
// @ts-expect-error utils/client.mjs has no type declarations
import { createApiClient } from '../apiTests/utils/client.mjs';

const FIXTURE_PATH = resolve(import.meta.dirname, 'record-lock-concurrency');
const WORKERS = 4;
const CONTROL = process.env.RECORD_LOCK_CONTROL === '1';

const skipSuite = process.platform === 'win32' || process.env.HARPER_RUNTIME === 'bun';

type Interval = { id: string; start: number; end: number; worker: number; mode: string };

suite(`record locks serialize across ${WORKERS} workers`, { skip: skipSuite }, (ctx: ContextWithHarper) => {
	let httpURL: string;
	let auth: string;

	before(async () => {
		await setupHarperWithFixture(ctx, FIXTURE_PATH, {
			config: { threads: { count: WORKERS } },
			env: {},
		});
		const client = createApiClient(ctx.harper);
		httpURL = ctx.harper.httpURL;
		auth = client.headers.Authorization;
		const deadline = Date.now() + 30_000;
		while (Date.now() < deadline) {
			try {
				const response = await fetch(`${httpURL}/Counter/`, {
					headers: { Authorization: auth },
					signal: AbortSignal.timeout(3_000),
				});
				if (response.status !== 503) break;
			} catch {
				// not ready
			}
			await sleep(200);
		}
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	const headers = () => ({ 'Content-Type': 'application/json', 'Authorization': auth });

	async function post(path: string, body: object, timeoutMs = 20_000) {
		const response = await fetch(`${httpURL}/${path}/`, {
			method: 'POST',
			headers: headers(),
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(timeoutMs),
		});
		const text = await response.text();
		let json: any;
		try {
			json = JSON.parse(text);
		} catch {
			json = text;
		}
		return { status: response.status, body: json };
	}

	async function get(id: string) {
		const response = await fetch(`${httpURL}/Counter/${id}`, {
			headers: { Authorization: auth },
			signal: AbortSignal.timeout(5_000),
		});
		return { status: response.status, body: response.status === 200 ? await response.json() : null };
	}

	async function put(id: string, record: object) {
		const started = Date.now();
		const response = await fetch(`${httpURL}/Counter/${id}`, {
			method: 'PUT',
			headers: headers(),
			body: JSON.stringify({ id, ...record }),
			signal: AbortSignal.timeout(20_000),
		});
		return { status: response.status, elapsed: Date.now() - started };
	}

	test(`${CONTROL ? '(control: per-worker mutex) ' : ''}concurrent lock+increment: exact count, non-overlapping holders on more than one thread`, async () => {
		const id = CONTROL ? 'burst-control' : 'burst';
		const N = 64;
		const mode = CONTROL ? 'worker-mutex' : 'record-lock';
		const results = await Promise.all(Array.from({ length: N }, () => post('LockedIncrement', { id, mode })));
		const failed = results.filter((result) => result.status !== 200);
		strictEqual(failed.length, 0, `every increment succeeded: ${JSON.stringify(failed.slice(0, 3))}`);
		const intervals: Interval[] = results.map((result) => result.body);
		const workers = new Set(intervals.map((interval) => interval.worker));
		ok(workers.size > 1, `holders came from more than one worker thread (${[...workers].join(',')})`);

		const stored = await get(id);
		strictEqual(stored.body?.n, N, `all ${N} increments landed (stored ${stored.body?.n})`);

		intervals.sort((a, b) => a.start - b.start || a.end - b.end);
		const overlaps: string[] = [];
		for (let i = 1; i < intervals.length; i++) {
			if (intervals[i - 1].end > intervals[i].start)
				overlaps.push(`${JSON.stringify(intervals[i - 1])} overlaps ${JSON.stringify(intervals[i])}`);
		}
		strictEqual(overlaps.length, 0, `holder intervals never overlap:\n${overlaps.slice(0, 5).join('\n')}`);
	});

	test('a plain write to a held record waits for the release; an abandoned holder expires with the record intact', async () => {
		const id = 'held';
		const seeded = await put(id, { n: 1, holders: 0 });
		ok(seeded.status === 200 || seeded.status === 204, `seeded (${seeded.status})`);
		const LEASE = 1_500;
		const held = await post('LockHold', { id, lease: LEASE });
		strictEqual(held.status, 200, `held: ${JSON.stringify(held.body)}`);
		ok(held.body.lockVersion > 0, 'the lock generation is on the record');

		const write = await put(id, { n: 2, holders: 1 });
		ok(write.status === 200 || write.status === 204, `the write landed (${write.status})`);
		ok(Date.now() >= held.body.lockExpiresAt, `the write landed no earlier than the lease end (${write.elapsed}ms)`);
		ok(write.elapsed < LEASE + 5_000, 'and proceeded promptly after it');

		const after = await get(id);
		strictEqual(after.status, 200, 'the record survived the abandoned lock');
		strictEqual(after.body.n, 2, 'and carries the delayed write');
	});

	test('a lock attempt on a held record fails with 423 at its timeout', async () => {
		const id = 'timeout';
		await put(id, { n: 0, holders: 0 });
		const held = await post('LockHold', { id, lease: 3_000 });
		strictEqual(held.status, 200);
		const attempt = await post('LockedIncrement', { id, timeout: 300 });
		strictEqual(attempt.status, 423, `locked: ${JSON.stringify(attempt.body)}`);
	});
});
