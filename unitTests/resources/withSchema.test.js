// RFC 0001 — Pillar 2: the per-method request contract (`defineResource` / `Resource.withSchema`).
// docs/rfcs/spikes/0001/enforce-schema.spike.ts + enforceSchema-real.check.ts are the type-level
// proof; this is the runtime: query coercion onto the narrowed target, structured 400s on bad
// query/body, the drop-in/subset registration shape, the metadata slots OpenAPI/MCP read, and a
// `defineTable` projection flowing into a contract body end-to-end.

require('../testUtils');
const assert = require('assert');
const { setupTestDBPath } = require('../testUtils');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { defineResource, t, schemaOf, projectTableFragment } = require('#src/resources/withSchema');
const { defineTable, types } = require('#src/resources/defineTable');
const { RequestTarget } = require('#src/resources/RequestTarget');
const { Resource } = require('#src/resources/Resource');

function targetWith(query, id) {
	const target = new RequestTarget(query ? `?${query}` : undefined);
	if (id !== undefined) target.id = id;
	return target;
}

describe('RFC 0001: withSchema / defineResource — runtime request contract', () => {
	describe('narrowed target — path param + query coercion', () => {
		let captured;
		const Widget = defineResource(
			{
				path: '/widget/:id',
				get: {
					query: {
						limit: t.integer.optional,
						flag: t.boolean.optional,
						expand: t.array(t.enum(['parts', 'owner'])).optional,
					},
				},
			},
			{
				async get(target) {
					captured = {
						id: target.id,
						limit: target.get('limit'),
						flag: target.get('flag'),
						expand: target.get('expand'),
						expandAll: target.getAll('expand'),
						raw: target.get('unknown'),
					};
					return { ok: true };
				},
			}
		);

		it('coerces declared query params and leaves the built-in grammar reachable', async () => {
			const target = targetWith('limit=5&flag=true&expand=parts&expand=owner', '123');
			await Widget.get(target);
			assert.strictEqual(captured.id, '123', 'path param bound onto target');
			assert.strictEqual(captured.limit, 5, 'integer coerced from string');
			assert.strictEqual(captured.flag, true, 'boolean coerced from string');
			assert.deepStrictEqual(captured.expand, ['parts', 'owner'], 'array coerced via getAll');
			assert.deepStrictEqual(captured.expandAll, ['parts', 'owner'], 'getAll returns the coerced array too');
			assert.strictEqual(captured.raw, null, 'undeclared query key falls back to string|null');
		});

		it('rejects an empty numeric query param instead of silently coercing to 0', () => {
			const Api = defineResource({ path: '/n', get: { query: { limit: t.integer.optional } } }, { async get() {} });
			let error;
			try {
				Api.get(targetWith('limit=', null));
			} catch (e) {
				error = e;
			}
			assert.ok(error, 'empty numeric param should be a type error, not 0');
			assert.ok(
				error.errors.some((i) => i.path === 'query.limit' && i.code === 'type'),
				JSON.stringify(error.errors)
			);
		});

		it('an absent optional query param reads as undefined', async () => {
			const target = targetWith('', '123');
			await Widget.get(target);
			assert.strictEqual(captured.limit, undefined);
			assert.deepStrictEqual(captured.expand, undefined);
		});
	});

	describe('structured 400s (ValidationError) before dispatch', () => {
		let ran = false;
		const Widget = defineResource(
			{
				path: '/widget/:id',
				get: { query: { limit: t.integer, mode: t.enum(['fast', 'slow']).optional } },
				post: { body: t.object({ name: t.string, count: t.integer }) },
			},
			{
				async get() {
					ran = true;
					return {};
				},
				async post() {
					ran = true;
					return {};
				},
			}
		);

		beforeEach(() => (ran = false));

		it('rejects a missing required query param with a per-field issue, not a joined string', () => {
			const target = targetWith('', '1');
			let error;
			try {
				Widget.get(target);
			} catch (e) {
				error = e;
			}
			assert.ok(error, 'should throw');
			assert.strictEqual(error.name, 'ValidationError');
			assert.strictEqual(error.statusCode, 400);
			assert.ok(Array.isArray(error.errors));
			assert.deepStrictEqual(error.errors[0], {
				path: 'query.limit',
				code: 'required',
				message: 'query.limit is required',
			});
			assert.strictEqual(ran, false, 'handler must not run on a 400');
		});

		it('rejects a bad-type query param and a bad enum value', () => {
			const target = targetWith('limit=abc&mode=warp', '1');
			let error;
			try {
				Widget.get(target);
			} catch (e) {
				error = e;
			}
			assert.ok(error);
			const codes = error.errors.map((i) => `${i.path}:${i.code}`);
			assert.ok(codes.includes('query.limit:type'), codes.join(','));
			assert.ok(codes.includes('query.mode:enum'), codes.join(','));
		});

		it('rejects a bad body with per-field issues (wrong type + missing required)', () => {
			const target = targetWith('', '1');
			let error;
			try {
				Widget.post(target, { name: 5 });
			} catch (e) {
				error = e;
			}
			assert.ok(error);
			assert.strictEqual(error.name, 'ValidationError');
			const codes = error.errors.map((i) => `${i.path}:${i.code}`);
			assert.ok(codes.includes('body.name:type'), codes.join(','));
			assert.ok(codes.includes('body.count:required'), codes.join(','));
			assert.strictEqual(ran, false);
		});

		it('passes a valid body through to the handler (coerced)', async () => {
			const target = targetWith('limit=1', '1');
			const result = await Widget.post(target, { name: 'ok', count: 3 });
			assert.deepStrictEqual(result, {});
			assert.strictEqual(ran, true);
		});

		it('does NOT validate programmatic (non-HTTP) calls — a plain object passes through', () => {
			// first arg is not a URLSearchParams → the wrapper delegates untouched
			assert.doesNotThrow(() => Widget.post({ notATarget: true }, { anything: 1 }));
		});
	});

	describe('nullability — non-nullable by default, .nullable opts in', () => {
		let ran;
		const Api = defineResource(
			{ path: '/x', post: { body: t.object({ name: t.string, note: t.string.nullable, tag: t.string.optional }) } },
			{
				async post(_target, data) {
					ran = true;
					return data;
				},
			}
		);
		beforeEach(() => (ran = false));

		it('rejects an explicit null for a non-nullable field', () => {
			let error;
			try {
				Api.post(targetWith('', null), { name: null });
			} catch (e) {
				error = e;
			}
			assert.ok(error, 'should reject null name');
			assert.ok(
				error.errors.some((i) => i.path === 'body.name' && i.code === 'nullable'),
				JSON.stringify(error.errors)
			);
			assert.strictEqual(ran, false);
		});

		it('accepts an explicit null for a .nullable field', async () => {
			const out = await Api.post(targetWith('', null), { name: 'a', note: null });
			assert.deepStrictEqual(out, { name: 'a', note: null });
			assert.strictEqual(ran, true);
		});

		it('still flags a genuinely missing required field as required (not null)', () => {
			let error;
			try {
				Api.post(targetWith('', null), { note: 'hi' });
			} catch (e) {
				error = e;
			}
			assert.ok(
				error.errors.some((i) => i.path === 'body.name' && i.code === 'required'),
				JSON.stringify(error.errors)
			);
		});
	});

	describe('drop-in / subset registration shape + metadata slots', () => {
		const Widget = defineResource(
			{
				path: '/widget/:id',
				record: schemaOf({ type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' } } }),
				get: { query: { expand: t.string.optional } },
				post: {
					body: t.object({ name: t.string }),
					response: schemaOf({ type: 'object', properties: { id: { type: 'string' } } }),
				},
			},
			{
				async get() {},
				async post() {},
			}
		);

		it('registers like a plain resource (path + verb functions, no wrapper leakage)', () => {
			assert.strictEqual(Widget.path, '/widget/:id');
			assert.strictEqual(typeof Widget.get, 'function');
			assert.strictEqual(typeof Widget.post, 'function');
			assert.strictEqual(Widget.put, undefined, 'undeclared verbs are not added');
		});

		it('exposes a prototype carrying the verbs so MCP/OpenAPI (which read .prototype) see them', () => {
			// Without this, a function-form resource is invisible to MCP and crashes OpenAPI at prototype.post.
			assert.strictEqual(typeof Widget.prototype.get, 'function');
			assert.strictEqual(typeof Widget.prototype.post, 'function');
		});

		it('lands the contract in the static slots OpenAPI/MCP read', () => {
			assert.ok(Widget.requestContract, 'requestContract slot set');
			// inputSchemas: per-verb query/body fragments
			assert.ok(Widget.inputSchemas.get.query.properties.expand, 'get query fragment');
			assert.strictEqual(Widget.inputSchemas.post.body.type, 'object', 'post body fragment');
			assert.ok(Widget.inputSchemas.post.body.properties.name, 'post body property');
			// outputSchemas: get defaults to the record; post uses the declared response
			assert.ok(Widget.outputSchemas.get.properties.name, 'get response defaults to record');
			assert.deepStrictEqual(Object.keys(Widget.outputSchemas.post.properties), ['id'], 'post response fragment');
			// properties: the record projection, for OpenAPI component $refs
			assert.ok(Widget.properties.name, 'record properties projected');
		});
	});

	describe('class form (Resource.withSchema)', () => {
		const Widget = Resource.withSchema({
			path: '/widget/:id',
			record: schemaOf({ type: 'object', properties: { id: { type: 'string' } } }),
			post: { body: t.object({ name: t.string }) },
		});

		it('is a Resource subclass carrying the contract metadata', () => {
			assert.ok(Widget.prototype instanceof Resource, 'extends Resource');
			assert.strictEqual(Widget.path, '/widget/:id');
			assert.ok(Widget.requestContract, 'requestContract slot set');
			assert.ok(Widget.inputSchemas.post.body.properties.name, 'input schema derived');
		});

		it('pins loadAsInstance=false so instance handlers get the converged (target, data) arg order', () => {
			// Harper dispatch (Resource.post/put/patch) only calls instance verbs as (target, data) when
			// loadAsInstance === false; the default (undefined) gives legacy (data, target). The narrowed
			// handler types assume (target, data), so this must be pinned or the types lie.
			assert.strictEqual(Widget.loadAsInstance, false);
		});
	});

	describe('projectTableFragment — a defineTable projection flows into a contract body end-to-end', () => {
		let Track;
		before(function () {
			setupTestDBPath();
			setMainIsWorker(true);
			Track = defineTable(
				'WsTrack',
				{
					id: types.id.primaryKey,
					name: types.string.indexed,
					duration: types.int.nullable,
					status: types.enum(['draft', 'published']).indexed,
					createdAt: types.date.createdTime,
				},
				{ database: 'withschema_test' }
			);
		});

		it('projects a nested-object attribute via its sub-properties (shared attributeToFragment fix)', () => {
			// A sub-object field carries `.properties` (sub-attributes); attributeToFragment must recurse
			// into them rather than emit the bare GraphQL type name as a JSON-Schema type.
			const fakeTable = {
				attributes: [
					{ name: 'id', type: 'String', isPrimaryKey: true },
					{
						name: 'meta',
						type: 'Meta',
						nullable: false,
						properties: [
							{ name: 'label', type: 'String', nullable: false },
							{ name: 'count', type: 'Int' },
						],
					},
				],
			};
			const record = projectTableFragment(fakeTable, 'record');
			assert.strictEqual(record.properties.meta.type, 'object', 'nested field projected as object, not a type name');
			assert.strictEqual(record.properties.meta.properties.label.type, 'string');
			assert.strictEqual(record.properties.meta.properties.count.type, 'integer');
		});

		it('projects insert: writable required fields, PK optional, server-managed excluded', () => {
			const insert = projectTableFragment(Track, 'insert');
			assert.strictEqual(insert.type, 'object');
			assert.ok(insert.properties.name, 'name present');
			assert.ok(insert.properties.status, 'status present');
			assert.ok(!insert.properties.createdAt, 'server-managed field excluded from insert');
			assert.ok(insert.required.includes('name'), 'required non-null field');
			assert.ok(insert.required.includes('status'), 'required non-null field');
			assert.ok(!insert.required.includes('id'), 'PK optional on insert');
			assert.ok(!insert.required.includes('duration'), 'nullable field optional');
		});

		it('validates a POST body derived from the table projection (structured 400 + happy path)', async () => {
			let ran = false;
			const Api = defineResource(
				{ path: '/tracks', post: { body: schemaOf({ table: Track, projection: 'insert' }) } },
				{
					async post(_target, data) {
						ran = true;
						return data;
					},
				}
			);
			// missing required `status` → structured 400 naming the field, handler never runs
			let error;
			try {
				Api.post(targetWith('', null), { name: 'Intro' });
			} catch (e) {
				error = e;
			}
			assert.ok(error, 'should reject incomplete body');
			assert.strictEqual(error.name, 'ValidationError');
			assert.ok(
				error.errors.some((i) => i.path === 'body.status' && i.code === 'required'),
				JSON.stringify(error.errors)
			);
			assert.strictEqual(ran, false);
			// valid body passes through
			const out = await Api.post(targetWith('', null), { name: 'Intro', status: 'draft' });
			assert.deepStrictEqual(out, { name: 'Intro', status: 'draft' });
			assert.strictEqual(ran, true);
		});
	});
});
