/**
 * Full PUT replacement semantics across reordered timestamped writes, through HTTP and real storage.
 * Regression for https://github.com/HarperFast/harper/issues/3404.
 */
import { suite, test, before, after } from 'node:test';
import { deepStrictEqual, strictEqual } from 'node:assert';
import { resolve } from 'node:path';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
// @ts-expect-error client.mjs has no type declarations
import { createApiClient } from '../apiTests/utils/client.mjs';

suite('Out-of-order full PUT replacement', (ctx: ContextWithHarper) => {
	let httpURL: string;
	let authorization: string;

	before(async () => {
		await setupHarperWithFixture(ctx, resolve(import.meta.dirname, 'out-of-order-full-put'), {
			config: { threads: { count: 1 } },
			env: {},
		});
		httpURL = ctx.harper.httpURL;
		authorization = createApiClient(ctx.harper).headers.Authorization;
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	const orders = [
		[0, 1, 2],
		[0, 2, 1],
		[1, 0, 2],
		[1, 2, 0],
		[2, 0, 1],
		[2, 1, 0],
	];
	const writes = [
		{ method: 'put', value: { a: 'old', c: 'stale', counter: 10 } },
		{ method: 'put', value: { a: 'replacement' } },
		{ method: 'patch', value: { b: 'introduced', counter: { __op__: 'add', value: 5 } } },
	];
	for (const order of orders) {
		const id = order.join('-');
		const skip =
			process.env.HARPER_STORAGE_ENGINE === 'lmdb' && id === '2-0-1' ? 'LMDB version regression #3388' : false;
		test(`arrival ${id} yields the chronological replacement through REST GET`, { skip }, async () => {
			const timestamp = Date.now();
			for (const index of order) {
				const response = await fetch(`${httpURL}/ApplyWrite/`, {
					method: 'POST',
					signal: AbortSignal.timeout(10_000),
					headers: { 'Content-Type': 'application/json', 'Authorization': authorization },
					body: JSON.stringify({ id, ...writes[index], timestamp: timestamp + index }),
				});
				strictEqual(response.status, 200, await response.text());
			}
			const response = await fetch(`${httpURL}/Item/${id}`, {
				headers: { Authorization: authorization },
				signal: AbortSignal.timeout(10_000),
			});
			strictEqual(response.status, 200);
			deepStrictEqual(await response.json(), { id, a: 'replacement', b: 'introduced', counter: 5 }, id);
		});
	}
});
