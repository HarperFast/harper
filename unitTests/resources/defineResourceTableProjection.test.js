// A table-projected request-contract body applies Table.validate's null/required rules at every depth
// and t.date's policy to Date columns; a validated body must be present unless its schema is `.optional`.
require('../testUtils');
const assert = require('assert');
const { setupTestDBPath } = require('../testUtils');
const { setMainIsWorker } = require('#src/server/threads/manageThreads');
const { defineResource, t, schemaOf, projectTableFragment } = require('#src/resources/defineResource');
const { defineTable, types } = require('#src/resources/defineTable');
const { RequestTarget } = require('#src/resources/RequestTarget');
const { Resource } = require('#src/resources/Resource');

const echo = async (_target, data) => data;

function rejectsWith(promiseFn, path, code) {
	return assert.rejects(
		async () => promiseFn(),
		(err) => {
			assert.strictEqual(err.name, 'ValidationError');
			assert.strictEqual(err.statusCode, 400);
			assert.ok(
				err.errors.some((e) => e.path === path && e.code === code),
				`expected ${path}:${code}, got ${JSON.stringify(err.errors)}`
			);
			return true;
		}
	);
}

const nestedTable = {
	attributes: [
		{ name: 'id', type: 'String', isPrimaryKey: true },
		{ name: 'title', type: 'String', nullable: false },
		{
			name: 'meta',
			type: 'Meta',
			properties: [
				{ name: 'label', type: 'String', nullable: false },
				{ name: 'count', type: 'Int' },
				{ name: 'seenAt', type: 'Date' },
				{ name: 'owner', type: 'Owner', relationship: { from: 'ownerId' } },
			],
		},
		{ name: 'tags', type: 'array', elements: { type: 'String' } },
		{ name: 'codes', type: 'array', elements: { type: 'String', nullable: false } },
		{
			name: 'events',
			type: 'array',
			elements: {
				type: 'Event',
				properties: [
					{ name: 'at', type: 'Date', nullable: false },
					{ name: 'note', type: 'String' },
				],
			},
		},
	],
};

describe('defineResource table projection + body presence', () => {
	let DateTable;
	let ControlTable;

	before(function () {
		setupTestDBPath();
		setMainIsWorker(true);
		ControlTable = defineTable(
			'ProjControlTrack',
			{ id: types.id.primaryKey, title: types.string.indexed, duration: types.int.nullable },
			{ database: 'defineresource_projection_test' }
		);
		DateTable = defineTable(
			'ProjDateTrack',
			{ id: types.id.primaryKey, title: types.string.indexed, releasedAt: types.date, archivedAt: types.date.nullable },
			{ database: 'defineresource_projection_test' }
		);
	});

	describe('Date columns', () => {
		let Api;
		before(() => {
			Api = defineResource(
				{ path: '/date-tracks', post: { body: schemaOf({ table: DateTable, projection: 'insert' }) } },
				{ post: echo }
			);
		});

		it('accepts a Date instance', async () => {
			const out = await Api.post(new RequestTarget('/date-tracks'), {
				title: 'Song',
				releasedAt: new Date('2026-01-01T00:00:00.000Z'),
			});
			assert.ok(out.releasedAt instanceof Date);
			assert.strictEqual(out.releasedAt.toISOString(), '2026-01-01T00:00:00.000Z');
		});

		it('coerces an ISO-8601 string to a Date and rejects an invalid one with code: format', async () => {
			const out = await Api.post(new RequestTarget('/date-tracks'), {
				title: 'Song',
				releasedAt: '2026-01-01T00:00:00.000Z',
			});
			assert.ok(out.releasedAt instanceof Date, `got ${typeof out.releasedAt}`);
			assert.strictEqual(out.releasedAt.toISOString(), '2026-01-01T00:00:00.000Z');
			await rejectsWith(
				() => Api.post(new RequestTarget('/date-tracks'), { title: 'Song', releasedAt: 'not-a-date' }),
				'body.releasedAt',
				'format'
			);
		});

		it('still accepts null on a nullable Date column', async () => {
			const releasedAt = new Date('2026-01-01T00:00:00.000Z');
			const out = await Api.post(new RequestTarget('/date-tracks'), { title: 'Song', releasedAt, archivedAt: null });
			assert.strictEqual(out.archivedAt, null);
		});
	});

	describe('nested properties and array elements', () => {
		let Api;
		before(() => {
			Api = defineResource(
				{
					path: '/nested-tracks',
					post: { body: schemaOf({ table: nestedTable, projection: 'insert' }) },
					patch: { body: schemaOf({ table: nestedTable, projection: 'patch' }) },
				},
				{ post: echo, patch: echo }
			);
		});

		it('rejects a missing nullable:false nested property', async () => {
			await rejectsWith(
				() => Api.post(new RequestTarget('/nested-tracks'), { title: 'Song', meta: {} }),
				'body.meta.label',
				'required'
			);
		});

		it('rejects a missing nested required property in a patch too', async () => {
			await rejectsWith(
				() => Api.patch(new RequestTarget('/nested-tracks/1'), { meta: { count: 1 } }),
				'body.meta.label',
				'required'
			);
		});

		it('accepts explicit null for a nullable nested property and nullable array element', async () => {
			const out = await Api.post(new RequestTarget('/nested-tracks'), {
				title: 'Song',
				meta: { label: 'ok', count: null },
				tags: [null],
			});
			assert.deepStrictEqual(out, { title: 'Song', meta: { label: 'ok', count: null }, tags: [null] });
		});

		it('rejects null and undefined for a nullable:false array element', async () => {
			await rejectsWith(
				() => Api.post(new RequestTarget('/nested-tracks'), { title: 'Song', codes: ['a', null] }),
				'body.codes[1]',
				'nullable'
			);
			await rejectsWith(
				() => Api.post(new RequestTarget('/nested-tracks'), { title: 'Song', codes: [undefined] }),
				'body.codes[0]',
				'required'
			);
			const out = await Api.post(new RequestTarget('/nested-tracks'), { title: 'Song', tags: [undefined] });
			assert.deepStrictEqual(out.tags, [undefined]);
		});

		it('applies Date coercion and requiredness inside nested objects and object-in-array elements', async () => {
			const out = await Api.post(new RequestTarget('/nested-tracks'), {
				title: 'Song',
				meta: { label: 'ok', seenAt: '2026-02-01T00:00:00.000Z' },
				events: [{ at: '2026-03-01T00:00:00.000Z' }, { at: new Date('2026-04-01T00:00:00.000Z'), note: null }],
			});
			assert.ok(out.meta.seenAt instanceof Date);
			assert.ok(out.events[0].at instanceof Date);
			assert.strictEqual(out.events[1].at.toISOString(), '2026-04-01T00:00:00.000Z');
			await rejectsWith(
				() => Api.post(new RequestTarget('/nested-tracks'), { title: 'Song', events: [{ note: 'x' }] }),
				'body.events[0].at',
				'required'
			);
			await rejectsWith(
				() => Api.post(new RequestTarget('/nested-tracks'), { title: 'Song', meta: { label: 'ok', seenAt: 'nope' } }),
				'body.meta.seenAt',
				'format'
			);
		});

		it('drops relationship sub-attributes and leaves the source attributes untouched', () => {
			const before = JSON.stringify(nestedTable);
			const fragment = projectTableFragment(nestedTable, 'record');
			assert.ok(!('owner' in fragment.properties.meta.properties));
			assert.deepStrictEqual(fragment.properties.meta.required, ['label']);
			assert.strictEqual(JSON.stringify(nestedTable), before);
		});
	});

	describe('body presence', () => {
		it('rejects a missing body on non-optional schemas without top-level required keys', async () => {
			let ran = false;
			const Api = defineResource(
				{
					path: '/items',
					patch: { body: schemaOf({ table: ControlTable, projection: 'patch' }) },
					post: { body: t.array(t.string) },
				},
				{
					async patch() {
						ran = true;
					},
					async post() {
						ran = true;
					},
				}
			);
			await rejectsWith(() => Api.patch(new RequestTarget('/items/1'), undefined), 'body', 'required');
			await rejectsWith(() => Api.post(new RequestTarget('/items'), Promise.resolve(undefined)), 'body', 'required');
			assert.strictEqual(ran, false, 'handler must not run when a required body is missing');
		});

		it('keeps per-field issues for a missing body whose schema has required keys', async () => {
			const Api = defineResource({ path: '/named', post: { body: t.object({ name: t.string }) } }, { post: echo });
			await rejectsWith(() => Api.post(new RequestTarget('/named'), undefined), 'body.name', 'required');
		});

		it('rejects a missing PUT body defaulted from contract.record', async () => {
			const Api = defineResource({ path: '/rec', record: t.array(t.integer), put: {} }, { put: echo });
			await rejectsWith(() => Api.put(new RequestTarget('/rec/1'), undefined), 'body', 'required');
		});

		it('accepts an omitted body when the body schema is .optional, in both forms', async () => {
			const Api = defineResource(
				{ path: '/opt', post: { body: t.object({ name: t.string }).optional } },
				{ post: async (_target, data) => ({ received: data }) }
			);
			assert.deepStrictEqual(await Api.post(new RequestTarget('/opt'), undefined), { received: undefined });
			await rejectsWith(() => Api.post(new RequestTarget('/opt'), {}), 'body.name', 'required');

			class OptClass extends Resource.withSchema({ path: '/opt-class', post: { body: t.array(t.string).optional } }) {
				async post(_target, data) {
					return { received: data };
				}
			}
			// three arguments, as REST dispatches; the two-argument form reads the target as the body
			assert.deepStrictEqual(await OptClass.post(new RequestTarget('/opt-class'), undefined, {}), {
				received: undefined,
			});
		});

		it('treats a null body (an empty JSON request) as present: .optional rejects it, .optional.nullable accepts it', async () => {
			const Api = defineResource(
				{
					path: '/nullbody',
					post: { body: t.object({ name: t.string }).optional },
					put: { body: t.object({ name: t.string }).optional.nullable },
				},
				{ post: async (_target, data) => ({ received: data }), put: async (_target, data) => ({ received: data }) }
			);
			await rejectsWith(() => Api.post(new RequestTarget('/nullbody'), null), 'body', 'nullable');
			assert.deepStrictEqual(await Api.put(new RequestTarget('/nullbody/1'), null), { received: null });
		});

		it('leaves passthrough bodies and programmatic calls unchecked', async () => {
			const Api = defineResource(
				{ path: '/pass', post: { body: schemaOf() }, put: { body: t.array(t.string) } },
				{ post: async (_target, data) => ({ received: data }), put: async (_target, data) => ({ received: data }) }
			);
			assert.deepStrictEqual(await Api.post(new RequestTarget('/pass'), undefined), { received: undefined });
			assert.deepStrictEqual(await Api.put({ id: 1 }, undefined), { received: undefined });
		});

		it('publishes bodyRequired beside the body fragment', () => {
			const Api = defineResource(
				{ path: '/meta', post: { body: t.array(t.string) }, patch: { body: t.object({ a: t.string }).optional } },
				{ post: echo, patch: echo }
			);
			assert.strictEqual(Api.inputSchemas.post.bodyRequired, true);
			assert.strictEqual(Api.inputSchemas.patch.bodyRequired, false);
			assert.ok(!('optional' in Api.inputSchemas.patch.body));
		});
	});
});
