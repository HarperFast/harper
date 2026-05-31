const assert = require('node:assert/strict');
const {
	registerApplicationTools,
	_setResourcesForTest,
	_setRequestTargetForTest,
} = require('#src/components/mcp/tools/application');
const { listTools, getTool, _resetRegistryForTest } = require('#src/components/mcp/toolRegistry');

const SUPER = { username: 'admin', role: { permission: { super_user: true } } };
const ALICE_READ = {
	username: 'alice',
	role: { permission: { data: { tables: { product: { read: true, describe: true } } } } },
};
const ALICE_WRITE = {
	username: 'alice',
	role: {
		permission: {
			data: { tables: { product: { read: true, insert: true, update: true, delete: true, describe: true } } },
		},
	},
};
const NOBODY = { username: 'nobody', role: { permission: {} } };

/**
 * Returns a Resource-class-like constructor with arbitrary prototype methods
 * for verb-presence checks plus mockable static handlers.
 */
function makeTableResource({
	databaseName,
	tableName,
	primaryKey = 'id',
	attributes = [],
	verbs = ['get', 'put', 'patch', 'delete', 'search', 'post'],
	staticHandlers = {},
} = {}) {
	class Cls {}
	Cls.databaseName = databaseName;
	Cls.tableName = tableName;
	Cls.primaryKey = primaryKey;
	Cls.attributes = attributes;
	for (const v of verbs) {
		Cls.prototype[v] = function () {};
	}
	// Static handlers default to identity-ish behavior; tests can override.
	Cls.get = staticHandlers.get ?? (async (target) => ({ id: target.id, name: 'sample' }));
	Cls.put = staticHandlers.put ?? (async () => ({ ok: true }));
	Cls.patch = staticHandlers.patch ?? (async () => ({ ok: true }));
	Cls.post = staticHandlers.post ?? (async (_target, data) => ({ created: true, ...data }));
	Cls.delete = staticHandlers.delete ?? (async () => ({ deleted: true }));
	Cls.search = staticHandlers.search ?? (async () => [{ id: '1' }, { id: '2' }]);
	return Cls;
}

function makeRegistry(entries) {
	const m = new Map();
	for (const [path, entry] of entries) {
		m.set(path, {
			path,
			Resource: entry.Resource,
			exportTypes: entry.exportTypes,
			hasSubPaths: false,
			relativeURL: '',
		});
	}
	return m;
}

class FakeRequestTarget {}

describe('mcp/tools/application — registration', () => {
	beforeEach(() => {
		_resetRegistryForTest();
		_setRequestTargetForTest(FakeRequestTarget);
	});

	afterEach(() => {
		_resetRegistryForTest();
		_setResourcesForTest(undefined);
		_setRequestTargetForTest(undefined);
	});

	it('emits get_/search_/create_/update_/delete_ tools for a fully-implemented Resource', () => {
		const Product = makeTableResource({
			databaseName: 'data',
			tableName: 'product',
			attributes: [
				{ name: 'id', type: 'ID', isPrimaryKey: true },
				{ name: 'name', type: 'String' },
			],
		});
		_setResourcesForTest(makeRegistry([['Product', { Resource: Product }]]));

		registerApplicationTools();
		const names = listTools({ user: SUPER, profile: 'application', sessionId: 's', limit: 200 }).tools.map(
			(t) => t.name
		);
		assert.deepEqual(names.sort(), [
			'create_Product',
			'delete_Product',
			'get_Product',
			'search_Product',
			'update_Product',
		]);
	});

	it('publishes only the verbs the Resource implements', () => {
		const ReadOnly = makeTableResource({
			databaseName: 'data',
			tableName: 'view',
			verbs: ['get', 'search'],
		});
		_setResourcesForTest(makeRegistry([['View', { Resource: ReadOnly }]]));
		registerApplicationTools();
		const names = listTools({ user: SUPER, profile: 'application', sessionId: 's', limit: 200 }).tools.map(
			(t) => t.name
		);
		assert.deepEqual(names.sort(), ['get_View', 'search_View']);
	});

	it('skips Resources with no REST verbs on the prototype', () => {
		const Bare = makeTableResource({ databaseName: 'data', tableName: 'silent', verbs: [] });
		_setResourcesForTest(makeRegistry([['Silent', { Resource: Bare }]]));
		registerApplicationTools();
		const names = listTools({ user: SUPER, profile: 'application', sessionId: 's', limit: 200 }).tools.map(
			(t) => t.name
		);
		assert.deepEqual(names, []);
	});

	describe('exportTypes gating', () => {
		it('skips Resources with exportTypes.mcp === false', () => {
			const Hidden = makeTableResource({ databaseName: 'data', tableName: 'hidden' });
			_setResourcesForTest(makeRegistry([['Hidden', { Resource: Hidden, exportTypes: { mcp: false } }]]));
			registerApplicationTools();
			const names = listTools({ user: SUPER, profile: 'application', sessionId: 's', limit: 200 }).tools.map(
				(t) => t.name
			);
			assert.deepEqual(names, []);
		});

		it('publishes Resources with exportTypes.http === false (mcp flag is the only gate)', () => {
			const NoHttp = makeTableResource({ databaseName: 'data', tableName: 'nohttp', verbs: ['get'] });
			_setResourcesForTest(makeRegistry([['NoHttp', { Resource: NoHttp, exportTypes: { http: false } }]]));
			registerApplicationTools();
			const names = listTools({ user: SUPER, profile: 'application', sessionId: 's', limit: 200 }).tools.map(
				(t) => t.name
			);
			assert.deepEqual(names, ['get_NoHttp']);
		});

		it('publishes Resources with exportTypes = { mcp: true, http: true }', () => {
			const Public = makeTableResource({ databaseName: 'data', tableName: 'public', verbs: ['get'] });
			_setResourcesForTest(makeRegistry([['Public', { Resource: Public, exportTypes: { mcp: true, http: true } }]]));
			registerApplicationTools();
			const names = listTools({ user: SUPER, profile: 'application', sessionId: 's', limit: 200 }).tools.map(
				(t) => t.name
			);
			assert.deepEqual(names, ['get_Public']);
		});

		it('publishes Resources with no exportTypes at all (defaults to enabled)', () => {
			const Default = makeTableResource({ databaseName: 'data', tableName: 'default', verbs: ['get'] });
			_setResourcesForTest(makeRegistry([['Default', { Resource: Default }]]));
			registerApplicationTools();
			const names = listTools({ user: SUPER, profile: 'application', sessionId: 's', limit: 200 }).tools.map(
				(t) => t.name
			);
			assert.deepEqual(names, ['get_Default']);
		});
	});

	it('sanitizes paths with / and . into _-safe tool names', () => {
		const Nested = makeTableResource({ databaseName: 'data', tableName: 'nested', verbs: ['get'] });
		_setResourcesForTest(makeRegistry([['my.feature/Nested', { Resource: Nested }]]));
		registerApplicationTools();
		const names = listTools({ user: SUPER, profile: 'application', sessionId: 's', limit: 200 }).tools.map(
			(t) => t.name
		);
		assert.deepEqual(names, ['get_my_feature_Nested']);
	});

	it('disambiguates colliding sanitized names by prefixing the database', () => {
		const A = makeTableResource({ databaseName: 'inventory', tableName: 'a', verbs: ['get'] });
		const B = makeTableResource({ databaseName: 'orders', tableName: 'b', verbs: ['get'] });
		_setResourcesForTest(
			makeRegistry([
				['catalog/item', { Resource: A }],
				['catalog.item', { Resource: B }], // sanitizes to the same suffix
			])
		);
		registerApplicationTools();
		const names = listTools({ user: SUPER, profile: 'application', sessionId: 's', limit: 200 }).tools.map(
			(t) => t.name
		);
		// First one wins the base name; second gets the db-prefixed form.
		assert.ok(names.includes('get_catalog_item'));
		assert.ok(names.some((n) => /^get_orders_catalog_item$/.test(n) || /^get_catalog_item_[0-9a-f]{6}$/.test(n)));
	});

	it('visibleTo predicate gates by table-level read perm for get_/search_', () => {
		const Product = makeTableResource({
			databaseName: 'data',
			tableName: 'product',
			attributes: [{ name: 'id', type: 'ID', isPrimaryKey: true }],
		});
		_setResourcesForTest(makeRegistry([['Product', { Resource: Product }]]));
		registerApplicationTools();
		const getProduct = getTool('get_Product');
		assert.equal(getProduct.visibleTo(SUPER), true);
		assert.equal(getProduct.visibleTo(ALICE_READ), true);
		assert.equal(getProduct.visibleTo(NOBODY), false);
	});

	it('visibleTo for delete_/update_/create_ gates by the matching write perm', () => {
		const Product = makeTableResource({ databaseName: 'data', tableName: 'product' });
		_setResourcesForTest(makeRegistry([['Product', { Resource: Product }]]));
		registerApplicationTools();
		const del = getTool('delete_Product');
		const create = getTool('create_Product');
		const update = getTool('update_Product');
		assert.equal(del.visibleTo(ALICE_READ), false, 'read-only Alice cannot see delete');
		assert.equal(create.visibleTo(ALICE_READ), false);
		assert.equal(update.visibleTo(ALICE_READ), false);
		assert.equal(del.visibleTo(ALICE_WRITE), true, 'write-capable Alice can see delete');
		assert.equal(create.visibleTo(ALICE_WRITE), true);
		assert.equal(update.visibleTo(ALICE_WRITE), true);
	});

	it('flags delete_ tools as destructive and get_/search_ as readOnly', () => {
		const Product = makeTableResource({ databaseName: 'data', tableName: 'product' });
		_setResourcesForTest(makeRegistry([['Product', { Resource: Product }]]));
		registerApplicationTools();
		assert.equal(getTool('get_Product').annotations?.readOnlyHint, true);
		assert.equal(getTool('search_Product').annotations?.readOnlyHint, true);
		assert.equal(getTool('delete_Product').annotations?.destructiveHint, true);
	});
});

describe('mcp/tools/application — custom mcpTools opt-in (#622)', () => {
	beforeEach(() => {
		_resetRegistryForTest();
		_setRequestTargetForTest(FakeRequestTarget);
	});
	afterEach(() => {
		_resetRegistryForTest();
		_setResourcesForTest(undefined);
		_setRequestTargetForTest(undefined);
	});

	it('registers a tool from a static mcpTools declaration', () => {
		class Recommendations {
			async recommendSimilar() {
				return { ok: true };
			}
		}
		Recommendations.mcpTools = [
			{
				name: 'recommend_similar',
				method: 'recommendSimilar',
				description: 'Get N similar products',
				inputSchema: { type: 'object', properties: { productId: { type: 'string' } }, required: ['productId'] },
			},
		];
		_setResourcesForTest(makeRegistry([['Recommendations', { Resource: Recommendations }]]));
		registerApplicationTools();
		const tool = getTool('recommend_similar');
		assert.ok(tool, 'tool registered');
		assert.equal(tool.description, 'Get N similar products');
		assert.equal(tool.inputSchema.required[0], 'productId');
		assert.equal(tool.visibleTo(NOBODY), true, 'visibleTo always true (Resource enforces ACL itself)');
	});

	it('dispatches to the named instance method with parsed args', async () => {
		let captured;
		class Recommendations {
			async recommendSimilar(args) {
				captured = args;
				return { results: ['a', 'b', 'c'].slice(0, args.limit) };
			}
		}
		Recommendations.mcpTools = [{ name: 'recommend_similar', method: 'recommendSimilar' }];
		_setResourcesForTest(makeRegistry([['Recommendations', { Resource: Recommendations }]]));
		registerApplicationTools();
		const res = await getTool('recommend_similar').handler(
			{ productId: 'p1', limit: 2 },
			{ user: SUPER, profile: 'application', sessionId: 's' }
		);
		assert.deepEqual(captured, { productId: 'p1', limit: 2 });
		assert.deepEqual(res.structuredContent, { results: ['a', 'b'] });
	});

	it('handler errors from custom methods become isError=true', async () => {
		class BlowsUp {
			async kaboom() {
				throw new Error('not allowed');
			}
		}
		BlowsUp.mcpTools = [{ name: 'kaboom', method: 'kaboom' }];
		_setResourcesForTest(makeRegistry([['BlowsUp', { Resource: BlowsUp }]]));
		registerApplicationTools();
		const res = await getTool('kaboom').handler({}, { user: SUPER, profile: 'application', sessionId: 's' });
		assert.equal(res.isError, true);
		const payload = JSON.parse(res.content[0].text);
		assert.match(payload.message, /not allowed/);
	});

	it('skips invalid mcpTools entries (missing name or method)', () => {
		class Sloppy {
			async ok() {
				return {};
			}
		}
		Sloppy.mcpTools = [
			{ name: 'good_tool', method: 'ok' },
			{ name: 'no_method' }, // invalid — skipped
			{ method: 'nameless' }, // invalid — skipped
		];
		_setResourcesForTest(makeRegistry([['Sloppy', { Resource: Sloppy }]]));
		registerApplicationTools();
		const names = listTools({ user: SUPER, profile: 'application', sessionId: 's', limit: 200 }).tools.map(
			(t) => t.name
		);
		assert.ok(names.includes('good_tool'));
		assert.equal(names.length, 1, 'invalid entries are skipped, only good_tool registers');
	});

	it('skips mcpTools entries pointing at a non-existent method on the prototype', () => {
		class Mismatched {}
		Mismatched.mcpTools = [{ name: 'phantom', method: 'doesNotExist' }];
		_setResourcesForTest(makeRegistry([['Mismatched', { Resource: Mismatched }]]));
		registerApplicationTools();
		assert.equal(getTool('phantom'), undefined);
	});

	it('Resources with only mcpTools (no REST verbs) still register the custom tools', () => {
		class CustomOnly {
			async hello() {
				return { greeting: 'hi' };
			}
		}
		CustomOnly.mcpTools = [{ name: 'say_hello', method: 'hello' }];
		_setResourcesForTest(makeRegistry([['CustomOnly', { Resource: CustomOnly }]]));
		registerApplicationTools();
		assert.ok(getTool('say_hello'), 'custom-only Resources still publish their mcpTools');
	});

	it('Resources can publish both verb tools AND custom tools', async () => {
		const Product = makeTableResource({ databaseName: 'data', tableName: 'product', verbs: ['get'] });
		Product.prototype.bulkDiscount = async function (args) {
			return { applied: args.percent };
		};
		Product.mcpTools = [{ name: 'bulk_discount', method: 'bulkDiscount' }];
		_setResourcesForTest(makeRegistry([['Product', { Resource: Product }]]));
		registerApplicationTools();
		const names = listTools({ user: SUPER, profile: 'application', sessionId: 's', limit: 200 }).tools.map(
			(t) => t.name
		);
		assert.ok(names.includes('get_Product'), 'verb tool still emitted');
		assert.ok(names.includes('bulk_discount'), 'custom tool also emitted');
	});
});

describe('mcp/tools/application — leak invariants', () => {
	beforeEach(() => {
		_resetRegistryForTest();
		_setRequestTargetForTest(FakeRequestTarget);
	});
	afterEach(() => {
		_resetRegistryForTest();
		_setResourcesForTest(undefined);
		_setRequestTargetForTest(undefined);
	});

	it('a Resource never added to the registry is never enumerated', () => {
		const Inside = makeTableResource({ databaseName: 'data', tableName: 'inside', verbs: ['get'] });
		// `Outside` is constructed but NOT added to the registry — should
		// remain completely invisible to MCP enumeration.
		makeTableResource({ databaseName: 'data', tableName: 'outside', verbs: ['get'] });
		_setResourcesForTest(makeRegistry([['Inside', { Resource: Inside }]]));
		registerApplicationTools();
		const names = listTools({ user: SUPER, profile: 'application', sessionId: 's', limit: 200 }).tools.map(
			(t) => t.name
		);
		assert.deepEqual(names, ['get_Inside']);
	});
});

describe('mcp/tools/application — handler dispatch', () => {
	beforeEach(() => {
		_resetRegistryForTest();
		_setRequestTargetForTest(FakeRequestTarget);
	});
	afterEach(() => {
		_resetRegistryForTest();
		_setResourcesForTest(undefined);
		_setRequestTargetForTest(undefined);
	});

	it('get_ passes the id + select onto the static Resource.get', async () => {
		let captured;
		const Product = makeTableResource({
			databaseName: 'data',
			tableName: 'product',
			verbs: ['get'],
			staticHandlers: {
				get: async (target, context) => {
					captured = { id: target.id, select: target.select, user: context.user.username };
					return { id: target.id, name: 'widget' };
				},
			},
		});
		_setResourcesForTest(makeRegistry([['Product', { Resource: Product }]]));
		registerApplicationTools();
		const res = await getTool('get_Product').handler(
			{ id: '42', get_attributes: ['id', 'name'] },
			{ user: SUPER, profile: 'application', sessionId: 's' }
		);
		assert.equal(captured.id, '42');
		assert.deepEqual(captured.select, ['id', 'name']);
		assert.equal(captured.user, 'admin');
		assert.equal(res.isError, undefined);
		assert.deepEqual(res.structuredContent, { id: '42', name: 'widget' });
	});

	it('search_ enforces limit cap, encodes nextCursor when more pages exist', async () => {
		const rows = Array.from({ length: 21 }, (_, i) => ({ id: String(i) }));
		const Product = makeTableResource({
			databaseName: 'data',
			tableName: 'product',
			verbs: ['search'],
			staticHandlers: {
				search: async (target) => rows.slice(target.offset, target.offset + target.limit),
			},
		});
		_setResourcesForTest(makeRegistry([['Product', { Resource: Product }]]));
		registerApplicationTools();
		const res = await getTool('search_Product').handler(
			{ limit: 10 },
			{ user: SUPER, profile: 'application', sessionId: 's' }
		);
		assert.equal(res.isError, undefined);
		const body = res.structuredContent;
		assert.equal(body.rows.length, 10);
		assert.ok(body.nextCursor, 'nextCursor present when more rows remain');
	});

	it('search_ omits nextCursor on the last page', async () => {
		const Product = makeTableResource({
			databaseName: 'data',
			tableName: 'product',
			verbs: ['search'],
			staticHandlers: {
				search: async () => [{ id: '1' }, { id: '2' }],
			},
		});
		_setResourcesForTest(makeRegistry([['Product', { Resource: Product }]]));
		registerApplicationTools();
		const res = await getTool('search_Product').handler(
			{ limit: 10 },
			{ user: SUPER, profile: 'application', sessionId: 's' }
		);
		assert.equal(res.structuredContent.nextCursor, undefined);
	});

	it('update_ separates id from the rest of the payload', async () => {
		let captured;
		const Product = makeTableResource({
			databaseName: 'data',
			tableName: 'product',
			verbs: ['put'],
			staticHandlers: {
				put: async (target, data) => {
					captured = { id: target.id, data };
					return { ok: true };
				},
			},
		});
		_setResourcesForTest(makeRegistry([['Product', { Resource: Product }]]));
		registerApplicationTools();
		await getTool('update_Product').handler(
			{ id: '42', name: 'widget', price: 9.99 },
			{ user: SUPER, profile: 'application', sessionId: 's' }
		);
		assert.equal(captured.id, '42');
		assert.deepEqual(captured.data, { name: 'widget', price: 9.99 });
		assert.equal('id' in captured.data, false, 'id is stripped from the data body');
	});

	it('handler exceptions surface as isError=true with kind=harper_error', async () => {
		const Product = makeTableResource({
			databaseName: 'data',
			tableName: 'product',
			verbs: ['get'],
			staticHandlers: {
				get: async () => {
					throw new Error('access denied to attribute ssn');
				},
			},
		});
		_setResourcesForTest(makeRegistry([['Product', { Resource: Product }]]));
		registerApplicationTools();
		const res = await getTool('get_Product').handler(
			{ id: '1' },
			{ user: SUPER, profile: 'application', sessionId: 's' }
		);
		assert.equal(res.isError, true);
		const payload = JSON.parse(res.content[0].text);
		assert.equal(payload.kind, 'harper_error');
		assert.match(payload.message, /access denied/);
	});
});
