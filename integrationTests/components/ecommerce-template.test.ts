/**
 * ecommerce-template component integration test.
 *
 * Deploys harper-ecommerce-template and verifies page rendering,
 * REST API CRUD, edge cases, and GraphQL.
 */
import { suite, test, before, after } from 'node:test';
import { strictEqual, ok, deepStrictEqual } from 'node:assert/strict';

import { startHarper, teardownHarper, sendOperation, type ContextWithHarper } from '@harperfast/integration-testing';

suite('Component: ecommerce-template', (ctx: ContextWithHarper) => {
	before(async () => {
		await startHarper(ctx);

		const body = await sendOperation(ctx.harper, {
			operation: 'deploy_component',
			project: 'harper-ecommerce-template',
			package: 'https://github.com/HarperFast/harper-ecommerce-template',
			restart: true,
		});
		deepStrictEqual(body, { message: 'Successfully deployed: harper-ecommerce-template, restarting Harper' });

		const deadline = Date.now() + 60_000;
		while (true) {
			try {
				const check = await fetch(`${ctx.harper.httpURL}/Product/`);
				if (check.status === 200) break;
			} catch {
				// server not yet accepting connections
			}
			if (Date.now() > deadline) throw new Error('Timed out waiting for ecommerce-template to be ready after deploy');
			await new Promise((resolve) => setTimeout(resolve, 500));
		}
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	test('homepage returns 200', async () => {
		const res = await fetch(ctx.harper.httpURL);
		strictEqual(res.status, 200);
	});

	test('/products page returns 200', async () => {
		const res = await fetch(`${ctx.harper.httpURL}/products`);
		strictEqual(res.status, 200);
	});

	test('/products/[id] page returns 200', async () => {
		const res = await fetch(`${ctx.harper.httpURL}/products/11`);
		strictEqual(res.status, 200);
	});

	test('GET /Product/ returns array of seeded products', async () => {
		const res = await fetch(`${ctx.harper.httpURL}/Product/`);
		strictEqual(res.status, 200);
		const body = await res.json();
		ok(Array.isArray(body), 'expected array');
		ok(body.length >= 1, 'expected at least 1 seeded product');
	});

	test('GET /Product/:id returns complete product record', async () => {
		const res = await fetch(`${ctx.harper.httpURL}/Product/11`);
		strictEqual(res.status, 200);
		const body = await res.json();
		ok(body.name, 'expected product name');
		ok(body.category, 'expected product category');
		ok(body.price !== undefined, 'expected product price');
	});

	test('GET /Traits/ returns trait data', async () => {
		const res = await fetch(`${ctx.harper.httpURL}/Traits/`);
		strictEqual(res.status, 200);
		const body = await res.json();
		ok(Array.isArray(body), 'expected array');
	});

	test('POST /Product/ creates a new product', async () => {
		const res = await fetch(`${ctx.harper.httpURL}/Product/`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				id: '99',
				name: 'Test Product',
				category: 'Testing',
				price: 9.99,
				image: 'https://example.com/test.png',
				description: 'CI test product',
				features: ['test feature'],
				specs: { Material: 'Plastic' },
			}),
		});
		ok(res.status < 300, `expected 2xx, got ${res.status}`);

		const getRes = await fetch(`${ctx.harper.httpURL}/Product/99`);
		const body = await getRes.json();
		strictEqual(body.name, 'Test Product');
		strictEqual(body.category, 'Testing');
		strictEqual(body.price, 9.99);
	});

	test('PUT /Product/:id replaces the record', async () => {
		const res = await fetch(`${ctx.harper.httpURL}/Product/99`, {
			method: 'PUT',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'Updated Product', price: 19.99 }),
		});
		ok(res.status < 300, `expected 2xx, got ${res.status}`);

		const getRes = await fetch(`${ctx.harper.httpURL}/Product/99`);
		const body = await getRes.json();
		strictEqual(body.name, 'Updated Product');
		strictEqual(body.price, 19.99);
	});

	test('DELETE /Product/:id removes the record', async () => {
		const deleteRes = await fetch(`${ctx.harper.httpURL}/Product/99`, {
			method: 'DELETE',
		});
		const deleteBody = await deleteRes.json();
		strictEqual(deleteBody, true);

		const goneRes = await fetch(`${ctx.harper.httpURL}/Product/99`);
		strictEqual(goneRes.status, 404);
	});

	test('invalid product ID returns 404', async () => {
		const res = await fetch(`${ctx.harper.httpURL}/products/999`);
		strictEqual(res.status, 404);
	});

	test('invalid route returns 404', async () => {
		const res = await fetch(`${ctx.harper.httpURL}/nonexistent`);
		strictEqual(res.status, 404);
	});

	test('string product ID returns 404', async () => {
		const res = await fetch(`${ctx.harper.httpURL}/products/abc`);
		strictEqual(res.status, 404);
	});

	test('REST API nonexistent product returns 404', async () => {
		const res = await fetch(`${ctx.harper.httpURL}/Product/999`);
		strictEqual(res.status, 404);
	});

	test('GraphQL query returns products', async () => {
		const res = await fetch(`${ctx.harper.httpURL}/graphql`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ query: '{ Product { id name category price } }' }),
		});
		strictEqual(res.status, 200);
		const body = await res.json();
		ok(body.data, 'expected GraphQL data field');
		ok(Array.isArray(body.data.Product), 'expected Product array');
	});
});
