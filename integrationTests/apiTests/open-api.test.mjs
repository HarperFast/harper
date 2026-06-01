/**
 * OpenAPI endpoint integration tests.
 *
 * Ported from legacy `apiTests/tests/22_openApi.mjs`. Validates:
 * - GET /openapi returns a valid OpenAPI 3.x document
 * - Document title includes 'Harper HTTP REST interface'
 * - Paths include the installed table routes (`/TableName/`, `/TableName/{id}`)
 * - A Resource-class route (`/Greeting/`) is included
 * - `components.schemas` includes both table and resource schemas
 * - `components.securitySchemes` includes `basicAuth` and `bearerAuth`
 *
 * Self-contained: installs a minimal `openApiApp` component that defines a
 * `TableName` table (via schema.graphql) and a `Greeting` JS Resource class
 * (via resources.js), restarts HTTP workers, then checks the spec.
 * Using a Resource class for Greeting matches the legacy setup and ensures
 * that JS-based resources (not just @table types) appear in the OpenAPI output.
 *
 * Skipped on Windows: depends on `restart_service http_workers` after component
 * install, which crashes Harper on the Windows single-worker model
 * (HarperFast/harper#549).
 */
import { suite, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startHarper, teardownHarper } from '@harperfast/integration-testing';
import { createApiClient } from './utils/client.mjs';
import { installAppComponent } from './utils/components.mjs';

const SCHEMA_GRAPHQL = `type TableName @table @export {
\tid: ID @primaryKey
\tname: String
\ttag: String @indexed
}
`;

// Greeting is a JS Resource class (not a table) — matches the legacy test's
// coverage and verifies that non-table Resource exports appear in OpenAPI.
const RESOURCES_JS = `export class Greeting extends Resource {
\tget() {
\t\treturn { greeting: 'Hello world' };
\t}
}
`;

const CONFIG_YAML = `rest: true
graphqlSchema:
  files: '*.graphql'
jsResource:
  files: resources.js
`;

const skipSuite = process.platform === 'win32';

suite('OpenAPI endpoint', { skip: skipSuite }, (ctx) => {
	let client;

	before(async () => {
		await startHarper(ctx, { config: {}, env: {} });
		client = createApiClient(ctx.harper);

		await installAppComponent(client, {
			project: 'openApiApp',
			files: { 'schema.graphql': SCHEMA_GRAPHQL, 'resources.js': RESOURCES_JS, 'config.yaml': CONFIG_YAML },
			probePath: '/TableName/',
			restartTimeoutMs: 120000,
		});
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	test('GET /openapi returns valid OpenAPI document', async () => {
		const r = await client.reqRest('/openapi').expect(200);

		assert.ok(r.body.openapi, r.text);
		assert.ok(r.body.info.title.includes('Harper HTTP REST interface'), r.text);

		assert.ok(r.body.paths, r.text);
		assert.ok(r.body.paths.hasOwnProperty('/TableName/'), r.text);
		assert.ok(r.body.paths.hasOwnProperty('/TableName/{id}'), r.text);
		assert.ok(r.body.paths.hasOwnProperty('/Greeting/'), r.text);

		const pathsText = JSON.stringify(r.body.paths);
		assert.ok(pathsText.includes('post'), r.text);
		assert.ok(pathsText.includes('get'), r.text);

		assert.ok(r.body.components, r.text);
		assert.ok(r.body.components.schemas, r.text);
		assert.ok(r.body.components.schemas.TableName, r.text);
		assert.ok(r.body.components.schemas.Greeting, r.text);

		assert.ok(r.body.components.securitySchemes, r.text);
		assert.ok(r.body.components.securitySchemes.basicAuth, r.text);
		assert.ok(r.body.components.securitySchemes.bearerAuth, r.text);
	});
});
