/**
 * Operations Server integration tests.
 *
 * Tests the Operations API server functionality including:
 * - Basic connectivity and health checks
 * - Content negotiation (JSON, MessagePack, CBOR, CSV)
 * - Error handling
 * - CORS behavior
 */
import { suite, test, before, after } from 'node:test';
import { ok, strictEqual } from 'node:assert/strict';
import { pack, unpack } from 'msgpackr';
import { encode, decode } from 'cbor-x';

import { startHarper, teardownHarper, type ContextWithHarper } from '../utils/harperLifecycle.ts';

suite('Operations Server', (ctx: ContextWithHarper) => {
	before(async () => {
		await startHarper(ctx, { config: {}, env: {} });
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	test('health endpoint returns 200', async () => {
		const response = await fetch(`${ctx.harper.operationsAPIURL}/health`);
		strictEqual(response.status, 200);
		const body = await response.text();
		strictEqual(body, 'Harper is running.');
	});

	test('POST request without body returns 400', async () => {
		const response = await fetch(ctx.harper.operationsAPIURL, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Authorization': `Basic ${Buffer.from(`${ctx.harper.admin.username}:${ctx.harper.admin.password}`).toString('base64')}`,
			},
		});
		strictEqual(response.status, 400);
	});

	test('POST request with invalid JSON returns 400', async () => {
		const response = await fetch(ctx.harper.operationsAPIURL, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Authorization': `Basic ${Buffer.from(`${ctx.harper.admin.username}:${ctx.harper.admin.password}`).toString('base64')}`,
			},
			body: 'not valid json',
		});
		strictEqual(response.status, 400);
	});

	test('describe_all operation returns JSON by default', async () => {
		const response = await fetch(ctx.harper.operationsAPIURL, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Authorization': `Basic ${Buffer.from(`${ctx.harper.admin.username}:${ctx.harper.admin.password}`).toString('base64')}`,
			},
			body: JSON.stringify({ operation: 'describe_all' }),
		});
		strictEqual(response.status, 200);
		const contentType = response.headers.get('content-type');
		ok(contentType?.includes('application/json'), `Expected JSON content type, got ${contentType}`);
		const body = await response.json();
		ok(typeof body === 'object', 'Response should be an object');
	});

	test('returns MessagePack when Accept: application/x-msgpack', async () => {
		const response = await fetch(ctx.harper.operationsAPIURL, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Accept': 'application/x-msgpack',
				'Authorization': `Basic ${Buffer.from(`${ctx.harper.admin.username}:${ctx.harper.admin.password}`).toString('base64')}`,
			},
			body: JSON.stringify({ operation: 'describe_all' }),
		});
		strictEqual(response.status, 200);
		const contentType = response.headers.get('content-type');
		ok(contentType?.includes('application/x-msgpack'), `Expected MessagePack content type, got ${contentType}`);
		const buffer = await response.arrayBuffer();
		const body = unpack(Buffer.from(buffer));
		ok(typeof body === 'object', 'Response should be an object');
	});

	test('parses MessagePack request body', async () => {
		const response = await fetch(ctx.harper.operationsAPIURL, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/x-msgpack',
				'Accept': 'application/json',
				'Authorization': `Basic ${Buffer.from(`${ctx.harper.admin.username}:${ctx.harper.admin.password}`).toString('base64')}`,
			},
			// @ts-expect-error - Need to update fetch types to support `Buffer<ArrayBufferLike>`
			body: pack({ operation: 'describe_all' }),
		});
		strictEqual(response.status, 200);
		const body = await response.json();
		ok(typeof body === 'object', 'Response should be an object');
	});

	test('returns 400 with invalid MessagePack', async () => {
		const response = await fetch(ctx.harper.operationsAPIURL, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/x-msgpack',
				'Authorization': `Basic ${Buffer.from(`${ctx.harper.admin.username}:${ctx.harper.admin.password}`).toString('base64')}`,
			},
			body: Buffer.from([0xff, 0xff, 0xff]), // Invalid MessagePack
		});
		strictEqual(response.status, 400);
	});

	test('returns CBOR when Accept: application/cbor', async () => {
		const response = await fetch(ctx.harper.operationsAPIURL, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Accept': 'application/cbor',
				'Authorization': `Basic ${Buffer.from(`${ctx.harper.admin.username}:${ctx.harper.admin.password}`).toString('base64')}`,
			},
			body: JSON.stringify({ operation: 'describe_all' }),
		});
		strictEqual(response.status, 200);
		const contentType = response.headers.get('content-type');
		ok(contentType?.includes('application/cbor'), `Expected CBOR content type, got ${contentType}`);
		const buffer = await response.arrayBuffer();
		const body = decode(Buffer.from(buffer));
		ok(typeof body === 'object', 'Response should be an object');
	});

	test('parses CBOR request body', async () => {
		const response = await fetch(ctx.harper.operationsAPIURL, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/cbor',
				'Accept': 'application/json',
				'Authorization': `Basic ${Buffer.from(`${ctx.harper.admin.username}:${ctx.harper.admin.password}`).toString('base64')}`,
			},
			// @ts-expect-error - Need to update fetch types to support `Buffer<ArrayBufferLike>`
			body: encode({ operation: 'describe_all' }),
		});
		strictEqual(response.status, 200);
		const body = await response.json();
		ok(typeof body === 'object', 'Response should be an object');
	});

	test('returns 400 with invalid CBOR', async () => {
		const response = await fetch(ctx.harper.operationsAPIURL, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/cbor',
				'Authorization': `Basic ${Buffer.from(`${ctx.harper.admin.username}:${ctx.harper.admin.password}`).toString('base64')}`,
			},
			body: Buffer.from([0xff, 0xff, 0xff]), // Invalid CBOR
		});
		strictEqual(response.status, 400);
	});

	test('returns CSV when Accept: text/csv', async () => {
		// First create a database and table with data
		await fetch(ctx.harper.operationsAPIURL, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Authorization': `Basic ${Buffer.from(`${ctx.harper.admin.username}:${ctx.harper.admin.password}`).toString('base64')}`,
			},
			body: JSON.stringify({ operation: 'create_database', database: 'csv_test' }),
		});

		await fetch(ctx.harper.operationsAPIURL, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Authorization': `Basic ${Buffer.from(`${ctx.harper.admin.username}:${ctx.harper.admin.password}`).toString('base64')}`,
			},
			body: JSON.stringify({
				operation: 'create_table',
				schema: 'csv_test',
				table: 'items',
				primary_key: 'id',
			}),
		});

		await fetch(ctx.harper.operationsAPIURL, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Authorization': `Basic ${Buffer.from(`${ctx.harper.admin.username}:${ctx.harper.admin.password}`).toString('base64')}`,
			},
			body: JSON.stringify({
				operation: 'insert',
				schema: 'csv_test',
				table: 'items',
				records: [
					{ id: 1, name: 'Item 1' },
					{ id: 2, name: 'Item 2' },
				],
			}),
		});

		// Now request CSV format
		const response = await fetch(ctx.harper.operationsAPIURL, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Accept': 'text/csv',
				'Authorization': `Basic ${Buffer.from(`${ctx.harper.admin.username}:${ctx.harper.admin.password}`).toString('base64')}`,
			},
			body: JSON.stringify({
				operation: 'sql',
				sql: 'SELECT * FROM csv_test.items ORDER BY id',
			}),
		});
		strictEqual(response.status, 200);
		const contentType = response.headers.get('content-type');
		ok(contentType?.includes('text/csv'), `Expected CSV content type, got ${contentType}`);
		const body = await response.text();
		ok(body.includes('id'), 'CSV should contain id column');
		ok(body.includes('name'), 'CSV should contain name column');
	});

	test('request without auth works in dev mode', async () => {
		// In dev mode (DEFAULTS_MODE=dev), authentication is not required
		const response = await fetch(ctx.harper.operationsAPIURL, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({ operation: 'describe_all' }),
		});
		strictEqual(response.status, 200);
	});

	test('request with invalid credentials returns 401', async () => {
		const response = await fetch(ctx.harper.operationsAPIURL, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Authorization': `Basic ${Buffer.from('invalid:credentials').toString('base64')}`,
			},
			body: JSON.stringify({ operation: 'describe_all' }),
		});
		strictEqual(response.status, 401);
	});
});
