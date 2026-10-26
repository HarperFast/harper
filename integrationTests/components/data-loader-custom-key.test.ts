/**
 * Each load used to put() every record of a table with a custom primary key back over the stored one,
 * so a restart reverted user edits.
 *
 * Reproduction:
 *   npm run test:integration -- "integrationTests/components/data-loader-custom-key.test.ts"
 */
import { suite, test, before, after } from 'node:test';
import { ok, strictEqual } from 'node:assert';
import { resolve, join, basename } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import {
	setupHarperWithFixture,
	startHarper,
	killHarper,
	teardownHarper,
	type ContextWithHarper,
} from '@harperfast/integration-testing';

const FIXTURE_PATH = resolve(import.meta.dirname, 'fixtures/data-loader-custom-key');
const LOADED = /\[dataLoader\]: .*records in DataLoaderProduct/g;

suite('data loader with a custom primary key', (ctx: ContextWithHarper) => {
	let authorization: string;

	before(async () => {
		await setupHarperWithFixture(ctx, FIXTURE_PATH);
		authorization = `Basic ${Buffer.from(`${ctx.harper.admin.username}:${ctx.harper.admin.password}`).toString('base64')}`;
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	function logFile() {
		return join(ctx.harper.logDir ?? join(ctx.harper.dataRootDir, 'log'), 'hdb.log');
	}

	// The loader finishes a file after startup, on the primary worker, and logs one line per file
	async function waitForLoads(file: string, count: number) {
		const deadline = Date.now() + 30_000;
		let contents = '';
		while (Date.now() < deadline) {
			contents = await readFile(file, 'utf8').catch(() => '');
			if ((contents.match(LOADED)?.length ?? 0) >= count) return;
			await delay(200);
		}
		throw new Error(`Timed out waiting for ${count} data loader runs in ${file}`);
	}

	async function getProduct(sku: string) {
		const response = await fetch(`${ctx.harper.httpURL}/DataLoaderProduct/${sku}`, {
			headers: { authorization },
			signal: AbortSignal.timeout(10_000),
		});
		strictEqual(response.status, 200, `GET ${sku}: ${response.status}`);
		return response.json();
	}

	test('keeps a user edit across a restart and applies a data file change', async () => {
		const firstLog = logFile();
		await waitForLoads(firstLog, 1);
		strictEqual((await getProduct('SKU-1')).price, 10);
		const patch = await fetch(`${ctx.harper.httpURL}/DataLoaderProduct/SKU-1`, {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json', authorization },
			body: JSON.stringify({ price: 99, note: 'user edit' }),
			signal: AbortSignal.timeout(10_000),
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
		const secondLog = logFile();
		await waitForLoads(secondLog, secondLog === firstLog ? 2 : 1);

		const edited = await getProduct('SKU-1');
		strictEqual(edited.price, 99);
		strictEqual(edited.note, 'user edit');
		strictEqual((await getProduct('SKU-2')).price, 21);
	});
});
