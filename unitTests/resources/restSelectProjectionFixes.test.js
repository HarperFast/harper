'use strict';

const assert = require('node:assert');
const { randomUUID } = require('node:crypto');
const { ExtendedIterable } = require('@harperfast/extended-iterable');
const { setupTestDBPath } = require('../testUtils');
const { table, getDatabases } = require('#src/resources/databases');
const { Resource } = require('#src/resources/Resource');
const { RequestTarget } = require('#src/resources/RequestTarget');
const Resources = require('#src/resources/Resources');
const { handleApplication: handleRest } = require('#src/server/REST');
const { ResourceBridge } = require('#src/dataLayer/harperBridge/ResourceBridge');
const opAuth = require('#src/utility/operation_authorization');
const { getWorkerIndex, setMainIsWorker } = require('#src/server/threads/manageThreads');
require('#src/server/serverHelpers/serverUtilities');

const superUser = { role: { permission: { super_user: true } } };

describe('REST and operations API select projection fixes', function () {
	const dbName = 'rest_select_projection_fixes';
	let Grandchild;
	let Child;
	let Parent;
	let ParentInstanceTrue;
	let ParentStaticFalse;
	let ParentSubclassOverride;
	let CustomEchoResource;
	let CustomInstanceEchoResource;
	let restHttp;
	let bridge;
	let previousMainIsWorker;
	const mounted = [];

	function mount(path, ResourceClass) {
		Resources.resources.set(path, ResourceClass);
		mounted.push(path);
		return path;
	}

	async function restGet(url, extraHeaders = {}, user = superUser) {
		const headerObject = { accept: 'application/json', ...extraHeaders };
		const response = await restHttp(
			{
				method: 'GET',
				url,
				pathname: url.split('?')[0],
				ip: '127.0.0.1',
				user,
				headers: {
					asObject: headerObject,
					get: (name) => headerObject[name.toLowerCase()],
				},
			},
			() => assert.fail(`no resource matched ${url}`)
		);
		let text = '';
		if (response.body) {
			if (typeof response.body === 'string' || Buffer.isBuffer(response.body)) {
				text = response.body.toString();
			} else {
				const chunks = [];
				for await (const chunk of response.body) chunks.push(Buffer.from(chunk));
				text = Buffer.concat(chunks).toString();
			}
		}
		let parsed;
		if (text) {
			try {
				parsed = JSON.parse(text);
			} catch {
				parsed = text;
			}
		}
		return {
			status: response.status,
			headers: response.headers,
			body: parsed,
			text,
		};
	}

	before(async function () {
		setupTestDBPath();
		previousMainIsWorker = getWorkerIndex() === 0;
		setMainIsWorker(true);
		if (!Resources.resources) Resources.resetResources();
		bridge = new ResourceBridge();

		Grandchild = table({
			database: dbName,
			table: 'Grandchild',
			attributes: [
				{ name: 'id', isPrimaryKey: true, type: 'String' },
				{ name: 'secret', type: 'String' },
			],
		});

		Child = table({
			database: dbName,
			table: 'Child',
			attributes: [
				{ name: 'id', isPrimaryKey: true, type: 'String' },
				{ name: 'parentId', type: 'String', indexed: true },
				{ name: 'label', type: 'String' },
				{ name: 'grandchildId', type: 'String', indexed: true },
				{
					name: 'grandchild',
					type: 'Grandchild',
					relationship: { from: 'grandchildId' },
					definition: { tableClass: Grandchild },
				},
			],
		});

		Parent = table({
			database: dbName,
			table: 'Parent',
			attributes: [
				{ name: 'id', isPrimaryKey: true, type: 'String' },
				{ name: 'title', type: 'String' },
				{ name: 'label', type: 'String' },
				{ name: 'childId', type: 'String', indexed: true },
				{ name: 'childIds', elements: { type: 'String' }, indexed: true },
				{ name: 'tags', elements: { type: 'String' } },
				{ name: 'addresses', elements: { type: 'Any' } },
				{ name: 'expiresAt', type: 'Float', expiresAt: true },
				{
					name: 'child',
					type: 'Child',
					relationship: { from: 'childId' },
					definition: { tableClass: Child },
				},
				{
					name: 'fromChildren',
					elements: { type: 'Child', definition: { tableClass: Child } },
					relationship: { from: 'childIds' },
				},
				{
					name: 'children',
					elements: { type: 'Child', definition: { tableClass: Child } },
					relationship: { to: 'parentId' },
				},
			],
		});

		ParentInstanceTrue = class extends Parent {
			static loadAsInstance = true;
		};

		ParentStaticFalse = class extends Parent {
			static loadAsInstance = false;
		};

		ParentSubclassOverride = class extends Parent {
			static loadAsInstance = true;
			async get(target) {
				const record = await super.get(target);
				if (!record) return record;
				return {
					...record,
					computedBanner: `banner:${record.title}`,
				};
			}
		};

		CustomEchoResource = class extends Resource {
			static async get(target) {
				return { rawIds: target.get('ids') };
			}
		};

		CustomInstanceEchoResource = class extends Resource {
			static loadAsInstance = true;
			async get(target) {
				if (target.id === 'missing') return undefined;
				return { rawIds: target.get('ids') };
			}
		};

		handleRest({
			resources: Resources.resources,
			options: { getAll: () => ({ webSocket: false }) },
			routeFor: () => ({ host: undefined, urlPath: `/rest-select-projection-${randomUUID()}` }),
			server: { http: (listener) => (restHttp = listener), ws: () => [] },
		});

		mount('Grandchild', Grandchild);
		mount('Child', Child);
		mount('Parent', Parent);
		mount('ParentInstanceTrue', ParentInstanceTrue);
		mount('ParentStaticFalse', ParentStaticFalse);
		mount('ParentSubclassOverride', ParentSubclassOverride);
		mount('CustomEcho', CustomEchoResource);
		mount('CustomInstanceEcho', CustomInstanceEchoResource);

		await Grandchild.put({ id: 'g1', secret: 'top-secret-1' });
		await Grandchild.put({ id: 'g2', secret: 'top-secret-2' });
		await Child.put({ id: 'c1', parentId: 'p1', label: 'child-label-v1', grandchildId: 'g1' });
		await Child.put({ id: 'c2', parentId: 'p1', label: 'child-label-v2', grandchildId: 'g2' });
		await Parent.put({
			id: 'p1',
			title: 'parent-title-1',
			label: 'parent-own-label',
			childId: 'c1',
			childIds: ['c1', 'c2'],
			tags: ['beta', 'alpha'],
			addresses: [
				{ city: 'Denver', zip: '80202' },
				{ city: 'Austin', zip: '78701' },
			],
		});
		await Parent.put({
			id: 'p-null-fk',
			title: 'parent-null-fk',
			label: 'parent-null-label',
			childId: null,
			childIds: [],
		});
		await Parent.put({
			id: 'p-orphan-fk',
			title: 'parent-orphan-fk',
			label: 'parent-orphan-label',
			childId: 'c-late',
		});
	});

	after(async function () {
		for (const path of mounted) Resources.resources.delete(path);
		try {
			await Parent?.dropTable();
			await Child?.dropTable();
			await Grandchild?.dropTable();
		} finally {
			if (previousMainIsWorker !== undefined) {
				setMainIsWorker(previousMainIsWorker);
			}
		}
	});

	describe('@relationship(from:) ETag / conditional GET invalidation', function () {
		for (const [modeLabel, route] of [
			['loadAsInstance = undefined', 'Parent'],
			['loadAsInstance = true', 'ParentInstanceTrue'],
			['loadAsInstance = false', 'ParentStaticFalse'],
		]) {
			it(`does not return 304 Not Modified on ?select(id,child{id,label}) or .child when related child changes (${modeLabel})`, async function () {
				await Child.put({ id: 'c1', parentId: 'p1', label: 'child-label-initial', grandchildId: 'g1' });

				const bareParent = await restGet(`/${route}/p1`);
				assert.strictEqual(bareParent.status, 200);
				const parentEtag = bareParent.headers.get('etag');
				assert.ok(parentEtag, 'expected bare Parent GET without relationship projection to emit ETag');

				const selectBefore = await restGet(`/${route}/p1?select(id,child{id,label})`);
				assert.strictEqual(selectBefore.status, 200);
				assert.deepStrictEqual(selectBefore.body, {
					id: 'p1',
					child: { id: 'c1', label: 'child-label-initial' },
				});
				assert.strictEqual(
					selectBefore.headers.get('etag'),
					undefined,
					'select() resolving @relationship(from:) must not emit parent ETag'
				);
				assert.strictEqual(selectBefore.headers.get('last-modified'), undefined);

				const propBefore = await restGet(`/${route}/p1.child`);
				assert.strictEqual(propBefore.status, 200);
				assert.strictEqual(propBefore.body.label, 'child-label-initial');
				assert.strictEqual(
					propBefore.headers.get('etag'),
					undefined,
					'.property resolving @relationship(from:) must not emit parent ETag'
				);

				const arrayFromBefore = await restGet(`/${route}/p1?select(id,fromChildren{id,label})`);
				assert.strictEqual(arrayFromBefore.status, 200);
				assert.strictEqual(arrayFromBefore.headers.get('etag'), undefined);

				await Child.put({ id: 'c1', parentId: 'p1', label: 'child-label-updated', grandchildId: 'g1' });

				const selectAfter = await restGet(`/${route}/p1?select(id,child{id,label})`, {
					'if-none-match': parentEtag,
				});
				assert.strictEqual(selectAfter.status, 200);
				assert.deepStrictEqual(selectAfter.body, {
					id: 'p1',
					child: { id: 'c1', label: 'child-label-updated' },
				});

				const propAfter = await restGet(`/${route}/p1.child`, {
					'if-none-match': parentEtag,
				});
				assert.strictEqual(propAfter.status, 200);
				assert.strictEqual(propAfter.body.label, 'child-label-updated');
			});
		}

		it('does not cache missing @relationship(from:) target that is created later', async function () {
			await Child.delete('c-late');
			const bareOrphan = await restGet('/Parent/p-orphan-fk');
			const orphanEtag = bareOrphan.headers.get('etag');
			assert.ok(orphanEtag);

			const beforeCreate = await restGet('/Parent/p-orphan-fk?select(id,child{id,label})');
			assert.strictEqual(beforeCreate.status, 200);
			assert.deepStrictEqual(beforeCreate.body, { id: 'p-orphan-fk', child: null });
			assert.strictEqual(beforeCreate.headers.get('etag'), undefined);

			await Child.put({ id: 'c-late', parentId: 'p1', label: 'late-arrived' });
			try {
				const afterCreate = await restGet('/Parent/p-orphan-fk?select(id,child{id,label})', {
					'if-none-match': orphanEtag,
				});
				assert.strictEqual(afterCreate.status, 200);
				assert.deepStrictEqual(afterCreate.body, {
					id: 'p-orphan-fk',
					child: { id: 'c-late', label: 'late-arrived' },
				});
			} finally {
				await Child.delete('c-late');
			}
		});

		it('still emits ETag and returns 304 when FK is null, empty FK array, or no relationship is resolved', async function () {
			const scalarSelect = await restGet('/Parent/p1?select(id,title)');
			assert.strictEqual(scalarSelect.status, 200);
			const etag = scalarSelect.headers.get('etag');
			assert.ok(etag, 'non-relationship select should still emit ETag');

			const notModified = await restGet('/Parent/p1?select(id,title)', { 'if-none-match': etag });
			assert.strictEqual(notModified.status, 304);

			const nullFkSelect = await restGet('/Parent/p-null-fk?select(id,child{id,label})');
			assert.strictEqual(nullFkSelect.status, 200);
			assert.deepStrictEqual(nullFkSelect.body, { id: 'p-null-fk', child: null });
			const nullFkEtag = nullFkSelect.headers.get('etag');
			assert.ok(nullFkEtag, 'null FK does not read related table and remains cacheable until parent changes');

			const nullFk304 = await restGet('/Parent/p-null-fk?select(id,child{id,label})', {
				'if-none-match': nullFkEtag,
			});
			assert.strictEqual(nullFk304.status, 304);

			const emptyArrayFkSelect = await restGet('/Parent/p-null-fk?select(id,fromChildren{id,label})');
			assert.strictEqual(emptyArrayFkSelect.status, 200);
			assert.deepStrictEqual(emptyArrayFkSelect.body, { id: 'p-null-fk', fromChildren: [] });
			const emptyArrayFkEtag = emptyArrayFkSelect.headers.get('etag');
			assert.ok(
				emptyArrayFkEtag,
				'empty FK array does not read related table and remains cacheable until parent changes'
			);

			const emptyArrayFk304 = await restGet('/Parent/p-null-fk?select(id,fromChildren{id,label})', {
				'if-none-match': emptyArrayFkEtag,
			});
			assert.strictEqual(emptyArrayFk304.status, 304);
		});
	});

	describe('loadAsInstance tri-state single-projection and missing-record .property', function () {
		beforeEach(async function () {
			await Child.put({ id: 'c1', parentId: 'p1', label: 'child-label-v1', grandchildId: 'g1' });
			await Child.put({ id: 'c2', parentId: 'p1', label: 'child-label-v2', grandchildId: 'g2' });
		});

		it('applies transformForSelect once when static loadAsInstance = true (scalar and nested relationship)', async function () {
			const scalarRes = await restGet('/ParentInstanceTrue/p1?select(title)');
			assert.strictEqual(scalarRes.status, 200);
			assert.strictEqual(scalarRes.body, 'parent-title-1');

			const directScalarTarget = new RequestTarget('p1?select(title)');
			assert.strictEqual(await ParentInstanceTrue.get(directScalarTarget), 'parent-title-1');

			const fromRelRes = await restGet('/ParentInstanceTrue/p1?select(id,child{id,label})');
			assert.strictEqual(fromRelRes.status, 200);
			assert.deepStrictEqual(fromRelRes.body, {
				id: 'p1',
				child: { id: 'c1', label: 'child-label-v1' },
			});

			const directRelTarget = new RequestTarget('p1?select(id,child{id,label})');
			assert.deepStrictEqual(await ParentInstanceTrue.get(directRelTarget), {
				id: 'p1',
				child: { id: 'c1', label: 'child-label-v1' },
			});

			const toRelRes = await restGet('/ParentInstanceTrue/p1?select(id,children{id,label})');
			assert.strictEqual(toRelRes.status, 200);
			assert.strictEqual(toRelRes.body.id, 'p1');
			assert.strictEqual(toRelRes.body.children.length, 2);
		});

		it('preserves v4 instance get(target) subclass overrides that spread super.get(target)', async function () {
			const res = await restGet('/ParentSubclassOverride/p1?select(id,computedBanner)');
			assert.strictEqual(res.status, 200);
			assert.deepStrictEqual(res.body, {
				id: 'p1',
				computedBanner: 'banner:parent-title-1',
			});
		});

		it('returns 404 (not 500 TypeError) on .property for missing, tombstoned, and TTL-expired records when loadAsInstance = false', async function () {
			const missingRes = await restGet('/ParentStaticFalse/does-not-exist.title');
			assert.strictEqual(missingRes.status, 404);

			await ParentStaticFalse.put({ id: 'p-tombstoned', title: 'temp' });
			await ParentStaticFalse.delete('p-tombstoned');
			const tombstonedRes = await restGet('/ParentStaticFalse/p-tombstoned.title');
			assert.strictEqual(tombstonedRes.status, 404);

			await ParentStaticFalse.put({ id: 'p-expired', title: 'ephemeral', expiresAt: Date.now() - 1000 });
			const expiredRes = await restGet('/ParentStaticFalse/p-expired.title');
			assert.strictEqual(expiredRes.status, 404);
		});
	});

	describe('single-argument nested select(rel{...}) (#1415) and bracketed conditions in select()', function () {
		beforeEach(async function () {
			await Child.put({ id: 'c1', parentId: 'p1', label: 'child-label-v1', grandchildId: 'g1' });
			await Child.put({ id: 'c2', parentId: 'p1', label: 'child-label-v2', grandchildId: 'g2' });
		});

		it('projects single-argument nested relationship selector instead of unwrapping inner fields onto parent', async function () {
			const singleGetFrom = await restGet('/Parent/p1?select(child{id,label})');
			assert.strictEqual(singleGetFrom.status, 200);
			assert.deepStrictEqual(singleGetFrom.body, {
				child: { id: 'c1', label: 'child-label-v1' },
			});

			const singleGetBracket = await restGet('/Parent/p1?select(child[select(id,label)])');
			assert.strictEqual(singleGetBracket.status, 200);
			assert.deepStrictEqual(singleGetBracket.body, {
				child: { id: 'c1', label: 'child-label-v1' },
			});

			const collectionGetFrom = await restGet('/Parent/?id=p1&select(child{id,label})');
			assert.strictEqual(collectionGetFrom.status, 200);
			assert.deepStrictEqual(collectionGetFrom.body, [
				{
					child: { id: 'c1', label: 'child-label-v1' },
				},
			]);

			const singleGetTo = await restGet('/Parent/p1?select(children{id,label})');
			assert.strictEqual(singleGetTo.status, 200);
			assert.strictEqual(Object.keys(singleGetTo.body).length, 1);
			assert.strictEqual(singleGetTo.body.children.length, 2);
			assert.strictEqual(
				singleGetTo.headers.get('etag'),
				undefined,
				'to-side relationship projection must also suppress parent ETag'
			);

			const collectionGetTo = await restGet('/Parent/?id=p1&select(children{id,label})');
			assert.strictEqual(collectionGetTo.status, 200);
			assert.strictEqual(collectionGetTo.body.length, 1);
			assert.strictEqual(Object.keys(collectionGetTo.body[0]).length, 1);
			assert.strictEqual(collectionGetTo.body[0].children.length, 2);
		});

		it('returns all related fields on single-record GET with nested wildcard child{*} and child[select(*)]', async function () {
			const singleStarBrace = await restGet('/Parent/p1?select(child{*})');
			assert.strictEqual(singleStarBrace.status, 200);
			assert.deepStrictEqual(singleStarBrace.body, {
				child: { id: 'c1', parentId: 'p1', label: 'child-label-v1', grandchildId: 'g1' },
			});

			const multiStarBrace = await restGet('/Parent/p1?select(id,child{*})');
			assert.strictEqual(multiStarBrace.status, 200);
			assert.deepStrictEqual(multiStarBrace.body, {
				id: 'p1',
				child: { id: 'c1', parentId: 'p1', label: 'child-label-v1', grandchildId: 'g1' },
			});

			const singleStarSubSelect = await restGet('/Parent/p1?select(child[select(*)])');
			assert.strictEqual(singleStarSubSelect.status, 200);
			assert.deepStrictEqual(singleStarSubSelect.body, {
				child: { id: 'c1', parentId: 'p1', label: 'child-label-v1', grandchildId: 'g1' },
			});

			const instanceTrueStar = await restGet('/ParentInstanceTrue/p1?select(child{*})');
			assert.strictEqual(instanceTrueStar.status, 200);
			assert.deepStrictEqual(instanceTrueStar.body, {
				child: { id: 'c1', parentId: 'p1', label: 'child-label-v1', grandchildId: 'g1' },
			});

			const toManyStar = await restGet('/Parent/p1?select(children{*})');
			assert.strictEqual(toManyStar.status, 200);
			assert.deepStrictEqual(toManyStar.body, {
				children: [
					{ id: 'c1', parentId: 'p1', label: 'child-label-v1', grandchildId: 'g1' },
					{ id: 'c2', parentId: 'p1', label: 'child-label-v2', grandchildId: 'g2' },
				],
			});
		});

		it('filters bracketed relationship selections across collection and single-record entry forms', async function () {
			for (const query of [
				'select(children[label=child-label-v1])',
				'select(id,children[label=child-label-v1])',
				'select(children[label=child-label-v1],id)',
			]) {
				for (const route of ['Parent', 'ParentInstanceTrue', 'ParentStaticFalse']) {
					const single = await restGet(`/${route}/p1?${query}`);
					assert.strictEqual(single.status, 200, `${route} ${query}`);
					assert.deepStrictEqual(
						single.body.children.map((child) => child.id),
						['c1']
					);
				}
				const collection = await restGet(`/Parent/?id=p1&${query}`);
				assert.strictEqual(collection.status, 200, query);
				assert.deepStrictEqual(
					collection.body[0].children.map((child) => child.id),
					['c1']
				);
			}
		});

		it('supports single-record GET and collection search with bracketed non-condition operators like ?select(id,children[sort(-id)&limit(1)])', async function () {
			const res = await restGet('/Parent/p1?select(id,children[sort(-id)])');
			assert.strictEqual(res.status, 200);
			assert.strictEqual(res.body.id, 'p1');
			assert.ok(Array.isArray(res.body.children));
			assert.deepStrictEqual(
				res.body.children.map((c) => c.id),
				['c2', 'c1']
			);

			const singleLimitRes = await restGet('/Parent/p1?select(id,children[sort(-id)&limit(1)])');
			assert.strictEqual(singleLimitRes.status, 200);
			assert.strictEqual(singleLimitRes.body.id, 'p1');
			assert.deepStrictEqual(
				singleLimitRes.body.children.map((c) => c.id),
				['c2']
			);

			const instanceTrueRes = await restGet('/ParentInstanceTrue/p1?select(id,children[sort(-id)&limit(1)])');
			assert.strictEqual(instanceTrueRes.status, 200);
			assert.strictEqual(instanceTrueRes.body.id, 'p1');
			assert.deepStrictEqual(
				instanceTrueRes.body.children.map((c) => c.id),
				['c2']
			);

			const collectionLimitRes = await restGet('/Parent/?id=p1&select(id,children[sort(-id)&limit(1)])');
			assert.strictEqual(collectionLimitRes.status, 200);
			assert.strictEqual(collectionLimitRes.body.length, 1);
			assert.strictEqual(collectionLimitRes.body[0].id, 'p1');
			assert.deepStrictEqual(
				collectionLimitRes.body[0].children.map((c) => c.id),
				['c2']
			);

			const collectionUnsortedLimitRes = await restGet('/Parent/?id=p1&select(id,children[limit(1)])');
			assert.strictEqual(collectionUnsortedLimitRes.status, 200);
			assert.deepStrictEqual(
				collectionUnsortedLimitRes.body[0].children.map((c) => c.id),
				['c1']
			);

			const collectionUnsortedOffsetLimitRes = await restGet('/Parent/?id=p1&select(id,children[limit(1,2)])');
			assert.strictEqual(collectionUnsortedOffsetLimitRes.status, 200);
			assert.deepStrictEqual(
				collectionUnsortedOffsetLimitRes.body[0].children.map((c) => c.id),
				['c2']
			);

			const searchByValueSlicedRows = [];
			for await (const row of bridge.searchByValue({
				schema: dbName,
				table: 'Parent',
				attribute: 'id',
				value: 'p1',
				get_attributes: ['id', { name: 'children', offset: 1, limit: 1, select: ['id'] }],
			})) {
				searchByValueSlicedRows.push(row);
			}
			assert.deepStrictEqual(searchByValueSlicedRows, [{ id: 'p1', children: [{ id: 'c2' }] }]);

			const nonSuperUser = {
				role: {
					permission: {
						super_user: false,
						[dbName]: {
							tables: {
								Parent: { read: true, attribute_permissions: [] },
								Child: { read: true, attribute_permissions: [] },
							},
						},
					},
				},
			};
			const nonSuperSingleRes = await restGet('/Parent/p1?select(id,children[sort(-id)&limit(1)])', {}, nonSuperUser);
			assert.strictEqual(nonSuperSingleRes.status, 200);
			assert.deepStrictEqual(
				nonSuperSingleRes.body.children.map((c) => c.id),
				['c2']
			);

			const nonSuperCollectionRes = await restGet(
				'/Parent/?id=p1&select(id,children[sort(-id)&limit(1)])',
				{},
				nonSuperUser
			);
			assert.strictEqual(nonSuperCollectionRes.status, 200);
			assert.deepStrictEqual(
				nonSuperCollectionRes.body[0].children.map((c) => c.id),
				['c2']
			);

			const nonSuperBraceSingleRes = await restGet(
				'/Parent/p1?select(child{id,label},children{id,label})',
				{},
				nonSuperUser
			);
			assert.strictEqual(nonSuperBraceSingleRes.status, 200);
			assert.deepStrictEqual(nonSuperBraceSingleRes.body, {
				child: { id: 'c1', label: 'child-label-v1' },
				children: [
					{ id: 'c1', label: 'child-label-v1' },
					{ id: 'c2', label: 'child-label-v2' },
				],
			});

			const nonSuperBraceCollectionRes = await restGet('/Parent/?id=p1&select(child{id,label})', {}, nonSuperUser);
			assert.strictEqual(nonSuperBraceCollectionRes.status, 200);
			assert.deepStrictEqual(nonSuperBraceCollectionRes.body, [
				{
					child: { id: 'c1', label: 'child-label-v1' },
				},
			]);
		});

		it('enforces nested table and attribute read permissions on braced and bracketed sub-selects and sort paths', async function () {
			const noGrandchildUser = {
				role: {
					permission: {
						super_user: false,
						[dbName]: {
							tables: {
								Parent: { read: true, attribute_permissions: [] },
								Child: { read: true, attribute_permissions: [] },
							},
						},
					},
				},
			};

			const braceRes = await restGet('/Parent/p1?select(id,child{id,grandchild{secret}})', {}, noGrandchildUser);
			assert.strictEqual(braceRes.status, 200);
			assert.deepStrictEqual(braceRes.body, {
				id: 'p1',
				child: { id: 'c1' },
			});

			const bracketRes = await restGet(
				'/Parent/p1?select(id,child[select(id,grandchild[select(secret)])])',
				{},
				noGrandchildUser
			);
			assert.strictEqual(bracketRes.status, 200);
			assert.deepStrictEqual(bracketRes.body, {
				id: 'p1',
				child: { id: 'c1' },
			});

			const collectionBraceRes = await restGet(
				'/Parent/?id=p1&select(id,child{id,grandchild{secret}})',
				{},
				noGrandchildUser
			);
			assert.strictEqual(collectionBraceRes.status, 200);
			assert.deepStrictEqual(collectionBraceRes.body, [
				{
					id: 'p1',
					child: { id: 'c1' },
				},
			]);

			const unauthorizedSortSingle = await restGet(
				'/Parent/p1?select(id,children[sort(grandchild.secret)])',
				{},
				noGrandchildUser
			);
			assert.strictEqual(unauthorizedSortSingle.status, 200);
			assert.deepStrictEqual(unauthorizedSortSingle.body, { id: 'p1' });

			const unauthorizedSortCollection = await restGet(
				'/Parent/?id=p1&select(id,children[sort(grandchild.secret)])',
				{},
				noGrandchildUser
			);
			assert.strictEqual(unauthorizedSortCollection.status, 200);
			assert.deepStrictEqual(unauthorizedSortCollection.body, [{ id: 'p1' }]);

			const scopedChildUser = {
				role: {
					permission: {
						super_user: false,
						[dbName]: {
							tables: {
								Parent: { read: true, attribute_permissions: [] },
								Child: {
									read: true,
									attribute_permissions: [
										{ attribute_name: 'id', read: true },
										{ attribute_name: 'label', read: true },
										{ attribute_name: 'parentId', read: false },
									],
								},
							},
						},
					},
				},
			};

			const scopedSubsetSingle = await restGet('/Parent/p1?select(id,child{id,parentId})', {}, scopedChildUser);
			assert.strictEqual(scopedSubsetSingle.status, 200);
			assert.deepStrictEqual(scopedSubsetSingle.body, {
				id: 'p1',
				child: { id: 'c1' },
			});

			const scopedSubsetBracketSingle = await restGet(
				'/Parent/p1?select(id,child[select(id,parentId)])',
				{},
				scopedChildUser
			);
			assert.strictEqual(scopedSubsetBracketSingle.status, 200);
			assert.deepStrictEqual(scopedSubsetBracketSingle.body, {
				id: 'p1',
				child: { id: 'c1' },
			});

			const scopedSubsetCollection = await restGet('/Parent/?id=p1&select(id,child{id,parentId})', {}, scopedChildUser);
			assert.strictEqual(scopedSubsetCollection.status, 200);
			assert.deepStrictEqual(scopedSubsetCollection.body, [
				{
					id: 'p1',
					child: { id: 'c1' },
				},
			]);

			const scopedStarBraceSingle = await restGet('/Parent/p1?select(id,child{*})', {}, scopedChildUser);
			assert.strictEqual(scopedStarBraceSingle.status, 200);
			assert.deepStrictEqual(scopedStarBraceSingle.body, {
				id: 'p1',
				child: { id: 'c1', label: 'child-label-v1' },
			});

			const scopedStarBracketSingle = await restGet('/Parent/p1?select(id,child[select(*)])', {}, scopedChildUser);
			assert.strictEqual(scopedStarBracketSingle.status, 200);
			assert.deepStrictEqual(scopedStarBracketSingle.body, {
				id: 'p1',
				child: { id: 'c1', label: 'child-label-v1' },
			});

			const scopedStarWithNestedRelUser = {
				role: {
					permission: {
						super_user: false,
						[dbName]: {
							tables: {
								Parent: {
									read: true,
									attribute_permissions: [
										{ attribute_name: 'id', read: true },
										{ attribute_name: 'title', read: true },
										{ attribute_name: 'childId', read: false },
										{ attribute_name: 'child', read: true },
									],
								},
								Child: {
									read: true,
									attribute_permissions: [
										{ attribute_name: 'id', read: true },
										{ attribute_name: 'label', read: true },
										{ attribute_name: 'parentId', read: false },
										{ attribute_name: 'grandchild', read: true },
									],
								},
								Grandchild: {
									read: true,
									attribute_permissions: [
										{ attribute_name: 'id', read: true },
										{ attribute_name: 'secret', read: false },
									],
								},
							},
						},
					},
				},
			};
			const scopedStarWithRel = await restGet(
				'/Parent/p1?select(*,child{*,grandchild{id,secret}})',
				{},
				scopedStarWithNestedRelUser
			);
			assert.strictEqual(scopedStarWithRel.status, 200);
			assert.deepStrictEqual(scopedStarWithRel.body, {
				id: 'p1',
				title: 'parent-title-1',
				child: {
					id: 'c1',
					label: 'child-label-v1',
					grandchild: { id: 'g1' },
				},
			});

			const superStarWithRel = await restGet('/Parent/p1?select(*,child{*,grandchild{id}})');
			assert.strictEqual(superStarWithRel.status, 200);
			assert.strictEqual(superStarWithRel.body.id, 'p1');
			assert.strictEqual(superStarWithRel.body.title, 'parent-title-1');
			assert.deepStrictEqual(superStarWithRel.body.child, {
				id: 'c1',
				parentId: 'p1',
				label: 'child-label-v1',
				grandchildId: 'g1',
				grandchild: { id: 'g1' },
			});

			const scopedDeniedFieldBrace = await restGet('/Parent/p1?select(id,child{parentId})', {}, scopedChildUser);
			assert.strictEqual(scopedDeniedFieldBrace.status, 200);
			assert.deepStrictEqual(scopedDeniedFieldBrace.body, {
				id: 'p1',
				child: { id: 'c1', label: 'child-label-v1' },
			});

			const scopedDeniedFieldBracket = await restGet(
				'/Parent/p1?select(id,child[select(parentId)])',
				{},
				scopedChildUser
			);
			assert.strictEqual(scopedDeniedFieldBracket.status, 200);
			assert.deepStrictEqual(scopedDeniedFieldBracket.body, {
				id: 'p1',
				child: {},
			});

			const scopedDeniedTopLevel = await restGet('/Child/c1?select(parentId)', {}, scopedChildUser);
			assert.strictEqual(scopedDeniedTopLevel.status, 200);
			assert.deepStrictEqual(scopedDeniedTopLevel.body, {});

			const scopedDeniedSortSingle = await restGet(
				'/Parent/p1?select(id,children[sort(parentId)])',
				{},
				scopedChildUser
			);
			assert.strictEqual(scopedDeniedSortSingle.status, 200);
			assert.deepStrictEqual(scopedDeniedSortSingle.body, { id: 'p1' });
		});

		it('applies bracketed sort, offset, limit, and select consistently to plain-JSON arrays across single-record and collection GET', async function () {
			const singleTags = await restGet('/Parent/p1?select(id,tags[limit(1)])');
			assert.strictEqual(singleTags.status, 200);
			assert.deepStrictEqual(singleTags.body, { id: 'p1', tags: ['beta'] });

			const collectionTags = await restGet('/Parent/?id=p1&select(id,tags[limit(1)])');
			assert.strictEqual(collectionTags.status, 200);
			assert.deepStrictEqual(collectionTags.body, [{ id: 'p1', tags: ['beta'] }]);

			const singleAddresses = await restGet('/Parent/p1?select(id,addresses[sort(city)&limit(1)&select(city,)])');
			assert.strictEqual(singleAddresses.status, 200);
			assert.deepStrictEqual(singleAddresses.body, {
				id: 'p1',
				addresses: [{ city: 'Austin' }],
			});

			const collectionAddresses = await restGet(
				'/Parent/?id=p1&select(id,addresses[sort(city)&limit(1)&select(city,)])'
			);
			assert.strictEqual(collectionAddresses.status, 200);
			assert.deepStrictEqual(collectionAddresses.body, [
				{
					id: 'p1',
					addresses: [{ city: 'Austin' }],
				},
			]);

			const singleAddressesScalar = await restGet('/Parent/p1?select(id,addresses[sort(city)&limit(1)&select(city)])');
			assert.strictEqual(singleAddressesScalar.status, 200);
			assert.deepStrictEqual(singleAddressesScalar.body, {
				id: 'p1',
				addresses: ['Austin'],
			});

			const collectionAddressesScalar = await restGet(
				'/Parent/?id=p1&select(id,addresses[sort(city)&limit(1)&select(city)])'
			);
			assert.strictEqual(collectionAddressesScalar.status, 200);
			assert.deepStrictEqual(collectionAddressesScalar.body, [
				{
					id: 'p1',
					addresses: ['Austin'],
				},
			]);
		});

		it('returns 400 on single-record Table GET when a non-select query parameter has a FIQL parse error', async function () {
			const res = await restGet('/Parent/p1?v=1.2&nocache');
			assert.strictEqual(res.status, 400);
		});

		it('does not break custom Resource subclasses receiving bracketed query parameter values like ?ids=[1,2]', async function () {
			const staticRes = await restGet('/CustomEcho/item?ids=[1,2]');
			assert.strictEqual(staticRes.status, 200);
			assert.deepStrictEqual(staticRes.body, { rawIds: '[1,2]' });

			const instanceRes = await restGet('/CustomInstanceEcho/item?ids=[1,2]');
			assert.strictEqual(instanceRes.status, 200);
			assert.deepStrictEqual(instanceRes.body, { rawIds: '[1,2]' });

			const badSelectRes = await restGet('/CustomInstanceEcho/item?select(children[label=x])');
			assert.strictEqual(badSelectRes.status, 400);

			const badSelectMissingRes = await restGet('/CustomInstanceEcho/missing?select(children[label=x])');
			assert.strictEqual(badSelectMissingRes.status, 400);
		});
	});

	describe('operations API object get_attributes in search_by_hash and recursive validation (#3136)', function () {
		beforeEach(async function () {
			await Child.put({ id: 'c1', parentId: 'p1', label: 'child-label-v1', grandchildId: 'g1' });
			await Child.put({ id: 'c2', parentId: 'p1', label: 'child-label-v2', grandchildId: 'g2' });
		});

		it('projects { name, select } and { name } get_attributes entries in searchByHash', async function () {
			const rows = [];
			for await (const row of bridge.searchByHash({
				schema: dbName,
				table: 'Parent',
				hash_values: ['p1'],
				get_attributes: [
					'id',
					{ name: 'child', select: ['id', 'label'] },
					{ name: 'children', offset: 0, limit: 1, select: ['id', 'label'] },
				],
			})) {
				rows.push(row);
			}
			assert.strictEqual(rows.length, 1);
			assert.strictEqual(rows[0].id, 'p1');
			assert.deepStrictEqual(rows[0].child, { id: 'c1', label: 'child-label-v1' });
			assert.strictEqual(rows[0].children.length, 1);

			const wholeRelRows = [];
			for await (const row of bridge.searchByHash({
				schema: dbName,
				table: 'Parent',
				hash_values: ['p1'],
				get_attributes: ['id', { name: 'child' }],
			})) {
				wholeRelRows.push(row);
			}
			assert.strictEqual(wholeRelRows.length, 1);
			assert.strictEqual(wholeRelRows[0].id, 'p1');
			assert.strictEqual(wholeRelRows[0].child.id, 'c1');
			assert.strictEqual(wholeRelRows[0].child.label, 'child-label-v1');
		});

		it('returns all related fields in searchByHash when nested select is ["*"] or "*"', async function () {
			for (const subSelect of [['*'], '*']) {
				const rows = [];
				for await (const row of bridge.searchByHash({
					schema: dbName,
					table: 'Parent',
					hash_values: ['p1'],
					get_attributes: ['id', { name: 'child', select: subSelect }, { name: 'children', select: subSelect }],
				})) {
					rows.push(row);
				}
				assert.strictEqual(rows.length, 1);
				assert.strictEqual(rows[0].id, 'p1');
				assert.strictEqual(rows[0].child.id, 'c1');
				assert.strictEqual(rows[0].child.parentId, 'p1');
				assert.strictEqual(rows[0].child.label, 'child-label-v1');
				assert.strictEqual(rows[0].children.length, 2);
				assert.strictEqual(rows[0].children[0].id, 'c1');
				assert.strictEqual(rows[0].children[0].label, 'child-label-v1');
			}
		});

		it('rejects unknown top-level and nested attributes with 400 statusCode in searchByHash, searchByValue, and searchByConditions', async function () {
			for (const badAttr of [
				{ name: 'unknownRel', select: ['id'] },
				{ name: 'child', select: ['id', 'unknownChildAttr'] },
				{ name: 'children', select: ['id', 'unknownChildAttr'] },
			]) {
				assert.throws(
					() =>
						bridge.searchByHash({
							schema: dbName,
							table: 'Parent',
							hash_values: ['p1'],
							get_attributes: ['id', badAttr],
						}),
					(err) => err.statusCode === 400 && /unknown attribute/.test(err.message)
				);
				assert.throws(
					() =>
						bridge.searchByValue({
							schema: dbName,
							table: 'Parent',
							attribute: 'id',
							value: 'p1',
							get_attributes: ['id', badAttr],
						}),
					(err) => err.statusCode === 400 && /unknown attribute/.test(err.message)
				);
				await assert.rejects(
					async () =>
						bridge.searchByConditions({
							schema: dbName,
							table: 'Parent',
							conditions: [{ attribute: 'id', comparator: 'equals', value: 'p1' }],
							get_attributes: ['id', badAttr],
						}),
					(err) => err.statusCode === 400 && /unknown attribute/.test(err.message)
				);
			}
		});

		it('rejects undeclared dynamic object properties in object get_attributes when not in table catalog', async function () {
			await Parent.put({
				id: 'p-dyn',
				title: 'dynamic-holder',
				undeclaredDynamicObj: { nested: 'value' },
			});
			try {
				assert.throws(
					() =>
						bridge.searchByHash({
							schema: dbName,
							table: 'Parent',
							hash_values: ['p-dyn'],
							get_attributes: ['id', { name: 'undeclaredDynamicObj', select: ['nested'] }],
						}),
					(err) => err.statusCode === 400 && err.message === "unknown attribute 'undeclaredDynamicObj'"
				);
			} finally {
				await Parent.delete('p-dyn');
			}
		});

		it('fails closed in verifyPerms when an attribute-scoped role passes an object get_attributes entry', function () {
			const previousHdbSchema = global.hdb_schema;
			global.hdb_schema = getDatabases();
			try {
				const permission = {
					super_user: false,
					[dbName]: {
						describe: true,
						tables: {
							Parent: {
								read: true,
								insert: false,
								update: false,
								delete: false,
								describe: true,
								attribute_permissions: [{ attribute_name: 'id', read: true, describe: true }],
							},
						},
					},
				};
				const denial = opAuth.verifyPerms(
					{
						operation: 'search_by_hash',
						schema: dbName,
						table: 'Parent',
						hash_values: ['p1'],
						get_attributes: ['id', { name: 'child', select: ['id'] }],
						hdb_user: { username: 'scoped', role: { id: 'r1', role: 'r1', permission } },
					},
					'searchByHash'
				);
				assert.ok(denial, 'expected attribute-scoped role to fail closed on object get_attributes entry');
				assert.strictEqual(denial.invalid_schema_items.length, 1);
				assert.match(denial.invalid_schema_items[0], /does not exist on/);
			} finally {
				global.hdb_schema = previousHdbSchema;
			}
		});
	});

	describe('CSV scalar and tuple select projection (harper#1482)', function () {
		let Plain;
		let PlainAsyncMapped;
		let CustomInstanceList;

		before(async function () {
			Plain = table({
				database: dbName,
				table: 'Plain',
				attributes: [
					{ name: 'id', isPrimaryKey: true, type: 'String' },
					{ name: 'name', type: 'String', indexed: true },
					{ name: 'note', type: 'String' },
					{ name: 'count', type: 'Int' },
					{ name: 'active', type: 'Boolean' },
					{ name: 'tags', elements: { type: 'String' } },
					{ name: 'childId', type: 'String', indexed: true },
					{
						name: 'child',
						type: 'Child',
						relationship: { from: 'childId' },
						definition: { tableClass: Child },
					},
				],
			});

			PlainAsyncMapped = class extends Plain {
				static loadAsInstance = false;
				async allowRead() {
					await new Promise((resolve) => setImmediate(resolve));
					return true;
				}
				get(target) {
					return this.search(target).map((row) => row);
				}
			};
			const PlainInstance = class extends Plain {
				static loadAsInstance = true;
			};
			CustomInstanceList = class extends Resource {
				static loadAsInstance = true;
				async get(target) {
					if (target.id === '1') return { id: '1', name: 'One', extra: 'e1' };
					return [
						{ id: '1', name: 'One', extra: 'e1' },
						{ id: '2', name: 'Two', extra: 'e2' },
					];
				}
			};
			const CustomScalar = class extends Resource {
				async get(target) {
					if (target.select === 'id') return target.id;
					return { id: target.id, label: 'custom' };
				}
			};
			const NestedSummary = class extends Resource {
				static async get(target) {
					const name = await Plain.get({ id: target.id, select: 'name' });
					return { name, inStock: true };
				}
			};

			const ownRecord = (target) => ({ id: target.id, name: 'Own', extra: 1 });
			const orders = () => [
				{ id: 'o1', name: 'First', total: 5 },
				{ id: 'o2', name: 'Second', total: 7 },
			];
			mount(
				'PlainOwnGet',
				class extends Plain {
					get(target) {
						return ownRecord(target);
					}
				}
			);
			mount(
				'PlainOwnGetStatic',
				class extends Plain {
					static loadAsInstance = false;
					get(target) {
						return ownRecord(target);
					}
				}
			);
			mount(
				'PlainOrders',
				class extends Plain {
					get() {
						return orders();
					}
				}
			);
			mount(
				'PlainOrdersStatic',
				class extends Plain {
					static loadAsInstance = false;
					get() {
						return orders();
					}
				}
			);
			mount(
				'PlainOrdersInstance',
				class extends Plain {
					static loadAsInstance = true;
					get() {
						return orders();
					}
				}
			);
			mount(
				'CustomLazyOrdersInstance',
				class extends Resource {
					static loadAsInstance = true;
					get() {
						return new ExtendedIterable([
							{ id: 'o1', meta: { gift: true } },
							{ id: 'o2', meta: { gift: false } },
						]);
					}
				}
			);
			mount(
				'PlainStaticAsyncSelect',
				class extends Plain {
					static loadAsInstance = false;
					async allowRead(_user, target) {
						await new Promise((resolve) => setImmediate(resolve));
						target.select = 'tags';
						return true;
					}
				}
			);
			mount(
				'PlainStatic',
				class extends Plain {
					static loadAsInstance = false;
				}
			);
			mount(
				'PlainCopiedTarget',
				class extends Plain {
					get(target) {
						return super.get({ ...target });
					}
				}
			);
			mount(
				'PlainDelegatingCopy',
				class extends Plain {
					get(target) {
						return Plain.get({ ...target });
					}
				}
			);
			mount(
				'SharedTargetSummary',
				class extends Resource {
					static async get(target) {
						const name = await Plain.get(target);
						return { name, inStock: true };
					}
				}
			);
			mount(
				'CustomOrdersInstance',
				class extends Resource {
					static loadAsInstance = true;
					get() {
						return orders();
					}
				}
			);
			mount('Plain', Plain);
			mount('PlainAsyncMapped', PlainAsyncMapped);
			mount('PlainInstance', PlainInstance);
			mount('CustomInstanceList', CustomInstanceList);
			mount('CustomScalar', CustomScalar);
			mount('NestedSummary', NestedSummary);

			await Child.put({ id: 'c1', parentId: 'p1', label: 'child-label-v1', grandchildId: 'g1' });
			await Plain.put({
				id: 'a-1',
				name: 'Alpha',
				note: 'skip',
				count: 1,
				active: true,
				tags: ['x'],
			});
			await Plain.put({
				id: 'z-1',
				name: 'Zeta-1',
				note: 'n1',
				count: 0,
				active: false,
				tags: ['t1', 't2'],
				childId: 'c1',
			});
			await Plain.put({
				id: 'z-2',
				name: 'Zeta-2',
				note: null,
				count: 2,
				active: true,
				tags: null,
				childId: null,
			});
			await Plain.put({
				id: 'z-3',
				name: 'Zeta-3',
				count: 3,
				active: true,
				tags: ['t3'],
			});
			await Plain.put({
				id: 'z-4',
				name: 'Zeta-4',
				note: 'n4',
				count: 4,
				active: false,
				tags: [],
			});
			await Plain.put({
				id: 'z-5',
				name: 'Zeta-5',
				note: 'n5',
				count: 5,
				active: true,
				tags: ['t5'],
			});
		});

		after(async function () {
			await Plain?.dropTable();
		});

		it('returns an "id" header and one id per row for CSV select(id), while JSON select(id) still returns scalars', async function () {
			const csvRes = await restGet('/Plain/?name=starts_with=Z&sort(id)&select(id)', {
				accept: 'text/csv',
			});
			assert.strictEqual(csvRes.status, 200);
			assert.strictEqual(csvRes.text, '"id"\n"z-1"\n"z-2"\n"z-3"\n"z-4"\n"z-5"\n');

			const jsonRes = await restGet('/Plain/?name=starts_with=Z&sort(id)&select(id)', {
				accept: 'application/json',
			});
			assert.strictEqual(jsonRes.status, 200);
			assert.deepStrictEqual(jsonRes.body, ['z-1', 'z-2', 'z-3', 'z-4', 'z-5']);
		});

		it('returns the expected slice for CSV select(id) with a nonempty limit(2,3) window', async function () {
			const csvRes = await restGet('/Plain/?name=starts_with=Z&sort(id)&select(id)&limit(2,3)', {
				accept: 'text/csv',
			});
			assert.strictEqual(csvRes.status, 200);
			assert.strictEqual(csvRes.text, '"id"\n"z-3"\n');

			const jsonRes = await restGet('/Plain/?name=starts_with=Z&sort(id)&select(id)&limit(2,3)', {
				accept: 'application/json',
			});
			assert.strictEqual(jsonRes.status, 200);
			assert.deepStrictEqual(jsonRes.body, ['z-3']);

			const multiRowWindowCsv = await restGet('/Plain/?name=starts_with=Z&sort(id)&select(id)&limit(1,4)', {
				accept: 'text/csv',
			});
			assert.strictEqual(multiRowWindowCsv.status, 200);
			assert.strictEqual(multiRowWindowCsv.text, '"id"\n"z-2"\n"z-3"\n"z-4"\n');
		});

		it('preserves CSV select(id,) and select(id,note) behavior', async function () {
			const singleTrailingComma = await restGet('/Plain/?name=starts_with=Z&sort(id)&select(id,)&limit(3)', {
				accept: 'text/csv',
			});
			assert.strictEqual(singleTrailingComma.status, 200);
			assert.strictEqual(singleTrailingComma.text, '"id"\n"z-1"\n"z-2"\n"z-3"\n');

			const singleColNulls = await restGet('/Plain/?name=starts_with=Z&sort(id)&select(note,)', {
				accept: 'text/csv',
			});
			assert.strictEqual(singleColNulls.status, 200);
			assert.strictEqual(singleColNulls.text, '"note"\n"n1"\n""\n""\n"n4"\n"n5"\n');

			const multiProp = await restGet('/Plain/?name=starts_with=Z&sort(id)&select(id,note)&limit(3)', {
				accept: 'text/csv',
			});
			assert.strictEqual(multiProp.status, 200);
			assert.strictEqual(multiProp.text, '"id","note"\n"z-1","n1"\n"z-2",\n"z-3",\n');

			const nestedKeyedRel = await restGet('/Plain/?id=z-1&select(child{id,label})', {
				accept: 'text/csv',
			});
			assert.strictEqual(nestedKeyedRel.status, 200);
			assert.strictEqual(nestedKeyedRel.text, '"child"\n"{""id"":""c1"",""label"":""child-label-v1""}"\n');
		});

		it('handles null, missing, 0, and false scalar cells in CSV without truncating the stream', async function () {
			const nullableRes = await restGet('/Plain/?name=starts_with=Z&sort(id)&select(note)', {
				accept: 'text/csv',
			});
			assert.strictEqual(nullableRes.status, 200);
			assert.strictEqual(nullableRes.text, '"note"\n"n1"\n""\n""\n"n4"\n"n5"\n');

			const zeroRes = await restGet('/Plain/?name=starts_with=Z&sort(id)&select(count)&limit(3)', {
				accept: 'text/csv',
			});
			assert.strictEqual(zeroRes.status, 200);
			assert.strictEqual(zeroRes.text, '"count"\n0\n2\n3\n');

			const boolRes = await restGet('/Plain/?name=starts_with=Z&sort(id)&select(active)&limit(2)', {
				accept: 'text/csv',
			});
			assert.strictEqual(boolRes.status, 200);
			assert.strictEqual(boolRes.text, '"active"\n"false"\n"true"\n');
		});

		it('formats object-valued scalar selects, wildcard select(*), and tuple select([id,note]) / select([id,*]) in CSV', async function () {
			const tagsRes = await restGet('/Plain/?id=z-1&select(tags)', {
				accept: 'text/csv',
			});
			assert.strictEqual(tagsRes.status, 200);
			assert.strictEqual(tagsRes.text, '"tags"\n"[""t1"",""t2""]"\n');

			const relScalarRes = await restGet('/Plain/?id=z-1&select(child)', {
				accept: 'text/csv',
			});
			assert.strictEqual(relScalarRes.status, 200);
			assert.strictEqual(
				relScalarRes.text,
				'"child"\n"{""id"":""c1"",""parentId"":""p1"",""label"":""child-label-v1"",""grandchildId"":""g1""}"\n'
			);

			const { toCsvStream } = require('#src/server/serverHelpers/contentTypes');
			const objSelectTarget = new RequestTarget('?id=z-1');
			objSelectTarget.select = { name: 'child', select: ['id', 'label'] };
			const objSelectResults = await Plain.get(objSelectTarget);
			let objSelectCsv = '';
			for await (const chunk of toCsvStream(objSelectResults)) objSelectCsv += chunk;
			assert.strictEqual(objSelectCsv, '"child"\n"{""id"":""c1"",""label"":""child-label-v1""}"\n');

			const tupleRes = await restGet('/Plain/?id=z-1&select([id,note])', {
				accept: 'text/csv',
			});
			assert.strictEqual(tupleRes.status, 200);
			assert.strictEqual(tupleRes.text, '"id","note"\n"z-1","n1"\n');

			const tupleWildcardRes = await restGet('/Plain/?id=z-1&select([id,*])', {
				accept: 'text/csv',
			});
			assert.strictEqual(tupleWildcardRes.status, 200);
			const tupleWildcardLines = tupleWildcardRes.text.trim().split('\n');
			assert.strictEqual(tupleWildcardLines[0], '"id","*"');
			assert.match(tupleWildcardLines[1], /^"z-1","\{""id"":""z-1""/);

			const wildcardRes = await restGet('/Plain/?id=z-1&select(*)', {
				accept: 'text/csv',
			});
			assert.strictEqual(wildcardRes.status, 200);
			const wildcardLines = wildcardRes.text.trim().split('\n');
			assert.strictEqual(wildcardLines[0], '"id","name","note","count","active","tags","childId","child"');
			assert.match(wildcardLines[1], /^"z-1","Zeta-1","n1"/);
		});

		it('uses post-authorization row shape when attribute_permissions rewrites scalar or tuple select', async function () {
			const scopedUser = {
				username: 'scoped-csv',
				role: {
					id: 'scoped-csv-role',
					role: 'scoped-csv-role',
					permission: {
						super_user: false,
						[dbName]: {
							describe: true,
							tables: {
								Plain: {
									read: true,
									insert: false,
									update: false,
									delete: false,
									describe: true,
									attribute_permissions: [
										{ attribute_name: 'id', read: true, describe: true },
										{ attribute_name: 'name', read: true, describe: true },
										{ attribute_name: 'note', read: true, describe: true },
									],
								},
							},
						},
					},
				},
			};

			const scalarCsv = await restGet('/Plain/?id=z-1&select(id)', { accept: 'text/csv' }, scopedUser);
			assert.strictEqual(scalarCsv.status, 200);
			assert.strictEqual(scalarCsv.text, '"id"\n"z-1"\n');

			const tupleCsv = await restGet('/Plain/?id=z-1&select([id,note])', { accept: 'text/csv' }, scopedUser);
			assert.strictEqual(tupleCsv.status, 200);
			assert.strictEqual(tupleCsv.text, '"id","note"\n"z-1","n1"\n');
		});

		it('handles async allowRead with .map() on search for CSV select(id)', async function () {
			const csvRes = await restGet('/PlainAsyncMapped/?id=z-1&select(id)', {
				accept: 'text/csv',
			});
			assert.strictEqual(csvRes.status, 200);
			assert.strictEqual(csvRes.text, '"id"\n"z-1"\n');

			const origPrepare = Plain._prepareQueryConditions;
			Plain._prepareQueryConditions = function (conditions, operator, target, context) {
				const prepared = origPrepare.call(this, conditions, operator, target, context);
				return { ...prepared, includeFullTextHighlights: true };
			};
			try {
				const widenedRes = await restGet('/PlainAsyncMapped/?id=z-1&select(id)', {
					accept: 'text/csv',
				});
				assert.strictEqual(widenedRes.status, 200);
				assert.strictEqual(widenedRes.text, '"id","$highlights"\n"z-1",\n');
			} finally {
				Plain._prepareQueryConditions = origPrepare;
			}

			const { toCsvStream } = require('#src/server/serverHelpers/contentTypes');
			class PlainAsyncRewriting extends Plain {
				static loadAsInstance = false;
				async allowRead(_user, target) {
					await new Promise((resolve) => setImmediate(resolve));
					target.select = ['id', 'note'];
					return true;
				}
			}
			const directTarget = new RequestTarget('?id=z-1&select(id)');
			directTarget.checkPermission = true;
			const unawaitedGated = new PlainAsyncRewriting(undefined, {}).search(directTarget);
			let directCsv = '';
			for await (const chunk of toCsvStream(unawaitedGated)) directCsv += chunk;
			assert.strictEqual(directCsv, '"id","note"\n"z-1","n1"\n');

			const directTarget2 = new RequestTarget('?id=z-1&select(id)');
			directTarget2.checkPermission = true;
			const unawaitedGated2 = new PlainAsyncRewriting(undefined, {}).search(directTarget2);
			let eagerColumnsCsv = '';
			for await (const chunk of toCsvStream(unawaitedGated2, unawaitedGated2.getColumns())) eagerColumnsCsv += chunk;
			assert.strictEqual(eagerColumnsCsv, '"id","note"\n"z-1","n1"\n');
		});

		it('uses post-highlight keyed shape when full-text highlights widen a scalar select(id)', async function () {
			const origPrepare = Plain._prepareQueryConditions;
			Plain._prepareQueryConditions = function (conditions, operator, target, context) {
				const prepared = origPrepare.call(this, conditions, operator, target, context);
				return { ...prepared, includeFullTextHighlights: true };
			};
			try {
				const csvRes = await restGet('/Plain/?id=z-1&select(id)', {
					accept: 'text/csv',
				});
				assert.strictEqual(csvRes.status, 200);
				assert.strictEqual(csvRes.text, '"id","$highlights"\n"z-1",\n');
			} finally {
				Plain._prepareQueryConditions = origPrepare;
			}
		});

		it('formats single-record URL CSV with scalar, tuple, and keyed select() projections (#3966)', async function () {
			const scalarIdCsv = await restGet('/Plain/z-1?select(id)', { accept: 'text/csv' });
			assert.strictEqual(scalarIdCsv.status, 200);
			assert.strictEqual(scalarIdCsv.text, '"id"\n"z-1"\n');

			const scalarIdJson = await restGet('/Plain/z-1?select(id)', { accept: 'application/json' });
			assert.strictEqual(scalarIdJson.status, 200);
			assert.strictEqual(scalarIdJson.body, 'z-1');

			const zeroCountCsv = await restGet('/Plain/z-1?select(count)', { accept: 'text/csv' });
			assert.strictEqual(zeroCountCsv.status, 200);
			assert.strictEqual(zeroCountCsv.text, '"count"\n0\n');

			const falseActiveCsv = await restGet('/Plain/z-1?select(active)', { accept: 'text/csv' });
			assert.strictEqual(falseActiveCsv.status, 200);
			assert.strictEqual(falseActiveCsv.text, '"active"\n"false"\n');

			const nullTupleNoteCsv = await restGet('/Plain/z-2?select(note,)', { accept: 'text/csv' });
			assert.strictEqual(nullTupleNoteCsv.status, 200);
			assert.strictEqual(nullTupleNoteCsv.text, '"note"\n""\n');

			const tagsArrayScalarCsv = await restGet('/Plain/z-1?select(tags)', { accept: 'text/csv' });
			assert.strictEqual(tagsArrayScalarCsv.status, 200);
			assert.strictEqual(tagsArrayScalarCsv.text, '"tags"\n"[""t1"",""t2""]"\n');

			const nestedObjectScalarCsv = await restGet('/Plain/z-1?select(child{id,label})', { accept: 'text/csv' });
			assert.strictEqual(nestedObjectScalarCsv.status, 200);
			assert.strictEqual(nestedObjectScalarCsv.text, '"child"\n"{""id"":""c1"",""label"":""child-label-v1""}"\n');

			const trailingCommaCsv = await restGet('/Plain/z-1?select(id,)', { accept: 'text/csv' });
			assert.strictEqual(trailingCommaCsv.status, 200);
			assert.strictEqual(trailingCommaCsv.text, '"id"\n"z-1"\n');

			const tupleCsv = await restGet('/Plain/z-1?select([id,note])', { accept: 'text/csv' });
			assert.strictEqual(tupleCsv.status, 200);
			assert.strictEqual(tupleCsv.text, '"id","note"\n"z-1","n1"\n');

			const keyedCsv = await restGet('/Plain/z-1?select(id,note)', { accept: 'text/csv' });
			assert.strictEqual(keyedCsv.status, 200);
			assert.strictEqual(keyedCsv.text, '"id","note"\n"z-1","n1"\n');

			const instanceScalarCsv = await restGet('/PlainInstance/z-1?select(id)', { accept: 'text/csv' });
			assert.strictEqual(instanceScalarCsv.status, 200);
			assert.strictEqual(instanceScalarCsv.text, '"id"\n"z-1"\n');

			const instanceTupleCsv = await restGet('/PlainInstance/z-1?select([id,note])', { accept: 'text/csv' });
			assert.strictEqual(instanceTupleCsv.status, 200);
			assert.strictEqual(instanceTupleCsv.text, '"id","note"\n"z-1","n1"\n');

			const customInstanceCollectionStar = await restGet('/CustomInstanceList/?select(*)', { accept: 'text/csv' });
			assert.strictEqual(customInstanceCollectionStar.status, 200);
			assert.strictEqual(customInstanceCollectionStar.text, '"id","name","extra"\n"1","One","e1"\n"2","Two","e2"\n');

			const customInstanceRecordStar = await restGet('/CustomInstanceList/1?select(*)', { accept: 'text/csv' });
			assert.strictEqual(customInstanceRecordStar.status, 200);
			assert.strictEqual(customInstanceRecordStar.text, '"id","name","extra"\n"1","One","e1"\n');

			const customInstanceRecordScalar = await restGet('/CustomInstanceList/1?select(id)', { accept: 'text/csv' });
			assert.strictEqual(customInstanceRecordScalar.status, 200);
			assert.strictEqual(customInstanceRecordScalar.text, '"id"\n"1"\n');

			const customInstanceCollectionScalar = await restGet('/CustomInstanceList/?select(id)', { accept: 'text/csv' });
			assert.strictEqual(customInstanceCollectionScalar.status, 200);
			assert.strictEqual(customInstanceCollectionScalar.text, '"id"\n"1"\n"2"\n');

			const customScalarCsv = await restGet('/CustomScalar/z-1?select(id)', { accept: 'text/csv' });
			assert.strictEqual(customScalarCsv.status, 200);
			assert.strictEqual(customScalarCsv.text, '"id"\n"z-1"\n');

			const customIgnoredSelectCsv = await restGet('/CustomScalar/z-1?select(label)', { accept: 'text/csv' });
			assert.strictEqual(customIgnoredSelectCsv.status, 200);
			assert.strictEqual(customIgnoredSelectCsv.text, '"id","label"\n"z-1","custom"\n');

			const nestedSummaryCsv = await restGet('/NestedSummary/z-1', { accept: 'text/csv' });
			assert.strictEqual(nestedSummaryCsv.status, 200);
			assert.strictEqual(nestedSummaryCsv.text, '"name","inStock"\n"Zeta-1","true"\n');

			const nestedSummaryWithSelectCsv = await restGet('/NestedSummary/z-1?select(name)', { accept: 'text/csv' });
			assert.strictEqual(nestedSummaryWithSelectCsv.status, 200);
			assert.strictEqual(nestedSummaryWithSelectCsv.text, '"name","inStock"\n"Zeta-1","true"\n');

			const missingCsv = await restGet('/Plain/does-not-exist?select(id)', { accept: 'text/csv' });
			assert.strictEqual(missingCsv.status, 404);
		});

		it('returns every field in CSV when a Table subclass get override returns its own object (#4018)', async function () {
			for (const path of ['/PlainOwnGet/a', '/PlainOwnGetStatic/a']) {
				for (const select of ['select(name)', 'select([id,name])', 'select(id,name)']) {
					const url = `${path}?${select}`;
					const json = await restGet(url, { accept: 'application/json' });
					assert.deepStrictEqual(json.body, { id: 'a', name: 'Own', extra: 1 }, url);
					const csv = await restGet(url, { accept: 'text/csv' });
					assert.strictEqual(csv.status, 200, url);
					assert.strictEqual(csv.text, '"id","name","extra"\n"a","Own",1\n', url);
				}
			}
		});

		it('formats CSV from the projection that produced the response value, not from another read of the same target (#4018)', async function () {
			const staticTuple = await restGet('/PlainStatic/z-1?select([id,note])', { accept: 'text/csv' });
			assert.strictEqual(staticTuple.text, '"id","note"\n"z-1","n1"\n');
			const staticArrayScalar = await restGet('/PlainStatic/z-1?select(tags)', { accept: 'text/csv' });
			assert.strictEqual(staticArrayScalar.text, '"tags"\n"[""t1"",""t2""]"\n');

			const asyncSelectArrayScalar = await restGet('/PlainStaticAsyncSelect/z-1', { accept: 'text/csv' });
			assert.strictEqual(asyncSelectArrayScalar.text, '"tags"\n"[""t1"",""t2""]"\n');

			const copiedArrayScalar = await restGet('/PlainCopiedTarget/z-1?select(tags)', { accept: 'text/csv' });
			assert.strictEqual(copiedArrayScalar.text, '"tags"\n"[""t1"",""t2""]"\n');
			const copiedTuple = await restGet('/PlainCopiedTarget/z-1?select([id,note])', { accept: 'text/csv' });
			assert.strictEqual(copiedTuple.text, '"id","note"\n"z-1","n1"\n');

			const delegatedArrayScalar = await restGet('/PlainDelegatingCopy/z-1?select(tags)', { accept: 'text/csv' });
			assert.strictEqual(delegatedArrayScalar.text, '"tags"\n"[""t1"",""t2""]"\n');
			const delegatedTuple = await restGet('/PlainDelegatingCopy/z-1?select([id,note])', { accept: 'text/csv' });
			assert.strictEqual(delegatedTuple.text, '"id","note"\n"z-1","n1"\n');

			const summaryJson = await restGet('/SharedTargetSummary/z-1?select(name)', { accept: 'application/json' });
			assert.deepStrictEqual(summaryJson.body, { name: 'Zeta-1', inStock: true });
			const summaryCsv = await restGet('/SharedTargetSummary/z-1?select(name)', { accept: 'text/csv' });
			assert.strictEqual(summaryCsv.text, '"name","inStock"\n"Zeta-1","true"\n');
		});

		it('returns the selected value for a frozen programmatic target on a loadAsInstance resource', async function () {
			assert.strictEqual(await CustomInstanceList.get(Object.freeze({ id: '1', select: 'id' })), '1');
		});

		it('returns one CSV row per element when a record URL get returns an array (#4018)', async function () {
			for (const path of ['/PlainOrders/customer-1', '/PlainOrdersStatic/customer-1']) {
				const url = `${path}?select(id,name)`;
				const json = await restGet(url, { accept: 'application/json' });
				assert.strictEqual(json.body.length, 2, url);
				assert.strictEqual(json.body[0].total, 5, url);
				const csv = await restGet(url, { accept: 'text/csv' });
				assert.strictEqual(csv.status, 200, url);
				assert.strictEqual(csv.text, '"id","name","total"\n"o1","First",5\n"o2","Second",7\n', url);
			}
			const lazyCsv = await restGet('/CustomLazyOrdersInstance/customer-1?select(meta)', { accept: 'text/csv' });
			assert.strictEqual(lazyCsv.text, '"meta"\n"{""gift"":true}"\n"{""gift"":false}"\n');
			for (const path of ['/PlainOrdersInstance/customer-1', '/CustomOrdersInstance/customer-1']) {
				const keyedUrl = `${path}?select(id,name)`;
				const json = await restGet(keyedUrl, { accept: 'application/json' });
				assert.deepStrictEqual(
					json.body,
					[
						{ id: 'o1', name: 'First' },
						{ id: 'o2', name: 'Second' },
					],
					keyedUrl
				);
				const keyedCsv = await restGet(keyedUrl, { accept: 'text/csv' });
				assert.strictEqual(keyedCsv.status, 200, keyedUrl);
				assert.strictEqual(keyedCsv.text, '"id","name"\n"o1","First"\n"o2","Second"\n', keyedUrl);

				const scalarCsv = await restGet(`${path}?select(id)`, { accept: 'text/csv' });
				assert.strictEqual(scalarCsv.text, '"id"\n"o1"\n"o2"\n', path);
				const tupleCsv = await restGet(`${path}?select([id,total])`, { accept: 'text/csv' });
				assert.strictEqual(tupleCsv.text, '"id","total"\n"o1",5\n"o2",7\n', path);
			}
		});
	});
});
