const assert = require('node:assert/strict');
const {
	listResources,
	listResourceTemplates,
	readResource,
	_setResourcesForTest,
	_setOpenApiGeneratorForTest,
	_setHttpUrlPrefixForTest,
} = require('#src/components/mcp/resources');

function makeFakeResources(entries) {
	// Mirrors the shape of resources/Resources.ts — a Map with .getMatch(path).
	const map = new Map();
	for (const [path, ResourceClass] of entries) {
		map.set(path, {
			Resource: ResourceClass,
			path,
			exportTypes: {},
			hasSubPaths: false,
			relativeURL: '',
		});
	}
	map.getMatch = (url) => {
		// crude longest-prefix match for tests
		let best;
		for (const [p, entry] of map) {
			if (url === p || url.startsWith(p + '/')) {
				if (!best || p.length > best.path.length) best = entry;
			}
		}
		return best;
	};
	return map;
}

// Returns a class with REST verbs on its prototype (so the hasRestVerbs filter
// matches the way Harper's TableResource auto-binds verbs for table-backed
// Resources). `verbs: []` makes a fixture that has no REST surface — useful
// for testing the verb-presence filter.
function makeTableResource({
	databaseName,
	tableName,
	primaryKey = 'id',
	attributes = [],
	verbs = ['get', 'put', 'patch', 'delete'],
} = {}) {
	class Cls {}
	Cls.databaseName = databaseName;
	Cls.tableName = tableName;
	Cls.primaryKey = primaryKey;
	Cls.attributes = attributes;
	for (const v of verbs) {
		Cls.prototype[v] = function () {};
	}
	return Cls;
}

const SUPER = { username: 'admin', role: { permission: { super_user: true } } };
const ALICE_READ_ONLY = {
	username: 'alice',
	role: { permission: { data: { tables: { product: { read: true, describe: true } } } } },
};
const NOBODY = { username: 'nobody', role: { permission: {} } };

describe('mcp/resources', () => {
	beforeEach(() => {
		_setResourcesForTest(
			makeFakeResources([
				[
					'Product',
					makeTableResource({
						databaseName: 'data',
						tableName: 'product',
						attributes: [{ name: 'id' }, { name: 'name' }, { name: 'price' }],
					}),
				],
				[
					'Customer',
					makeTableResource({
						databaseName: 'data',
						tableName: 'customer',
						attributes: [{ name: 'id' }, { name: 'ssn' }],
					}),
				],
			])
		);
		_setOpenApiGeneratorForTest(() => ({ openapi: '3.0.3', info: { title: 'fake' }, paths: {} }));
	});
	afterEach(() => {
		_setResourcesForTest(undefined);
		_setOpenApiGeneratorForTest(undefined);
	});

	describe('listResources — synthetic harper:// URIs', () => {
		it('always includes harper://about on both profiles', () => {
			const opsResult = listResources({ user: SUPER, profile: 'operations' });
			const appResult = listResources({ user: SUPER, profile: 'application' });
			assert.ok(opsResult.resources.some((r) => r.uri === 'harper://about'));
			assert.ok(appResult.resources.some((r) => r.uri === 'harper://about'));
		});

		it('includes harper://operations only on the operations profile', () => {
			const opsResult = listResources({ user: SUPER, profile: 'operations' });
			const appResult = listResources({ user: SUPER, profile: 'application' });
			assert.ok(opsResult.resources.some((r) => r.uri === 'harper://operations'));
			assert.ok(!appResult.resources.some((r) => r.uri === 'harper://operations'));
		});

		it('includes harper://openapi only on the application profile', () => {
			const opsResult = listResources({ user: SUPER, profile: 'operations' });
			const appResult = listResources({ user: SUPER, profile: 'application' });
			assert.ok(!opsResult.resources.some((r) => r.uri === 'harper://openapi'));
			assert.ok(appResult.resources.some((r) => r.uri === 'harper://openapi'));
		});
	});

	describe('listResources — table schemas (harper://schema/...)', () => {
		it('lists every table backed by a Resource, regardless of caller perms', () => {
			// List-time RBAC walks are misleading — Resource access is
			// programmatic, so the list is everything and the read predicate
			// enforces. Verified for both an unprivileged user and super_user —
			// same list.
			const alice = listResources({ user: ALICE_READ_ONLY, profile: 'application' });
			const nobody = listResources({ user: NOBODY, profile: 'application' });
			const aliceUris = alice.resources.filter((r) => r.uri.startsWith('harper://schema/')).map((r) => r.uri);
			const nobodyUris = nobody.resources.filter((r) => r.uri.startsWith('harper://schema/')).map((r) => r.uri);
			assert.deepEqual(aliceUris.sort(), ['harper://schema/data/customer', 'harper://schema/data/product']);
			assert.deepEqual(nobodyUris, aliceUris);
		});

		it('produces deterministic order via URI sort', () => {
			const result = listResources({ user: SUPER, profile: 'application' });
			const uris = result.resources.map((r) => r.uri);
			const sorted = [...uris].sort();
			assert.deepEqual(uris, sorted);
		});
	});

	describe('listResources — pagination', () => {
		it('respects limit and returns nextCursor', () => {
			const page1 = listResources({ user: SUPER, profile: 'application', limit: 2 });
			assert.equal(page1.resources.length, 2);
			assert.ok(page1.nextCursor);
		});

		it('round-trips opaquely through nextCursor', () => {
			const all = listResources({ user: SUPER, profile: 'application', limit: 1000 }).resources;
			let collected = [];
			let cursor;
			for (let i = 0; i < 10; i++) {
				const page = listResources({ user: SUPER, profile: 'application', limit: 1, cursor });
				collected = collected.concat(page.resources);
				cursor = page.nextCursor;
				if (!cursor) break;
			}
			assert.deepEqual(
				collected.map((r) => r.uri),
				all.map((r) => r.uri)
			);
		});

		it('treats a bad cursor as offset 0', () => {
			const page = listResources({ user: SUPER, profile: 'application', limit: 1, cursor: '$$nonsense$$' });
			const first = listResources({ user: SUPER, profile: 'application', limit: 1 });
			assert.equal(page.resources[0].uri, first.resources[0].uri);
		});
	});

	describe('listResourceTemplates', () => {
		it('declares the harper://schema template on the application profile', () => {
			const templates = listResourceTemplates('application');
			assert.ok(templates.some((t) => t.uriTemplate === 'harper://schema/{database}/{table}'));
		});

		it('returns no application-only templates on the operations profile', () => {
			const templates = listResourceTemplates('operations');
			assert.equal(templates.length, 0);
		});
	});

	describe('readResource — harper://about', () => {
		it('returns server metadata for both profiles', async () => {
			const opsRes = await readResource({ uri: 'harper://about', user: SUPER, profile: 'operations' });
			assert.equal(opsRes.ok, true);
			const body = JSON.parse(opsRes.contents[0].text);
			assert.equal(body.serverInfo.name, 'harper-mcp');
			assert.equal(body.profile, 'operations');
			assert.deepEqual(body.protocolVersions, ['2025-06-18', '2025-03-26']);

			const appRes = await readResource({ uri: 'harper://about', user: SUPER, profile: 'application' });
			assert.equal(appRes.ok, true);
			assert.equal(JSON.parse(appRes.contents[0].text).profile, 'application');
		});
	});

	describe('readResource — harper://openapi', () => {
		it('returns the generated openapi doc on the application profile', async () => {
			const res = await readResource({ uri: 'harper://openapi', user: SUPER, profile: 'application' });
			assert.equal(res.ok, true);
			const body = JSON.parse(res.contents[0].text);
			assert.equal(body.openapi, '3.0.3');
		});

		it('refuses on the operations profile', async () => {
			const res = await readResource({ uri: 'harper://openapi', user: SUPER, profile: 'operations' });
			assert.equal(res.ok, false);
			assert.match(res.reason, /application profile/);
		});

		it('returns ok:false when the generator throws', async () => {
			_setOpenApiGeneratorForTest(() => {
				throw new Error('boom');
			});
			const res = await readResource({ uri: 'harper://openapi', user: SUPER, profile: 'application' });
			assert.equal(res.ok, false);
		});
	});

	describe('readResource — harper://schema/{db}/{table}', () => {
		it('returns Table.attributes for a user with read/describe perms', async () => {
			const res = await readResource({
				uri: 'harper://schema/data/product',
				user: ALICE_READ_ONLY,
				profile: 'application',
			});
			assert.equal(res.ok, true);
			const body = JSON.parse(res.contents[0].text);
			assert.equal(body.database, 'data');
			assert.equal(body.table, 'product');
			assert.deepEqual(
				body.attributes.map((a) => a.name),
				['id', 'name', 'price']
			);
		});

		it('rejects when the user has no read/describe permission', async () => {
			const res = await readResource({
				uri: 'harper://schema/data/customer',
				user: ALICE_READ_ONLY,
				profile: 'application',
			});
			assert.equal(res.ok, false);
			assert.match(res.reason, /permission denied/);
		});

		it('filters out attributes the user cannot read (attribute_permissions)', async () => {
			const ALICE_FILTERED = {
				username: 'alice',
				role: {
					permission: {
						data: {
							tables: {
								customer: {
									read: true,
									describe: true,
									attribute_permissions: [{ attribute_name: 'ssn', read: false }],
								},
							},
						},
					},
				},
			};
			const res = await readResource({
				uri: 'harper://schema/data/customer',
				user: ALICE_FILTERED,
				profile: 'application',
			});
			assert.equal(res.ok, true);
			const body = JSON.parse(res.contents[0].text);
			assert.deepEqual(
				body.attributes.map((a) => a.name),
				['id']
			);
		});

		it('returns ok:false when the table is unknown', async () => {
			const res = await readResource({
				uri: 'harper://schema/data/ghost',
				user: SUPER,
				profile: 'application',
			});
			assert.equal(res.ok, false);
			assert.match(res.reason, /table not found/);
		});
	});

	describe('readResource — harper://operations', () => {
		it('returns the operations catalog on the operations profile for super_user', async () => {
			const res = await readResource({ uri: 'harper://operations', user: SUPER, profile: 'operations' });
			assert.equal(res.ok, true);
			const body = JSON.parse(res.contents[0].text);
			assert.ok(Array.isArray(body.operations));
			assert.ok(body.operations.length > 0);
			assert.ok(body.operations.some((op) => op.name === 'describe_all'));
		});

		it('filters operations by role: structure_user sees structure ops only', async () => {
			const structureUser = { role: { permission: { structure_user: true } } };
			const res = await readResource({ uri: 'harper://operations', user: structureUser, profile: 'operations' });
			assert.equal(res.ok, true);
			const body = JSON.parse(res.contents[0].text);
			const names = body.operations.map((o) => o.name);
			assert.ok(names.includes('create_table'));
			assert.ok(!names.includes('add_node'));
		});

		it('returns an empty catalog for a user with no operations perms', async () => {
			const res = await readResource({ uri: 'harper://operations', user: NOBODY, profile: 'operations' });
			assert.equal(res.ok, true);
			const body = JSON.parse(res.contents[0].text);
			assert.deepEqual(body.operations, []);
		});

		it('refuses on the application profile', async () => {
			const res = await readResource({ uri: 'harper://operations', user: SUPER, profile: 'application' });
			assert.equal(res.ok, false);
			assert.match(res.reason, /operations profile/);
		});
	});

	describe('readResource — https://... (app profile)', () => {
		it('returns the Resource descriptor for a matched path (metadata only)', async () => {
			// The descriptor is a hint, not a capability — actual data fetches
			// go through tools where each Resource's allow* predicates run
			// per-record. Any authenticated user can resolve an existing path;
			// unknown paths still 404.
			const res = await readResource({
				uri: 'https://harper.example.com:9926/Product',
				user: NOBODY,
				profile: 'application',
			});
			assert.equal(res.ok, true);
			const body = JSON.parse(res.contents[0].text);
			assert.equal(body.path, 'Product');
			assert.equal(body.database, 'data');
			assert.equal(body.table, 'product');
		});

		it('returns ok:false when no resource matches', async () => {
			const res = await readResource({
				uri: 'https://harper.example.com:9926/Ghost',
				user: SUPER,
				profile: 'application',
			});
			assert.equal(res.ok, false);
			assert.match(res.reason, /no resource matches/);
		});

		it('refuses on the operations profile', async () => {
			const res = await readResource({
				uri: 'https://harper.example.com:9926/Product',
				user: SUPER,
				profile: 'operations',
			});
			assert.equal(res.ok, false);
			assert.match(res.reason, /application profile/);
		});
	});

	describe('listResources — https:// app Resources (verb-presence gating)', () => {
		beforeEach(() => {
			// Override the URL prefix so enumerateAppHttpResources actually
			// emits entries (otherwise it returns [] and the verb filter is
			// untested in isolation).
			_setHttpUrlPrefixForTest('https://app.test:9926');
			_setResourcesForTest(
				makeFakeResources([
					['HasVerbs', makeTableResource({ databaseName: 'data', tableName: 'product' })],
					[
						'NoVerbs',
						makeTableResource({
							databaseName: 'data',
							tableName: 'silent',
							verbs: [], // bare class, no REST methods
						}),
					],
				])
			);
		});
		afterEach(() => {
			_setHttpUrlPrefixForTest(undefined);
		});

		it('includes Resources whose prototype defines REST verbs', () => {
			const result = listResources({ user: SUPER, profile: 'application' });
			const httpUris = result.resources.filter((r) => r.uri.startsWith('https://')).map((r) => r.uri);
			assert.ok(httpUris.includes('https://app.test:9926/HasVerbs'));
		});

		it('excludes Resources with no REST verbs on the prototype', () => {
			const result = listResources({ user: SUPER, profile: 'application' });
			const httpUris = result.resources.filter((r) => r.uri.startsWith('https://')).map((r) => r.uri);
			assert.ok(!httpUris.includes('https://app.test:9926/NoVerbs'));
		});

		it('lists the same https:// surface for any caller (no list-time RBAC)', () => {
			const sup = listResources({ user: SUPER, profile: 'application' }).resources.filter((r) =>
				r.uri.startsWith('https://')
			);
			const nob = listResources({ user: NOBODY, profile: 'application' }).resources.filter((r) =>
				r.uri.startsWith('https://')
			);
			assert.deepEqual(
				sup.map((r) => r.uri),
				nob.map((r) => r.uri)
			);
		});
	});

	describe('exportTypes gating', () => {
		beforeEach(() => {
			_setHttpUrlPrefixForTest('https://app.test:9926');
		});
		afterEach(() => {
			_setHttpUrlPrefixForTest(undefined);
		});

		it('skips Resources with exportTypes.mcp === false from both harper:// schema and https:// enumeration', () => {
			const Public = makeTableResource({ databaseName: 'data', tableName: 'public' });
			const Hidden = makeTableResource({ databaseName: 'data', tableName: 'hidden' });
			const map = new Map([
				['Public', { Resource: Public, path: 'Public', exportTypes: undefined, hasSubPaths: false, relativeURL: '' }],
				[
					'Hidden',
					{ Resource: Hidden, path: 'Hidden', exportTypes: { mcp: false }, hasSubPaths: false, relativeURL: '' },
				],
			]);
			map.getMatch = (url, exportType) => {
				const entry = map.get(url);
				if (!entry) return undefined;
				if (exportType && entry.exportTypes && entry.exportTypes[exportType] === false) return undefined;
				return entry;
			};
			_setResourcesForTest(map);
			const result = listResources({ user: SUPER, profile: 'application' });
			const httpUris = result.resources.filter((r) => r.uri.startsWith('https://')).map((r) => r.uri);
			const schemaUris = result.resources.filter((r) => r.uri.startsWith('harper://schema/')).map((r) => r.uri);
			assert.ok(httpUris.includes('https://app.test:9926/Public'));
			assert.ok(!httpUris.some((u) => u.endsWith('/Hidden')));
			assert.ok(schemaUris.includes('harper://schema/data/public'));
			assert.ok(!schemaUris.includes('harper://schema/data/hidden'));
		});

		it('publishes Resources with exportTypes.http === false (mcp flag is the only gate)', () => {
			const NoHttp = makeTableResource({ databaseName: 'data', tableName: 'nohttp' });
			const map = new Map([
				[
					'NoHttp',
					{ Resource: NoHttp, path: 'NoHttp', exportTypes: { http: false }, hasSubPaths: false, relativeURL: '' },
				],
			]);
			map.getMatch = (url, exportType) => {
				const entry = map.get(url);
				if (!entry) return undefined;
				if (exportType && entry.exportTypes && entry.exportTypes[exportType] === false) return undefined;
				return entry;
			};
			_setResourcesForTest(map);
			const result = listResources({ user: SUPER, profile: 'application' });
			const httpUris = result.resources.filter((r) => r.uri.startsWith('https://')).map((r) => r.uri);
			const schemaUris = result.resources.filter((r) => r.uri.startsWith('harper://schema/')).map((r) => r.uri);
			assert.ok(httpUris.includes('https://app.test:9926/NoHttp'));
			assert.ok(schemaUris.includes('harper://schema/data/nohttp'));
		});

		it('a resource registered with exportTypes.mcp === false cannot be read via https://...', async () => {
			const Hidden = makeTableResource({ databaseName: 'data', tableName: 'hidden' });
			const map = new Map([
				[
					'Hidden',
					{ Resource: Hidden, path: 'Hidden', exportTypes: { mcp: false }, hasSubPaths: false, relativeURL: '' },
				],
			]);
			map.getMatch = (url, exportType) => {
				const entry = map.get(url);
				if (!entry) return undefined;
				if (exportType && entry.exportTypes && entry.exportTypes[exportType] === false) return undefined;
				return entry;
			};
			_setResourcesForTest(map);
			const res = await readResource({
				uri: 'https://app.test:9926/Hidden',
				user: SUPER,
				profile: 'application',
			});
			assert.equal(res.ok, false);
			assert.match(res.reason, /no resource matches/);
		});

		it('a resource not in the registry never enumerates', () => {
			// Build a class that's a *valid* Resource shape but is intentionally
			// absent from the registry. It should not surface anywhere in the MCP
			// list, even though it carries the right shape.
			makeTableResource({ databaseName: 'data', tableName: 'orphan' });
			const Visible = makeTableResource({ databaseName: 'data', tableName: 'visible' });
			const map = new Map([
				[
					'Visible',
					{ Resource: Visible, path: 'Visible', exportTypes: undefined, hasSubPaths: false, relativeURL: '' },
				],
			]);
			map.getMatch = (url) => map.get(url);
			_setResourcesForTest(map);
			const result = listResources({ user: SUPER, profile: 'application' });
			const allUris = result.resources.map((r) => r.uri);
			assert.ok(!allUris.some((u) => u.includes('orphan')));
			assert.ok(allUris.some((u) => u.includes('visible')));
		});
	});

	describe('readResource — error cases', () => {
		it('rejects an invalid URI', async () => {
			const res = await readResource({ uri: 'not a uri', user: SUPER, profile: 'application' });
			assert.equal(res.ok, false);
			assert.match(res.reason, /invalid uri/);
		});

		it('rejects an unknown scheme', async () => {
			const res = await readResource({ uri: 'ftp://example.com/foo', user: SUPER, profile: 'application' });
			assert.equal(res.ok, false);
			assert.match(res.reason, /unsupported uri scheme/);
		});

		it('rejects an unknown harper:// path', async () => {
			const res = await readResource({ uri: 'harper://nope', user: SUPER, profile: 'application' });
			assert.equal(res.ok, false);
			assert.match(res.reason, /unknown harper:\/\/ resource/);
		});
	});
});
