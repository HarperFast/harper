/**
 * PR #562: native TypeStrip CLI and worker startup serve real REST reads and writes,
 * with the same compiled CommonJS behavior.
 */
import { suite, test, before, after } from 'node:test';
import { deepStrictEqual, strictEqual, ok } from 'node:assert';
import { resolve } from 'node:path';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';

for (const mode of ['compiled', 'typestrip']) {
	suite(`REST workers (${mode})`, (ctx: ContextWithHarper) => {
		before(async () => {
			await setupHarperWithFixture(ctx, resolve(import.meta.dirname, 'typestrip'), {
				config: { threads: { count: 2 } },
				env: mode === 'typestrip' ? { NODE_OPTIONS: '--conditions=typestrip' } : {},
				harperBinPath: resolve(
					import.meta.dirname,
					`../../${mode === 'typestrip' ? 'bin/harper.ts' : 'dist/bin/harper.js'}`
				),
			});
		});
		after(async () => {
			await teardownHarper(ctx);
		});

		test('serves requests in workers and persists a REST record', async () => {
			const headers = {
				'Authorization': `Basic ${Buffer.from(`${ctx.harper.admin.username}:${ctx.harper.admin.password}`).toString('base64')}`,
				'Content-Type': 'application/json',
			};
			const request = (path: string, options = {}) =>
				fetch(`${ctx.harper.httpURL}${path}`, {
					...options,
					headers,
					signal: AbortSignal.timeout(10000),
				});
			const runtime = await request('/Runtime/');
			strictEqual(runtime.status, 200);
			const info = await runtime.json();
			strictEqual(info.isMainThread, false);
			ok(info.threadId > 0);
			ok(info.workerIndex === 0 || info.workerIndex === 1);
			strictEqual(info.noServerStart, false);
			const record = { id: 'source-execution', value: mode };
			const write = await request('/Probe/source-execution', { method: 'PUT', body: JSON.stringify(record) });
			strictEqual(write.status, 204);
			const read = await request('/Probe/source-execution');
			strictEqual(read.status, 200);
			deepStrictEqual(await read.json(), record);
		});
	});
}
