import { suite, test, before, after } from 'node:test';
import { deepStrictEqual, strictEqual } from 'node:assert';
import { resolve } from 'node:path';
import { Client } from 'undici';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
// @ts-expect-error no type declarations
import { createApiClient } from '../apiTests/utils/client.mjs';
import { NO_FULL_WORKER_COVERAGE } from './recordCachingWorkers.ts';

const FIXTURE_PATH = resolve(import.meta.dirname, 'rocksdb-concurrent-patch-reconciliation');
const DOC_COUNT = 20;
const WRITES_PER_KIND = 10;
const CONNECTIONS_PER_WORKER = 16;
const DOC_IDS = Array.from({ length: DOC_COUNT }, (_, index) => `doc${index}`);

interface VerifiedDoc {
	id: string;
	stored: { title: string; hits: number; meta: { n: number }; tags: string[] };
	newestWriter?: { meta: { n: number }; tags: string[] };
	newestUpdaterTitle?: string;
}

async function post(client: Client, path: string, auth: string, body?: unknown): Promise<any> {
	const response = await client.request({
		path,
		method: body === undefined ? 'GET' : 'POST',
		headers: { 'content-type': 'application/json', 'accept': 'application/json', 'authorization': auth },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const text = await response.body.text();
	if (response.statusCode !== 200) throw new Error(`${path} returned ${response.statusCode}: ${text}`);
	return JSON.parse(text);
}

async function connectToEveryWorker(httpURL: string, auth: string, workerCount: number): Promise<Client[]> {
	const byWorker = new Map<number, Client[]>();
	const spare: Client[] = [];
	const full = () =>
		byWorker.size === workerCount && [...byWorker.values()].every((list) => list.length === CONNECTIONS_PER_WORKER);
	for (let attempt = 0; attempt < workerCount * CONNECTIONS_PER_WORKER * 16 && !full(); attempt++) {
		const client = new Client(httpURL, { pipelining: 1, keepAliveTimeout: 120_000 });
		const { threadId } = await post(client, '/Probe/', auth);
		let list = byWorker.get(threadId);
		if (!list) byWorker.set(threadId, (list = []));
		(list.length < CONNECTIONS_PER_WORKER ? list : spare).push(client);
	}
	await Promise.all(spare.map((client) => client.close()));
	strictEqual(full(), true, `connections reached ${byWorker.size} of ${workerCount} workers`);
	const lists = [...byWorker.values()];
	const clients: Client[] = [];
	for (let index = 0; index < CONNECTIONS_PER_WORKER; index++) {
		for (const list of lists) clients.push(list[index]);
	}
	return clients;
}

async function runRounds(clients: Client[], auth: string, updater: string, rounds: number): Promise<string[]> {
	const losses: string[] = [];
	for (let round = 0; round < rounds; round++) {
		const { seededAt } = await post(clients[0], '/Seed/', auth, { ids: DOC_IDS });
		const requests: Promise<unknown>[] = [];
		let next = 0;
		const send = (path: string, body: unknown) =>
			requests.push(post(clients[next++ % clients.length], path, auth, body));
		for (const [index, id] of DOC_IDS.entries()) {
			for (let step = 0; step < WRITES_PER_KIND; step++) {
				const seq = (round * DOC_COUNT + index) * WRITES_PER_KIND + step + 1;
				send(updater, { id, seq });
				send('/Writer/', { id, seq });
			}
		}
		await Promise.all(requests);
		const docs: VerifiedDoc[] = await post(clients[0], '/Verify/', auth, { ids: DOC_IDS, seededAt });
		for (const { id, stored, newestWriter, newestUpdaterTitle } of docs) {
			if (
				stored.hits !== WRITES_PER_KIND ||
				stored.meta?.n !== newestWriter?.meta.n ||
				stored.tags?.[0] !== newestWriter?.tags[0] ||
				stored.title !== newestUpdaterTitle
			)
				losses.push(
					`round ${round} ${id}: stored ${JSON.stringify(stored)}, expected hits ${WRITES_PER_KIND}, ` +
						`writer ${JSON.stringify(newestWriter)}, title ${newestUpdaterTitle}`
				);
		}
	}
	return losses;
}

function concurrentPatchSuite(workerCount: number, arms: Array<{ updater: string; rounds: number }>) {
	return (ctx: ContextWithHarper) => {
		let clients: Client[] = [];
		let auth: string;

		before(async () => {
			await setupHarperWithFixture(ctx, FIXTURE_PATH, {
				config: { storage: { engine: 'rocksdb' }, threads: { count: workerCount } },
			});
			auth = createApiClient(ctx.harper).headers.Authorization;
			clients = await connectToEveryWorker(ctx.harper.httpURL, auth, workerCount);
		});

		after(async () => {
			if (clients) await Promise.all(clients.map((client) => client.close()));
			await teardownHarper(ctx);
		});

		for (const { updater, rounds } of arms) {
			test(`${rounds} rounds of ${updater} updates racing patches keep every write`, async () => {
				const losses = await runRounds(clients, auth, updater, rounds);
				deepStrictEqual(losses.slice(0, 5), [], `${losses.length} of ${rounds * DOC_COUNT} records lost a write`);
			});
		}
	};
}

suite(
	'concurrent patch reconciliation on RocksDB, 4 workers',
	{ skip: NO_FULL_WORKER_COVERAGE },
	concurrentPatchSuite(4, [
		{ updater: '/Updater/', rounds: 100 },
		{ updater: '/ReadThenUpdater/', rounds: 30 },
	])
);

suite(
	'concurrent patch reconciliation on RocksDB, 1 worker',
	concurrentPatchSuite(1, [{ updater: '/Updater/', rounds: 5 }])
);
