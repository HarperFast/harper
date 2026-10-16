import { suite, test, before, after } from 'node:test';
import assert from 'node:assert';
import { resolve } from 'node:path';
import { setupHarperWithFixture, teardownHarper } from '@harperfast/integration-testing';

for (const nativeBun of process.env.HARPER_RUNTIME === 'bun' ? [false, true] : [false]) {
	suite(`HTTP read request queue (#2755)${nativeBun ? ' (Bun.serve)' : ''}`, (ctx: any) => {
		before(async () => {
			await setupHarperWithFixture(ctx, resolve(import.meta.dirname, 'fixtures/request-queue'), {
				config: {
					http: {
						readRequestQueueLimit: 1,
						requestQueueLimit: 0,
						cors: true,
						corsAccessControlAllowHeaders: 'Accept, Content-Type, Authorization',
						corsAccessList: ['https://queue.example'],
						securityHeaders: { 'X-Queue-Test': 'present' },
						...(nativeBun ? { webSocket: false } : {}),
					},
					...(nativeBun ? { mqtt: { webSocket: false } } : {}),
					threads: { count: 1 },
				},
			});
		});
		after(async () => {
			await teardownHarper(ctx);
		});

		test('sheds a GET burst with 503 and serves reads after the queue drains', { timeout: 30_000 }, async () => {
			const url = ctx.harper.httpURL + '/QueueWork/1';
			const send = async () => {
				const response = await fetch(url, {
					headers: { Origin: 'https://queue.example' },
					signal: AbortSignal.timeout(15_000),
				});
				return {
					status: response.status,
					body: await response.text(),
					origin: response.headers.get('Access-Control-Allow-Origin'),
					configured: response.headers.get('X-Queue-Test'),
				};
			};
			const firstWave = Array.from({ length: 64 }, send);
			await Promise.race(firstWave);
			const responses = await Promise.all([...firstWave, ...Array.from({ length: 64 }, send)]);
			assert(responses.some((response) => response.status === 200));
			const rejected = responses.filter((response) => response.status === 503);
			assert(rejected.length > 0, 'expected the configured read queue limit to shed GET requests');
			for (const response of rejected) {
				assert.equal(response.body, 'Service unavailable, exceeded request queue limit');
				assert.equal(response.origin, 'https://queue.example');
				assert.equal(response.configured, 'present');
			}
			for (const response of responses) assert([200, 503].includes(response.status));
			const recovered = await fetch(url, { signal: AbortSignal.timeout(5000) });
			assert.equal(recovered.status, 200);
			assert.deepEqual(await recovered.json(), { ok: true });
		});

		test('preserves write admission on each runtime', { timeout: 30_000 }, async () => {
			const send = async () => {
				const response = await fetch(ctx.harper.httpURL + '/QueueWork/', {
					method: 'POST',
					body: '{}',
					headers: { 'Content-Type': 'application/json' },
					signal: AbortSignal.timeout(15_000),
				});
				await response.text();
				return response.status;
			};
			const firstWave = Array.from({ length: 64 }, send);
			await Promise.race(firstWave);
			const statuses = await Promise.all([...firstWave, ...Array.from({ length: 64 }, send)]);
			assert(statuses.some((status) => status >= 200 && status < 300));
			if (nativeBun) assert(statuses.every((status) => status >= 200 && status < 300));
			else assert(statuses.includes(503), 'expected the existing write queue to shed POST requests');
			for (const status of statuses) assert((status >= 200 && status < 300) || status === 503);
		});
	});
}
