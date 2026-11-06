/**
 * A caught-up native HNSW index admits writes after its database has been idle for longer than the
 * index's lag budget. The fixture's 2 s budget (`maxLagMilliseconds`) keeps the idle period short.
 */
import { suite, test, before, after } from 'node:test';
import { ok } from 'node:assert';
import { setTimeout as sleep } from 'node:timers/promises';
import { resolve } from 'node:path';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
import { waitFor } from '../../unitTests/waitFor.js';

const vectorOf = (id: number) => Array.from({ length: 8 }, (_, i) => Math.sin(id * 7 + i * 3 + 1));

suite('derived-index admission after an idle period', (ctx: ContextWithHarper) => {
	async function request(path: string, method: string, body: unknown) {
		const response = await fetch(`${ctx.harper.httpURL}${path}`, {
			method,
			headers: {
				'Authorization': `Basic ${Buffer.from(`${ctx.harper.admin.username}:${ctx.harper.admin.password}`).toString('base64')}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(30_000),
		});
		const text = await response.text();
		return { status: response.status, text };
	}

	// strict coverage, so a match proves the index durable through every committed write; 503 while it builds
	async function nearestCurrent(id: number) {
		const { status, text } = await request('/IdleVector/', 'QUERY', {
			sort: {
				attribute: 'vector',
				target: vectorOf(id),
				distance: 'cosine',
				maxIndexLagMilliseconds: 0,
				waitForIndexMilliseconds: 20_000,
			},
			select: ['id'],
			limit: 1,
		});
		if (status === 503) return undefined;
		ok(status === 200, `${status} ${text}`);
		return JSON.parse(text)[0]?.id;
	}

	before(async () => {
		await setupHarperWithFixture(ctx, resolve(import.meta.dirname, 'derived-index-idle-admission'), {
			config: { threads: { count: 1 }, logging: { level: 'warn' } },
			env: { HARPER_STORAGE_ENGINE: 'rocksdb' },
			harperBinPath: resolve('dist/bin/harper.js'),
		});
	});

	after(async () => teardownHarper(ctx));

	test('writes after an idle period longer than the lag budget are admitted', async () => {
		const warm = await request('/IdleVector/1', 'PUT', { id: 1, vector: vectorOf(1) });
		ok(warm.status < 300, warm.text);
		await waitFor(async () => (await nearestCurrent(1)) === 1, 30_000);
		// models elapsed idle time past the budget; nothing commits meanwhile
		await sleep(3_000);
		const statuses = [(await request('/IdleOther/1', 'PUT', { id: 1, name: 'first after idle' })).status];
		for (let id = 2; id <= 6; id++)
			statuses.push((await request(`/IdleVector/${id}`, 'PUT', { id, vector: vectorOf(id) })).status);
		ok(
			statuses.every((status) => status < 300),
			`a caught-up index must not shed writes: ${statuses}`
		);
		await waitFor(async () => (await nearestCurrent(6)) === 6, 30_000);
	});
});
