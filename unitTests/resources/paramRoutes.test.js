const assert = require('node:assert');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const { pathToFileURL } = require('node:url');
const { Resources } = require('#src/resources/Resources');
const { Resource } = require('#src/resources/Resource');
const { RequestTarget } = require('#src/resources/RequestTarget');
const { handleApplication, resolveResourcePath } = require('#src/resources/jsResource');

// A minimal object that passes for a Resource as far as the registry is concerned.
function makeResource(name) {
	return { get() {}, _name: name };
}

describe('Parameterised routes', () => {
	it('matches a parameterised path and extracts the params onto the entry', () => {
		const resources = new Resources();
		const Widget = makeResource('Widget');
		resources.set('resource/:id/action/:action', Widget);

		const entry = resources.getMatch('resource/10/action/jump');
		assert.ok(entry, 'should match the parameterised path');
		assert.strictEqual(entry.Resource, Widget);
		assert.deepEqual(entry.params, { id: '10', action: 'jump' });
	});

	it('does not match when the segment count differs', () => {
		const resources = new Resources();
		resources.set('resource/:id', makeResource('R'));

		assert.strictEqual(resources.getMatch('resource/10/extra'), undefined, 'extra segment should not match');
		assert.strictEqual(resources.getMatch('resource'), undefined, 'missing segment should not match');
	});

	it('decodes percent-encoded param values', () => {
		const resources = new Resources();
		resources.set('widget/:id', makeResource('W'));

		const entry = resources.getMatch('widget/hello%20world');
		assert.deepEqual(entry.params, { id: 'hello world' });
	});

	it('binds a named param from a top-level (leading-slash) route', () => {
		const resources = new Resources();
		// `set` strips the leading slash; this models `export { Acme as '/.well-known/acme-challenge/:token' }`
		resources.set('.well-known/acme-challenge/:token', makeResource('Acme'));

		const entry = resources.getMatch('.well-known/acme-challenge/abc123');
		assert.deepEqual(entry.params, { token: 'abc123' });
	});

	it('supports wildcard catch-all segments, including the empty remainder', () => {
		const resources = new Resources();
		resources.set('files/*rest', makeResource('Files'));

		assert.deepEqual(resources.getMatch('files/a/b/c.txt').params, { rest: 'a/b/c.txt' });
		assert.deepEqual(resources.getMatch('files').params, { rest: '' }, 'wildcard should match zero remaining segments');
	});

	it('captures a bare wildcard under the "wildcard" key', () => {
		const resources = new Resources();
		resources.set('proxy/*', makeResource('Proxy'));

		// a bare `*` normalizes to `wildcard` so the key is a valid URI-template / OpenAPI variable name
		assert.deepEqual(resources.getMatch('proxy/a/b').params, { wildcard: 'a/b' });
	});

	it('prefers an exact static path over a parameterised one (static wins)', () => {
		const resources = new Resources();
		const Param = makeResource('Param');
		const Static = makeResource('Static');
		resources.set('resource/:id', Param);
		resources.set('resource/admin', Static);

		assert.strictEqual(resources.getMatch('resource/admin').Resource, Static, 'exact static path wins');
		const dynamic = resources.getMatch('resource/123');
		assert.strictEqual(dynamic.Resource, Param, 'non-static path falls through to the parameterised route');
		assert.deepEqual(dynamic.params, { id: '123' });
	});

	it('ranks a named-param route ahead of a wildcard route at the same depth', () => {
		const resources = new Resources();
		const Specific = makeResource('Specific');
		const Wild = makeResource('Wild');
		resources.set('a/*rest', Wild);
		resources.set('a/:id', Specific);

		const exact = resources.getMatch('a/42');
		assert.strictEqual(exact.Resource, Specific, 'single-segment match prefers the named param route');
		assert.deepEqual(exact.params, { id: '42' });

		const deep = resources.getMatch('a/42/deep');
		assert.strictEqual(deep.Resource, Wild, 'multi-segment match falls through to the wildcard route');
		assert.deepEqual(deep.params, { rest: '42/deep' });
	});

	it('ranks routes with more leading static segments first', () => {
		const resources = new Resources();
		const General = makeResource('General');
		const Specific = makeResource('Specific');
		resources.set(':type/:id', General);
		resources.set('user/:id', Specific);

		const entry = resources.getMatch('user/7');
		assert.strictEqual(entry.Resource, Specific);
		assert.deepEqual(entry.params, { id: '7' });
	});

	it('ranks a more specific later segment ahead regardless of registration order', () => {
		// both routes share `widget/:id` then diverge at the 3rd segment (static vs param); the static one wins
		const resources = new Resources();
		const Specific = makeResource('Specific');
		const General = makeResource('General');
		resources.set('widget/:id/:action', General); // registered first, but less specific
		resources.set('widget/:id/action', Specific);

		assert.strictEqual(resources.getMatch('widget/5/action').Resource, Specific);
		assert.deepEqual(resources.getMatch('widget/5/jump').Resource, General);
	});

	it('rejects a wildcard that is not the final segment', () => {
		const resources = new Resources();
		assert.throws(() => resources.set('files/*rest/extra', makeResource('Bad')), /Wildcard segment must be the last/);
	});

	it('matches a route registered with a trailing slash', () => {
		const resources = new Resources();
		// `set` normalizes the trailing slash so the empty final segment never blocks a match
		resources.set('widget/:id/', makeResource('W'));

		const entry = resources.getMatch('widget/5');
		assert.ok(entry);
		assert.deepEqual(entry.params, { id: '5' });
	});

	it('delete() removes a parameterised route so it no longer matches', () => {
		const resources = new Resources();
		resources.set('widget/:id', makeResource('W'));
		assert.ok(resources.getMatch('widget/5'), 'route matches before delete');

		assert.strictEqual(resources.delete('widget/:id'), true, 'delete reports the route was removed');
		assert.strictEqual(resources.paramRoutes.length, 0, 'side array is pruned');
		assert.strictEqual(resources.getMatch('widget/5'), undefined, 'route no longer matches after delete');
	});

	it('clear() drops parameterised routes alongside static entries', () => {
		const resources = new Resources();
		resources.set('plain', makeResource('Plain'));
		resources.set('widget/:id', makeResource('W'));

		resources.clear();
		assert.strictEqual(resources.size, 0, 'Map entries cleared');
		assert.strictEqual(resources.paramRoutes.length, 0, 'parameterised routes cleared');
		assert.strictEqual(resources.getMatch('widget/5'), undefined);
	});

	it('does not consult parameterised routes for a plain static match (fast path)', () => {
		const resources = new Resources();
		const Plain = makeResource('Plain');
		resources.set('plain', Plain);

		assert.strictEqual(resources.paramRoutes.length, 0, 'no parameterised routes were registered');
		const entry = resources.getMatch('plain/123');
		assert.strictEqual(entry.Resource, Plain);
		assert.strictEqual(entry.params, undefined, 'a static match should not carry params');
		assert.strictEqual(entry.relativeURL, '/123');
	});

	it('honours exportType filtering on parameterised routes', () => {
		const resources = new Resources();
		resources.set('widget/:id', makeResource('W'), { rest: false, mqtt: true });

		assert.strictEqual(resources.getMatch('widget/1', 'rest'), undefined, 'disabled export type should not match');
		assert.ok(resources.getMatch('widget/1', 'mqtt'), 'enabled export type should match');
	});

	it('preserves the query string in relativeURL while binding params', () => {
		const resources = new Resources();
		resources.set('widget/:id', makeResource('W'));

		const entry = resources.getMatch('widget/5?select(name)');
		assert.deepEqual(entry.params, { id: '5' });
		assert.strictEqual(entry.relativeURL, '?select(name)');
	});

	it('binds matched params onto a RequestTarget the way request handlers do', () => {
		// mirrors server/REST.ts: `new RequestTarget(entry.relativeURL)` then `Object.assign(target, entry.params)`
		const resources = new Resources();
		resources.set('resource/:id/action/:action', makeResource('R'));

		const entry = resources.getMatch('resource/10/action/jump');
		const target = new RequestTarget(entry.relativeURL);
		Object.assign(target, entry.params);

		assert.strictEqual(target.id, '10');
		assert.strictEqual(target.action, 'jump');
	});

	it('reports a conflict when two different resources claim the same parameterised path', () => {
		const resources = new Resources();
		resources.set('widget/:id', { get() {}, databaseName: 'a', tableName: 'x' });
		resources.set('widget/:id', { get() {}, databaseName: 'b', tableName: 'y' });

		const entry = resources.getMatch('widget/1');
		// the conflict is surfaced as an ErrorResource rather than silently picking a winner
		assert.strictEqual(entry.Resource.constructor.name, 'ErrorResource');
	});
});

describe('Parameterised route registration (real module exports)', () => {
	// Drives the real jsResource `handleApplication` over an actual ES module so we exercise the registration path
	// (static path fields + arbitrary-name `export { X as '/path' }`) end-to-end, short of the HTTP server.
	function createScope(resources) {
		let handler;
		return {
			handleEntry(fn) {
				handler = fn;
			},
			resources,
			logger: { warn() {}, debug() {}, error() {} },
			configFilePath: 'config.yaml',
			requestRestart() {},
			import: (absolutePath) => import(pathToFileURL(absolutePath).href),
			run: (event) => handler(event),
		};
	}

	let tempDir;
	let previousResourceGlobal;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), 'paramroutes-reg-'));
		// component resource files reference `Resource` as a global; point it at the real base class
		previousResourceGlobal = global.Resource;
		global.Resource = Resource;
	});

	afterEach(() => {
		global.Resource = previousResourceGlobal;
		try {
			rmSync(tempDir, { recursive: true, force: true });
		} catch {
			// best effort cleanup
		}
	});

	it('registers static-path and export-name parameterised routes from a loaded module', async () => {
		const file = join(tempDir, 'resources.mjs');
		writeFileSync(
			file,
			`export class Widget extends Resource {
				static path = '/widget/:id/action/:action';
				get(target) { return { id: target.id, action: target.action }; }
			}
			class ThingResource extends Resource {
				get(target) { return { id: target.id }; }
			}
			export { ThingResource as '/thing/:id' };
			`
		);

		const resources = new Resources();
		const scope = createScope(resources);
		await handleApplication(scope);
		await scope.run({ entryType: 'file', eventType: 'add', absolutePath: file, urlPath: '/resources.mjs' });

		const widget = resources.getMatch('widget/5/action/spin');
		assert.ok(widget, 'static-path route should be registered and matchable');
		assert.deepEqual(widget.params, { id: '5', action: 'spin' });

		const thing = resources.getMatch('thing/7');
		assert.ok(thing, 'export-name route should be registered and matchable');
		assert.deepEqual(thing.params, { id: '7' });
	});
});

describe('resolveResourcePath', () => {
	it('keeps root-relative paths (leading slash) at the top level', () => {
		assert.strictEqual(resolveResourcePath('app/dir', '/widget/:id'), 'widget/:id');
		assert.strictEqual(resolveResourcePath('', '/widget/:id'), 'widget/:id');
	});

	it('resolves ./ and bare paths relative to the component directory', () => {
		assert.strictEqual(resolveResourcePath('app/dir', './Widget'), 'app/dir/Widget');
		assert.strictEqual(resolveResourcePath('app/dir', 'Widget'), 'app/dir/Widget');
	});

	it('preserves the historical leading slash for a bare name with an empty prefix', () => {
		// `${prefix}/${name}` with an empty prefix yields a leading slash; Resources.set strips it, but plain-Map
		// consumers (e.g. the global-isolation component tests) rely on the exact `/Name` key.
		assert.strictEqual(resolveResourcePath('', 'Widget'), '/Widget');
	});

	it('normalizes a trailing slash so the route can match normalized request URLs', () => {
		assert.strictEqual(resolveResourcePath('app/dir', '/widget/:id/'), 'widget/:id');
		assert.strictEqual(resolveResourcePath('app/dir', './Widget/'), 'app/dir/Widget');
	});
});
