/**
 * Parameterised path integration tests.
 *
 * Installs a JS-resource component that declares routes with `:param` and
 * `*wildcard` segments — both via a `static path` field and via the
 * `export { X as '/path' }` form — and verifies that matched segments are
 * bound onto the request target (`target.<param>`) and reach the resource.
 *
 * Skipped on Windows: depends on `restart_service http_workers` after
 * component install, which crashes the Harper instance on Windows
 * (HarperFast/harper#549) — matches the per-suite skip in rest.test.mjs.
 *
 * Covers HarperFast/harper#602.
 */
import { suite, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startHarper, teardownHarper } from '@harperfast/integration-testing';
import { createApiClient } from './utils/client.mjs';
import { installAppComponent } from './utils/components.mjs';

// A component whose JS resources declare parameterised routes a few different ways.
const RESOURCES_JS = `
// static path field with multiple named params
export class Widget extends Resource {
	static path = '/widget/:id/action/:action';
	allowRead() { return true; }
	get(target) {
		return { id: target.id, action: target.action };
	}
}

// wildcard / catch-all segment
export class Files extends Resource {
	static path = '/files/*rest';
	allowRead() { return true; }
	get(target) {
		return { rest: target.rest };
	}
}

// the export-name-as-path form, with a leading slash for a top-level route
class ThingResource extends Resource {
	allowRead() { return true; }
	get(target) {
		return { id: target.id };
	}
}
export { ThingResource as '/thing/:id' };
`;

const CONFIG_YAML = `rest: true
jsResource:
  files: resources.js
`;

const skipSuite = process.platform === 'win32';

suite('Parameterised routes', { skip: skipSuite }, (ctx) => {
	let client;

	before(async () => {
		await startHarper(ctx, { config: {}, env: {} });
		client = createApiClient(ctx.harper);

		await installAppComponent(client, {
			project: 'paramRoutes',
			files: { 'resources.js': RESOURCES_JS, 'config.yaml': CONFIG_YAML },
			probePath: '/widget/probe/action/probe',
			restartTimeoutMs: 120000,
		});
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	test('binds multiple named params from a static path field', () =>
		client
			.reqRest('/widget/10/action/jump')
			.expect((r) => assert.deepEqual(r.body, { id: '10', action: 'jump' }, r.text))
			.expect(200));

	test('decodes percent-encoded param values', () =>
		client
			.reqRest('/widget/hello%20world/action/wave')
			.expect((r) => assert.equal(r.body.id, 'hello world', r.text))
			.expect(200));

	test('captures the remainder of the path with a wildcard segment', () =>
		client
			.reqRest('/files/a/b/c.txt')
			.expect((r) => assert.deepEqual(r.body, { rest: 'a/b/c.txt' }, r.text))
			.expect(200));

	test('supports the export-name-as-path form with a leading-slash top-level route', () =>
		client
			.reqRest('/thing/42')
			.expect((r) => assert.deepEqual(r.body, { id: '42' }, r.text))
			.expect(200));

	test('does not match when the segment count differs', () => client.reqRest('/widget/10/action').expect(404));
});
