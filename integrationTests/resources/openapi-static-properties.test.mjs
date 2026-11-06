/**
 * OpenAPI emission for a programmatic Resource's `static properties` (#1941/#1942).
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
	let contractRoute;
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
		contractRoute = r.body.paths['/ConditionalIntake'];
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
		assert.deepEqual(create.inputSchema.properties.payload.enum, [{ a: 1, b: [true, null] }, ['x']]);
		assert.deepEqual(create.inputSchema.properties.profile.required, ['name', 'nestedExtension']);
		assert.equal(create.inputSchema.properties.profile.properties.creditScore, undefined);
		assert.deepEqual(create.inputSchema.required, ['status', 'note', 'extension']);
	});

	test('preserves explicit static types with conditional properties through OpenAPI and MCP', async () => {
		const { tools } = await mcpClient.listTools();
		const create = tools.find((tool) => tool.name === 'create_OrderSummary');
		const get = tools.find((tool) => tool.name === 'get_OrderSummary');
		for (const properties of [schema.properties, create.inputSchema.properties, get.outputSchema.properties]) {
			assert.strictEqual(properties.conditionalText.type, 'string');
			assert.strictEqual(properties.conditionalTags.type, 'array');
			assert.deepStrictEqual(properties.conditionalTags.items, { type: 'string' });
			assert.deepStrictEqual(properties.conditionalNullableTags.items, { type: 'string' });
		}
		assert.strictEqual(schema.properties.conditionalNullableTags.type, 'array');
		assert.strictEqual(schema.properties.conditionalNullableTags.nullable, true);
		assert.deepStrictEqual(create.inputSchema.properties.conditionalNullableTags.type, ['array', 'null']);
	});

	test('returns a record satisfying the MCP output schema with an undeclared required field', async () => {
		await mcpClient.listTools();
		const result = await mcpClient.callTool({ name: 'get_OrderSummary', arguments: { id: 'o1' } });
		assert.equal(result.isError, undefined);
		assert.equal(result.structuredContent.extension, true);
	});

	test('emits OpenAPI `nullable` for a top-level nullable property', () => {
		// OpenAPI 3.0.3 represents a nullable union with the nullable keyword.
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
		assert.deepEqual(schema.properties.profile.required, ['name', 'nestedExtension']);
		assert.equal('required' in schema.properties.allHidden, false, 'empty required must be omitted');
		assert.deepEqual(schema.required, ['status', 'note', 'extension']);
	});

	test('carries enum and description into array items', () => {
		assert.deepEqual(schema.properties.tags.items.enum, ['x', 'y']);
		assert.equal(schema.properties.tags.items.description, 'Tag.');
	});

	test('emits dialect-valid unconstrained arrays without widening structural enum intersections', () => {
		assert.deepEqual(schema.properties.anything, { type: 'array', items: {} });
		assert.deepEqual(schema.properties.choice.enum, ['a', 1]);
		assert.deepEqual(schema.properties.payload.enum, [{ a: 1, b: [true, null] }]);
		assert.ok(schema.properties.choice.anyOf.some((arm) => arm.enum?.includes(null)));
	});

	test('preserves type-optional contract constraints in the served document', async () => {
		const expected = { properties: { label: { type: 'string' } }, items: { type: 'string' } };
		assert.deepEqual(contractRoute.post.requestBody.content['application/json'].schema, expected);
		assert.deepEqual(
			contractRoute.post.responses['200'].content['application/json'].schema.properties.result,
			expected
		);
		const response = await fetch(new URL('/ConditionalIntake', ctx.harper.httpURL), {
			method: 'POST',
			headers: client.headers,
			body: JSON.stringify(['one', 'two']),
		});
		assert.equal(response.status, 200);
		assert.deepEqual(await response.json(), { result: ['one', 'two'] });
	});
});
