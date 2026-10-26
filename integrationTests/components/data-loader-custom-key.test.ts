/**
 * The data loader tracks a table's records by its own primary key, so with a custom key a restart
 * neither overwrites a user's edit (each load used to put() every record back) nor stops applying
 * data file changes.
 *
 * Reproduction:
 *   npm run test:integration -- "integrationTests/components/data-loader-custom-key.test.ts"
 */
import { suite, test, before, after } from 'node:test';
import { ok, strictEqual } from 'node:assert';
import { resolve, join, basename } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import {
	setupHarperWithFixture,
	startHarper,
	killHarper,
	teardownHarper,
	type ContextWithHarper,
} from '@harperfast/integration-testing';

const FIXTURE_PATH = resolve(import.meta.dirname, 'fixtures/data-loader-custom-key');

suite('data loader with a custom primary key', (ctx: ContextWithHarper) => {
	let authorization: string;

	before(async () => {
		await setupHarperWithFixture(ctx, FIXTURE_PATH);
		authorization = `Basic ${Buffer.from(`${ctx.harper.admin.username}:${ctx.harper.admin.password}`).toString('base64')}`;
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	// The loader runs on the primary worker after startup, so wait for the expected state
	async function waitForProduct(sku: string, matches: (product: any) => boolean) {
		const deadline = Date.now() + 30_000;
		let product: any;
		while (Date.now() < deadline) {
			const response = await fetch(`${ctx.harper.httpURL}/DataLoaderProduct/${sku}`, { headers: { authorization } });
			product = response.status === 200 ? await response.json() : undefined;
			if (product && matches(product)) return product;
			await delay(200);
		}
		throw new Error(`Timed out waiting for ${sku}; last read ${JSON.stringify(product)}`);
	}

	test('keeps a user edit across a restart and applies a data file change', async () => {
		await waitForProduct('SKU-1', (product) => product.price === 10);
		const patch = await fetch(`${ctx.harper.httpURL}/DataLoaderProduct/SKU-1`, {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json', authorization },
			body: JSON.stringify({ price: 99, note: 'user edit' }),
		});
		ok(patch.status === 200 || patch.status === 204, `PATCH: ${patch.status} ${await patch.text()}`);

		await killHarper(ctx);
		await writeFile(
			join(ctx.harper.dataRootDir, 'components', basename(FIXTURE_PATH), 'data', 'products.json'),
			JSON.stringify({
				table: 'DataLoaderProduct',
				records: [
					{ sku: 'SKU-1', name: 'One', price: 10 },
					{ sku: 'SKU-2', name: 'Two', price: 21 },
				],
			})
		);
		await startHarper(ctx);

		await waitForProduct('SKU-2', (product) => product.price === 21);
		const edited = await waitForProduct('SKU-1', () => true);
		strictEqual(edited.price, 99);
		strictEqual(edited.note, 'user edit');
	});
});
