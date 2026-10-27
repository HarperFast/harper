/**
 * Concurrent CRDT `add` PATCHes to one record on LMDB with several worker threads must all apply.
 *
 * Each worker minted transaction times from its own clock, so two workers could commit the same record at
 * the same time. LMDB keys its audit log by that time, and the audit walk took the second write for a
 * re-delivery of the first: it was skipped while its request still answered 204, losing one delta.
 *
 *   npm run test:integration -- "integrationTests/database/lmdb-concurrent-crdt-add.test.ts"
 *   LMDB_CRDT_ADD_ROUNDS=200 … to run more rounds
 */
import { suite, test, before, after } from 'node:test';
import { deepStrictEqual, ok } from 'node:assert';
import { request } from 'node:http';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';

const FIXTURE_PATH = resolve(import.meta.dirname, 'lmdb-concurrent-crdt-add');
const ROUNDS = Number(process.env.LMDB_CRDT_ADD_ROUNDS) || 20;
const PATCHES_PER_ROUND = 400;
const CONCURRENCY = 32;
const DELTAS = [1, 2, 0, -1];

// One connection per request, so the kernel spreads the requests over every worker's listener.
function send(url: string, method: string, auth: string, body?: unknown): Promise<{ status: number; body: string }> {
	return new Promise((resolvePromise, reject) => {
		const payload = body === undefined ? undefined : JSON.stringify(body);
		const req = request(
			url,
			{
				method,
				agent: false,
				timeout: 30_000,
				headers: {
					Authorization: auth,
					...(payload === undefined
						? {}
						: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }),
				},
			},
			(res) => {
				let text = '';
				res.setEncoding('utf8');
				res.on('data', (chunk) => (text += chunk));
				res.on('end', () => resolvePromise({ status: res.statusCode ?? 0, body: text }));
				res.on('error', reject);
			}
		);
		req.on('timeout', () => req.destroy(new Error(`${method} ${url} timed out`)));
		req.on('error', reject);
		req.end(payload);
	});
}

async function inParallel(count: number, concurrency: number, task: (index: number) => Promise<void>) {
	let next = 0;
	await Promise.all(
		Array.from({ length: concurrency }, async () => {
			while (next < count) await task(next++);
		})
	);
}

suite(
	'LMDB concurrent CRDT add across worker threads',
	{ skip: process.platform !== 'linux' },
	(ctx: ContextWithHarper) => {
		let httpURL: string;
		let auth: string;

		before(async () => {
			await setupHarperWithFixture(ctx, FIXTURE_PATH, {
				config: { threads: { count: 4 } },
				env: { HARPER_STORAGE_ENGINE: 'lmdb' },
			});
			httpURL = ctx.harper.httpURL;
			const { username, password } = ctx.harper.admin;
			auth = 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');
			const deadline = Date.now() + 60_000;
			for (;;) {
				const probe = await send(`${httpURL}/WorkerThread/`, 'GET', auth).catch(() => undefined);
				if (probe?.status === 200) break;
				if (Date.now() > deadline) throw new Error('the WorkerThread route never became ready');
				await sleep(250);
			}
		});

		after(async () => {
			await teardownHarper(ctx);
		});

		test('requests reach more than one worker thread', async () => {
			const threads = new Set<number>();
			await inParallel(64, 16, async () => {
				const response = await send(`${httpURL}/WorkerThread/`, 'GET', auth);
				threads.add(JSON.parse(response.body).threadId);
			});
			ok(threads.size > 1, `all requests were served by thread ${[...threads]}`);
		});

		test(`${ROUNDS} rounds of ${PATCHES_PER_ROUND} concurrent add PATCHes each sum exactly`, async () => {
			const expected = (PATCHES_PER_ROUND / DELTAS.length) * DELTAS.reduce((sum, delta) => sum + delta, 0);
			const wrongRounds: string[] = [];
			for (let round = 0; round < ROUNDS; round++) {
				const url = `${httpURL}/Counter/round-${Date.now()}-${round}`;
				const created = await send(url, 'PUT', auth, { n: 0 });
				ok(created.status >= 200 && created.status < 300, `PUT answered ${created.status}: ${created.body}`);
				const failed: string[] = [];
				await inParallel(PATCHES_PER_ROUND, CONCURRENCY, async (index) => {
					const value = DELTAS[index % DELTAS.length];
					const response = await send(url, 'PATCH', auth, { n: { __op__: 'add', value } });
					if (response.status < 200 || response.status >= 300) failed.push(`${response.status} ${response.body}`);
				});
				deepStrictEqual(failed, [], `round ${round}: PATCHes failed`);
				const record = await send(url, 'GET', auth);
				const n = JSON.parse(record.body).n;
				if (n !== expected) wrongRounds.push(`round ${round}: n=${n}`);
			}
			deepStrictEqual(wrongRounds, [], `expected n=${expected} after every round`);
		});
	}
);
