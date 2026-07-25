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
import { startHarper, teardownHarper } from '@harperfast/integration-testing';
import { createApiClient } from '../apiTests/utils/client.mjs';
import { installAppComponent } from '../apiTests/utils/components.mjs';

const RESOURCES_JS = `export class OrderSummary extends Resource {
\tstatic description = 'Rolled-up order totals.';
\tstatic primaryKey = 'orderId';
\tstatic properties = {
\t\torderId: { type: 'string', primaryKey: true, description: 'Order id.' },
\t\tstatus: { type: 'string', enum: ['open', 'closed'], description: 'Fulfillment state.' },
\t\tnote: { type: ['string', 'null'], description: 'Nullable note.' },
\t\tprofile: {
\t\t\ttype: 'object',
\t\t\tproperties: {
\t\t\t\tname: { type: 'string', description: 'Visible name.' },
\t\t\t\tcreditScore: { type: 'integer', hidden: true, description: 'INTERNAL-ONLY-MARKER' },
\t\t\t},
\t\t\trequired: ['name', 'creditScore'],
\t\t},
\t\tallHidden: { type: 'object', properties: { secret: { type: 'string', hidden: true } }, required: ['secret'] },
\t\ttags: { type: 'array', items: { type: 'string', enum: ['x', 'y'], description: 'Tag.' } },
\t};
\tget() {
\t\treturn { orderId: 'o1' };
\t}
}
`;

const CONFIG_YAML = `rest: true
jsResource:
  files: resources.js
`;

const skipSuite = process.platform === 'win32';

suite('OpenAPI — static properties emission', { skip: skipSuite }, (ctx) => {
	let client;
	let schema;

	before(async () => {
		await startHarper(ctx, { config: {}, env: {} });
		client = createApiClient(ctx.harper);
		await installAppComponent(client, {
			project: 'staticPropsApp',
			files: { 'resources.js': RESOURCES_JS, 'config.yaml': CONFIG_YAML },
			probePath: '/OrderSummary/',
			restartTimeoutMs: 120000,
		});
		const r = await client.reqRest('/openapi').expect(200);
		schema = r.body.components.schemas.OrderSummary;
		assert.ok(schema, `OrderSummary schema missing from the document: ${r.text.slice(0, 400)}`);
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	test('emits per-property type, description, and enum from static properties', () => {
		assert.equal(schema.properties.status.type, 'string');
		assert.equal(schema.properties.status.description, 'Fulfillment state.');
		assert.deepEqual(schema.properties.status.enum, ['open', 'closed']);
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
		assert.equal('required' in schema, false, 'top-level empty required must be omitted');
	});

	test('carries enum and description into array items', () => {
		assert.deepEqual(schema.properties.tags.items.enum, ['x', 'y']);
		assert.equal(schema.properties.tags.items.description, 'Tag.');
	});
});
