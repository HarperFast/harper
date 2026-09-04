/**
 * OpenAPI emission for a programmatic Resource's `static properties` (#1941/#1942).
 *
 * The existing `apiTests/open-api.test.mjs` asserts the document's *structure* — that `paths` and
 * `components.schemas` exist. Nothing asserted the emitted property schemas, so a wrong `nullable`, a
 * leaked `@hidden` field, or a dropped nested `enum` would ship green. These emitter behaviors are
 * per-surface and easy to regress silently, so they are pinned against the real document here.
 *
 * Skipped on Windows for the same reason as the sibling suite: `restart_service http_workers` after a
 * component install crashes Harper on the single-worker model (HarperFast/harper#549).
 */
import { suite, test, before, after } from 'node:test';
import assert from 'node:assert';
import { resolve } from 'node:path';
import { setupHarperWithFixture, teardownHarper } from '@harperfast/integration-testing';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createApiClient } from '../apiTests/utils/client.mjs';

const FIXTURE_PATH = resolve(import.meta.dirname, '../fixtures/mcp-static-properties');

const skipSuite = process.platform === 'win32';

suite('OpenAPI — static properties emission', { skip: skipSuite }, (ctx) => {
	let client;
	let schema;
	let mcpClient;
	let mcpTransport;

	before(async () => {
		await setupHarperWithFixture(ctx, FIXTURE_PATH, {
			config: { mcp: { application: { mountPath: '/mcp' } } },
			env: {},
		});
		client = createApiClient(ctx.harper);
		const r = await client.reqRest('/openapi').expect(200);
		schema = r.body.components.schemas.OrderSummary;
		assert.ok(schema, `OrderSummary schema missing from the document: ${r.text.slice(0, 400)}`);
		mcpTransport = new StreamableHTTPClientTransport(new URL('/mcp', ctx.harper.httpURL), {
			requestInit: {
				headers: {
					Authorization: `Basic ${Buffer.from(`${ctx.harper.admin.username}:${ctx.harper.admin.password}`).toString('base64')}`,
				},
			},
		});
		mcpClient = new Client({ name: 'static-properties-e2e', version: '1.0.0' }, { capabilities: {} });
		await mcpClient.connect(mcpTransport);
	});

	after(async () => {
		await mcpTransport?.close();
		await teardownHarper(ctx);
	});

	test('emits per-property type, description, and enum from static properties', () => {
		assert.equal(schema.properties.status.type, 'string');
		assert.equal(schema.properties.status.description, 'Fulfillment state.');
		assert.deepEqual(schema.properties.status.enum, ['open', 'closed']);
	});

	test('publishes the same static-properties shape through MCP tools/list', async () => {
		const { tools } = await mcpClient.listTools();
		const create = tools.find((tool) => tool.name === 'create_OrderSummary');
		assert.ok(create, `create_OrderSummary missing from tools/list: ${tools.map((tool) => tool.name).join(', ')}`);
		assert.deepEqual(create.inputSchema.properties.status, {
			type: 'string',
			description: 'Fulfillment state.',
			enum: ['open', 'closed'],
		});
		assert.deepEqual(create.inputSchema.properties.note.type, ['string', 'null']);
		assert.deepEqual(create.inputSchema.properties.anything, { type: 'array' });
		assert.deepEqual(create.inputSchema.properties.choice.enum, ['a', 1]);
		assert.equal(create.inputSchema.properties.profile.properties.creditScore, undefined);
		assert.deepEqual(create.inputSchema.required, ['status', 'note']);
	});

	test('emits OpenAPI `nullable` for a top-level nullable property', () => {
		// OpenAPI 3.0.3 has no union types. This was computed only to derive `required` and never
		// emitted, so a nullable property was advertised as non-nullable (#1942).
		assert.equal(schema.properties.note.type, 'string');
		assert.equal(schema.properties.note.nullable, true);
	});

	test('suppresses a @hidden sub-property of a nested object, and its description', () => {
		assert.ok(schema.properties.profile.properties.name, 'visible sub-property kept');
		assert.equal(schema.properties.profile.properties.creditScore, undefined, 'hidden sub-property emitted');
	});

	test('never emits `hidden` as a schema key, and never leaks a hidden description', () => {
		const doc = JSON.stringify(schema);
		assert.equal(doc.includes('"hidden"'), false, `hidden directive leaked into the document: ${doc}`);
		assert.equal(doc.includes('INTERNAL-ONLY-MARKER'), false, 'hidden sub-property description leaked');
	});

	test('drops a suppressed name from `required`, and omits `required` when nothing survives', () => {
		// `required: []` is invalid under draft-04 (which OpenAPI 3.0.3 inherits).
		assert.deepEqual(schema.properties.profile.required, ['name']);
		assert.equal('required' in schema.properties.allHidden, false, 'empty required must be omitted');
		assert.deepEqual(schema.required, ['status', 'note']);
	});

	test('carries enum and description into array items', () => {
		assert.deepEqual(schema.properties.tags.items.enum, ['x', 'y']);
		assert.equal(schema.properties.tags.items.description, 'Tag.');
	});

	test('emits dialect-valid unconstrained arrays without widening structural enum intersections', () => {
		assert.deepEqual(schema.properties.anything, { type: 'array', items: {} });
		assert.deepEqual(schema.properties.choice.enum, ['a', 1]);
		assert.ok(schema.properties.choice.anyOf.some((arm) => arm.enum?.includes(null)));
	});
});
