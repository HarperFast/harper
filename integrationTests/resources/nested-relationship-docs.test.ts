/**
 * Executes the request/response examples in the nested-relationship documentation companion:
 * https://github.com/HarperFast/documentation/pull/736.
 * The offline fixtures in that repo are checked against the published Markdown by docs CI.
 */
import { suite, test, before, after } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
	setupHarperWithFixture,
	teardownHarper,
	sendOperation,
	DEFAULT_ADMIN_USERNAME,
	DEFAULT_ADMIN_PASSWORD,
	type ContextWithHarper,
} from '@harperfast/integration-testing';

const fixture = resolve(import.meta.dirname, 'nested-relationship-docs');
const examples = JSON.parse(readFileSync(resolve(fixture, 'examples.json'), 'utf8'));
suite('documented nested relationship requests and responses', { timeout: 120_000 }, (ctx: ContextWithHarper) => {
	const auth = 'Basic ' + Buffer.from(DEFAULT_ADMIN_USERNAME + ':' + DEFAULT_ADMIN_PASSWORD).toString('base64');
	async function get(path: string) {
		const response = await fetch(ctx.harper.httpURL + path, {
			headers: { Authorization: auth },
			signal: AbortSignal.timeout(10_000),
		});
		const body = await response.json();
		assert.strictEqual(response.status, 200, JSON.stringify(body));
		return body;
	}
	async function insert(table: string, records: unknown[]) {
		await sendOperation(ctx.harper, { operation: 'insert', schema: 'data', table, records });
	}
	before(async () => {
		await setupHarperWithFixture(ctx, fixture, {
			config: { threads: { count: 1 } },
			env: { HARPER_STORAGE_ENGINE: process.env.HARPER_STORAGE_ENGINE || 'rocksdb' },
		});
		const deadline = Date.now() + 30_000;
		let ready = false;
		while (Date.now() < deadline) {
			try {
				await get('/Brand/');
				ready = true;
				break;
			} catch {
				await delay(50);
			}
		}
		assert(ready, 'Brand route did not become ready');
		await insert('Brand', examples.brands);
		await insert('Product', examples.products);
	});
	after(async () => {
		await teardownHarper(ctx);
	});
	for (const example of examples.cases)
		test(example.key, async () => {
			assert.deepStrictEqual(await get(example.url), example.response);
		});
	test('both exact programmatic snippets produce their documented responses', async () => {
		assert.deepStrictEqual(await get('/DocumentedQueries/'), {
			single: examples.single,
			programmatic: examples.programmatic,
		});
	});
	test('repeating the inherited predicate does not change the response', async () => {
		const inherited = examples.cases.find((example: { key: string }) => example.key === 'outer_inherited');
		assert.deepStrictEqual(
			await get(inherited.url.replace('products[', 'products[price=ge=number:30&')),
			inherited.response
		);
	});
	test('the outer page bounds parents independently of child limits', async () => {
		const bounded = examples.cases.find((example: { key: string }) => example.key === 'bounded_parent_page');
		assert.deepStrictEqual(await get(bounded.url.replace('limit(0,20)', 'limit(0,1)')), [bounded.response[0]]);
	});
	test('nested sorting permits an unindexed child field', async () => {
		const rows = await get('/Brand/?select(id,products[sort(name)&limit(1)&select(id,)])');
		assert.deepStrictEqual(
			rows.map((row: { products: { id: string }[] }) => row.products),
			[[{ id: 'p1' }], [{ id: 'p4' }], [{ id: 'p6' }]]
		);
	});

	test('the unique child sort key breaks equal-price ties', async () => {
		await insert('Product', [{ id: 'p0', brandId: 42, name: 'Adapter', price: 35 }]);
		const bounded = examples.cases.find((example: { key: string }) => example.key === 'bounded_parent_page');
		const rows = await get(bounded.url);
		assert.deepStrictEqual(rows[0].products, [{ id: 'p0', name: 'Adapter', price: 35 }]);
		const descending = await get(bounded.url.replace('sort(price,id)', 'sort(price,-id)'));
		assert.deepStrictEqual(descending[0].products, [{ id: 'p2', name: 'Keyboard', price: 35 }]);
		const window = await get(bounded.url.replace('limit(1)', 'limit(1,2)'));
		assert.deepStrictEqual(window[0].products, [{ id: 'p2', name: 'Keyboard', price: 35 }]);
	});
	test('the unique parent sort key breaks equal-name ties', async () => {
		await insert('Brand', [{ id: 45, name: 'Acme' }]);
		await insert('Product', [{ id: 'p7', brandId: 45, name: 'Hub', price: 50 }]);
		const bounded = examples.cases.find((example: { key: string }) => example.key === 'bounded_parent_page');
		const page = bounded.url.replace('limit(0,20)', 'limit(0,1)');
		assert.strictEqual((await get(page))[0].id, 42);
		assert.strictEqual((await get(page.replace('sort(name,id)', 'sort(name,-id)')))[0].id, 45);
	});
});

async function readPeerFile(path: string) {
	const response = await fetch(
		'https://raw.githubusercontent.com/HarperFast/documentation/' +
			peerRevision +
			'/scripts/fixtures/nested-relationship-docs/' +
			path,
		{ signal: AbortSignal.timeout(15_000) }
	);
	assert.strictEqual(response.status, 200, 'Cannot read peer fixture: ' + response.url);
	return response.text();
}
let peerRevision = '';
test(
	'paired documentation fixtures stay synchronized across repositories',
	{ skip: !process.env.CI && !process.env.HARPER_DOCS_FIXTURE_ROOT },
	async () => {
		const peerRoot = process.env.HARPER_DOCS_FIXTURE_ROOT;
		if (!peerRoot) {
			const response = await fetch('https://api.github.com/repos/HarperFast/documentation/pulls/736', {
				signal: AbortSignal.timeout(15_000),
			});
			assert.strictEqual(response.status, 200, 'Cannot resolve companion PR revision');
			const pr = await response.json();
			peerRevision = pr.merged_at ? 'main' : pr.head.sha;
			assert(peerRevision === 'main' || /^[a-f0-9]{40}$/.test(peerRevision));
		}
		for (const name of ['examples.json', 'schema.graphql', 'resources.js']) {
			const expected = readFileSync(resolve(fixture, name), 'utf8');
			const actual = peerRoot ? readFileSync(resolve(peerRoot, name), 'utf8') : await readPeerFile(name);
			assert.strictEqual(
				actual.replace(/\r\n/g, '\n'),
				expected.replace(/\r\n/g, '\n'),
				name + ' differs from the companion repository; update both fixtures together'
			);
		}
	}
);
