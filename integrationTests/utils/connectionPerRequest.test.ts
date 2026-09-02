/**
 * Pins the contract of `./connectionPerRequest.ts` against a local `node:http` server: one TCP
 * connection per call, caller headers preserved and unmutated, and the worker-coverage loop's
 * concurrency, budget and failure modes. The distinct-connection assertion is what goes red if the
 * helper ever degrades to a plain `fetch()`.
 */
import { suite, test, before, after } from 'node:test';
import { deepStrictEqual, ok, rejects, strictEqual } from 'node:assert';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { fetchOnNewConnection, observeEveryWorker } from './connectionPerRequest.ts';

interface Echo {
	connection: number;
	headers: Record<string, string | string[] | undefined>;
}

function listen(server: http.Server): Promise<string> {
	return new Promise((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`));
	});
}

function close(server: http.Server): Promise<void> {
	return new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
}

suite('connection-per-request load helpers', () => {
	let server: http.Server;
	let base: string;
	let connections = 0;

	before(async () => {
		server = http.createServer((req, res) => {
			res.setHeader('Content-Type', 'application/json');
			res.end(
				JSON.stringify({ connection: (req.socket as { connectionId?: number }).connectionId, headers: req.headers })
			);
		});
		server.on('connection', (socket) => {
			(socket as { connectionId?: number }).connectionId = ++connections;
		});
		base = await listen(server);
	});

	after(async () => {
		await close(server);
	});

	async function echo(response: Response): Promise<Echo> {
		return (await response.json()) as Echo;
	}

	test('every call lands on its own connection', async () => {
		const fresh: number[] = [];
		for (let i = 0; i < 8; i++) fresh.push((await echo(await fetchOnNewConnection(`${base}/x`))).connection);
		strictEqual(new Set(fresh).size, 8, `expected 8 distinct connections, saw ${JSON.stringify(fresh)}`);
	});

	test('plain fetch reuses connections, which is the whole reason this helper exists', async () => {
		// Its own origin: on Node 24.10-25.6 a single Connection: close request permanently stops
		// undici reusing connections to that origin, so measuring this against a server the other
		// tests have already closed connections on would assert the helper into looking redundant.
		const cleanServer = http.createServer((req, res) =>
			res.end(JSON.stringify({ connection: (req.socket as { connectionId?: number }).connectionId }))
		);
		let opened = 0;
		cleanServer.on('connection', (socket) => {
			(socket as { connectionId?: number }).connectionId = ++opened;
		});
		const cleanBase = await listen(cleanServer);
		try {
			const reused: number[] = [];
			for (let i = 0; i < 8; i++) reused.push((await echo(await fetch(`${cleanBase}/x`))).connection);
			ok(
				new Set(reused).size < 8,
				`plain fetch is expected to reuse connections — if it stops doing so this helper is obsolete, saw ${JSON.stringify(reused)}`
			);
		} finally {
			await close(cleanServer);
		}
	});

	test('caller headers survive in every accepted form', async () => {
		const asObject = await echo(await fetchOnNewConnection(`${base}/x`, { headers: { Authorization: 'Basic aaa' } }));
		strictEqual(asObject.headers.authorization, 'Basic aaa');
		strictEqual(asObject.headers.connection, 'close');

		const asHeaders = await echo(
			await fetchOnNewConnection(`${base}/x`, { headers: new Headers({ Authorization: 'Basic bbb' }) })
		);
		strictEqual(asHeaders.headers.authorization, 'Basic bbb');
		strictEqual(asHeaders.headers.connection, 'close');

		const asTuples = await echo(await fetchOnNewConnection(`${base}/x`, { headers: [['Authorization', 'Basic ccc']] }));
		strictEqual(asTuples.headers.authorization, 'Basic ccc');
		strictEqual(asTuples.headers.connection, 'close');
	});

	test('a caller-supplied keep-alive is overridden, and caller headers are not mutated', async () => {
		const callerObject = { Authorization: 'Basic ddd', connection: 'keep-alive' };
		const fromObject = await echo(await fetchOnNewConnection(`${base}/x`, { headers: callerObject }));
		strictEqual(fromObject.headers.connection, 'close');
		deepStrictEqual(callerObject, { Authorization: 'Basic ddd', connection: 'keep-alive' });

		const callerHeaders = new Headers({ Authorization: 'Basic eee' });
		await fetchOnNewConnection(`${base}/x`, { headers: callerHeaders });
		strictEqual(callerHeaders.get('connection'), null);
	});

	test('the request body and method are passed through', async () => {
		const seen: string[] = [];
		const bodyServer = http.createServer((req, res) => {
			let body = '';
			req.on('data', (chunk) => (body += chunk));
			req.on('end', () => {
				seen.push(`${req.method} ${body}`);
				res.end('{}');
			});
		});
		const url = `${await listen(bodyServer)}/x`;
		try {
			await fetchOnNewConnection(url, { method: 'PUT', body: JSON.stringify({ a: 1 }) });
			deepStrictEqual(seen, ['PUT {"a":1}']);
		} finally {
			await close(bodyServer);
		}
	});

	test('observeEveryWorker returns every response it gathered while covering all workers', async () => {
		const sequence = [3, 3, 1, 2, 4, 4, 4, 4];
		let next = 0;
		const responses = await observeEveryWorker(
			async () => ({ worker: sequence[next], seq: next++ }),
			(r) => r.worker,
			{ workerCount: 4 }
		);
		deepStrictEqual(
			responses.map((r) => r.seq),
			[0, 1, 2, 3, 4, 5, 6, 7],
			'callers assert over the whole result, so nothing observed may be discarded'
		);
		deepStrictEqual([...new Set(responses.map((r) => r.worker))].sort(), [1, 2, 3, 4]);
	});

	test('observeEveryWorker issues each round concurrently, not one request at a time', async () => {
		let inFlight = 0;
		let peak = 0;
		let issued = 0;
		await observeEveryWorker(
			async () => {
				peak = Math.max(peak, ++inFlight);
				await new Promise((resolve) => setTimeout(resolve, 5));
				inFlight--;
				return { worker: ++issued };
			},
			(r) => r.worker,
			{ workerCount: 4 }
		);
		strictEqual(peak, 4, 'a serialized loop would widen the window between a write ack and the last read');
	});

	test('observeEveryWorker fails, naming what it reached, when a worker never answers', async () => {
		let requests = 0;
		await rejects(
			() =>
				observeEveryWorker(
					async () => {
						requests++;
						return { worker: 1 };
					},
					(r) => r.worker,
					{ workerCount: 3 }
				),
			/reached 1 of 3 workers in 96 requests \(saw \[1\]\)/
		);
		strictEqual(requests, 96, 'must give up on a request budget, not spin against the instance until a deadline');
	});

	test('observeEveryWorker gives up on a request that never settles', async () => {
		await rejects(
			() =>
				observeEveryWorker(
					() => new Promise<{ worker: number }>(() => {}),
					(r) => r.worker,
					{
						workerCount: 2,
						timeoutMs: 150,
					}
				),
			/did not settle within 1[0-9]{2}ms/
		);
	});

	test('observeEveryWorker rejects a response with no worker id rather than looping on it', async () => {
		await rejects(
			() =>
				observeEveryWorker(
					async () => ({ worker: undefined as unknown as number }),
					(r) => r.worker,
					{
						workerCount: 2,
					}
				),
			/carried no worker id/
		);
	});
});
