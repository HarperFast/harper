const assert = require('node:assert');
const { createServer } = require('node:http');
const { setupTestDBPath } = require('../testUtils.js');
const { table } = require('#src/resources/databases');
const { Resources } = require('#src/resources/Resources');
const { handleApplication } = require('#src/server/REST');
const { Request } = require('#src/server/serverHelpers/Request');
const { getWorkerIndex, setMainIsWorker } = require('#src/server/threads/manageThreads');
require('#src/server/serverHelpers/serverUtilities');

const children = [
	{ id: 'c1', parentId: 'p1', state: 'open', score: 10 },
	{ id: 'c2', parentId: 'p1', state: 'closed', score: 20 },
	{ id: 'c3', parentId: 'p1', state: 'open', score: 30 },
	{ id: 'c4', parentId: 'p1', state: 'open', score: 40 },
	{ id: 'c5', parentId: 'p2', state: 'closed', score: 5 },
	{ id: 'c6', parentId: 'p2', state: 'open', score: 50 },
	{ id: 'c7', parentId: 'p2', state: 'closed', score: 60 },
];

const parents = [
	{
		id: 'p1',
		group: 'g1',
		childId: 'c1',
		childIds: ['c1', 'missing', 'c2', 'c3', 'c4'],
	},
	{ id: 'p2', group: 'g1', childId: 'missing', childIds: ['c5', 'c6'] },
	{ id: 'p3', group: 'g1', childId: 'c5', childIds: [] },
];

describe('relationship primary-key filters and dangling foreign keys', function () {
	this.timeout(15000);
	let Parent, Child, server, base, previousMainIsWorker, resources;

	before(async function () {
		setupTestDBPath();
		previousMainIsWorker = getWorkerIndex() === 0;
		setMainIsWorker(true);

		Child = table({
			database: 'relationship_pk_filters',
			table: 'Child',
			attributes: [
				{ name: 'id', type: 'ID', isPrimaryKey: true },
				{ name: 'parentId', type: 'String', indexed: true },
				{ name: 'state', type: 'String', indexed: true },
				{ name: 'score', type: 'Int', indexed: true },
				{
					name: 'siblings',
					relationship: { to: 'parentId', from: 'parentId' },
					elements: { type: 'Child', definition: {} },
				},
			],
		});
		Child.attributes.find((attribute) => attribute.name === 'siblings').elements.definition.tableClass = Child;
		Child.updatedAttributes();

		Parent = table({
			database: 'relationship_pk_filters',
			table: 'Parent',
			attributes: [
				{ name: 'id', type: 'ID', isPrimaryKey: true },
				{ name: 'group', type: 'String', indexed: true },
				{ name: 'childId', type: 'ID' },
				{ name: 'childIds', elements: { type: 'ID' } },
				{
					name: 'children',
					relationship: { to: 'parentId' },
					elements: { type: 'Child', definition: { tableClass: Child } },
				},
				{
					name: 'child',
					relationship: { from: 'childId' },
					type: 'Child',
					definition: { tableClass: Child },
				},
				{
					name: 'references',
					relationship: { from: 'childIds' },
					elements: { type: 'Child', definition: { tableClass: Child } },
				},
				{
					name: 'peers',
					relationship: { to: 'group', from: 'group' },
					elements: { type: 'Parent', definition: {} },
				},
			],
		});
		Parent.attributes.find((attribute) => attribute.name === 'peers').elements.definition.tableClass = Parent;
		Parent.updatedAttributes();

		for (const parent of parents) await Parent.put(parent.id, parent);
		for (const child of children) await Child.put(child.id, child);

		resources = new Resources();
		resources.set('rel-pk/Parent', Parent);
		resources.set('rel-pk/Child', Child);
		let rest;
		handleApplication({
			resources,
			options: { getAll: () => ({ webSocket: false }) },
			routeFor: () => ({ urlPath: '/rel-pk' }),
			server: {
				http: (handler) => {
					rest = handler;
				},
				ws: () => [],
			},
		});
		server = createServer(async (input, output) => {
			try {
				const request = new Request(input, output);
				request.user = { role: { permission: { super_user: true } } };
				const response = await rest(request, () => ({
					status: 404,
					headers: new Map(),
					body: 'not found',
				}));
				output.writeHead(response.status, Object.fromEntries(response.headers));
				if (typeof response.body === 'string' || Buffer.isBuffer(response.body)) output.end(response.body);
				else {
					for await (const chunk of response.body || []) output.write(chunk);
					output.end();
				}
			} catch (error) {
				output.writeHead(error.statusCode || 500);
				output.end(error.message);
			}
		});
		await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
		base = `http://127.0.0.1:${server.address().port}`;
	});

	after(async function () {
		if (server) await new Promise((resolve) => server.close(resolve));
		if (previousMainIsWorker !== undefined) setMainIsWorker(previousMainIsWorker);
	});

	async function get(path) {
		const response = await fetch(base + path);
		const text = await response.text();
		assert.strictEqual(response.status, 200, `Expected HTTP 200 for ${path}, got ${response.status}: ${text}`);
		return JSON.parse(text);
	}

	async function searchParents(queryObject) {
		const rows = [];
		for await (const row of Parent.search(queryObject)) {
			rows.push(JSON.parse(JSON.stringify(row)));
		}
		return rows;
	}

	it('controls: a leading related primary-key condition, a non-leading to-one FK condition, and a nested non-key condition', async function () {
		const drivingSingleRest = await get('/rel-pk/Parent/?children.id=c1&select(id,)');
		assert.deepStrictEqual(drivingSingleRest, [{ id: 'p1' }]);

		const drivingGroupRest = await get('/rel-pk/Parent/?children.id=c1&group=g1&select(id,)');
		assert.deepStrictEqual(drivingGroupRest, [{ id: 'p1' }]);

		const drivingEnforcedSearch = await searchParents({
			conditions: [
				{ attribute: ['children', 'id'], value: 'c1' },
				{ attribute: 'id', value: 'p1' },
			],
			enforceExecutionOrder: true,
			select: ['id'],
		});
		assert.deepStrictEqual(drivingEnforcedSearch, [{ id: 'p1' }]);

		const fromFkSingularMatch = await get('/rel-pk/Parent/?id=p1&child.id=c1&select(id,)');
		assert.deepStrictEqual(fromFkSingularMatch, [{ id: 'p1' }]);

		const fromFkSingularMiss = await get('/rel-pk/Parent/?id=p1&child.id=c2&select(id,)');
		assert.deepStrictEqual(fromFkSingularMiss, []);

		const nestedNonPk = await get('/rel-pk/Parent/p2?select(id,children[siblings.state=open&select(id,)])');
		assert.deepStrictEqual(nestedNonPk, {
			id: 'p2',
			children: [{ id: 'c5' }, { id: 'c6' }, { id: 'c7' }],
		});
	});

	it('a non-leading related primary-key condition on a `to` relationship keeps matching parents in any condition order', async function () {
		const drivingControl = await searchParents({
			conditions: [
				{ attribute: ['children', 'id'], value: 'c1' },
				{ attribute: 'id', value: 'p1' },
			],
			enforceExecutionOrder: true,
			select: ['id'],
		});
		assert.deepStrictEqual(drivingControl, [{ id: 'p1' }]);

		const filterOrderRest = await get('/rel-pk/Parent/?id=p1&children.id=c1&select(id,)');
		const reorderedRest = await get('/rel-pk/Parent/?children.id=c1&id=p1&select(id,)');
		const filterOrderSearch = await searchParents({
			conditions: [
				{ attribute: 'id', value: 'p1' },
				{ attribute: ['children', 'id'], value: 'c1' },
			],
			select: ['id'],
		});
		const groupFilterSearch = await searchParents({
			conditions: [
				{ attribute: 'group', value: 'g1' },
				{ attribute: ['children', 'id'], value: 'c6' },
			],
			enforceExecutionOrder: true,
			select: ['id'],
		});

		assert.deepStrictEqual(
			{
				filterOrderRest,
				reorderedRest,
				filterOrderSearch,
				groupFilterSearch,
			},
			{
				filterOrderRest: [{ id: 'p1' }],
				reorderedRest: [{ id: 'p1' }],
				filterOrderSearch: [{ id: 'p1' }],
				groupFilterSearch: [{ id: 'p2' }],
			}
		);
	});

	it('a non-leading related primary-key condition on a `to` relationship does not match a parent by its own id', async function () {
		assert.strictEqual(Child.primaryStore.getEntry('p1'), undefined);
		assert.strictEqual(Child.primaryStore.getEntry('p3'), undefined);

		const drivingControl = await searchParents({
			conditions: [
				{ attribute: ['children', 'id'], value: 'p1' },
				{ attribute: 'id', value: 'p1' },
			],
			enforceExecutionOrder: true,
			select: ['id'],
		});
		assert.deepStrictEqual(drivingControl, []);

		const filterOrderRestP1 = await get('/rel-pk/Parent/?id=p1&children.id=p1&select(id,)');
		const filterOrderSearchP1 = await searchParents({
			conditions: [
				{ attribute: 'id', value: 'p1' },
				{ attribute: ['children', 'id'], value: 'p1' },
			],
			select: ['id'],
		});
		const filterOrderRestP3 = await get('/rel-pk/Parent/?id=p3&children.id=p3&select(id,)');

		assert.deepStrictEqual(
			{
				filterOrderRestP1,
				filterOrderSearchP1,
				filterOrderRestP3,
			},
			{
				filterOrderRestP1: [],
				filterOrderSearchP1: [],
				filterOrderRestP3: [],
			}
		);
	});

	it('a nested selection condition on a related primary key filters by that key, not by the join attribute', async function () {
		const nestedRestMatch = await get('/rel-pk/Parent/p2?select(id,children[siblings.id=c6&select(id,)])');
		const nestedSearchMatch = await searchParents({
			conditions: [{ attribute: 'id', value: 'p2' }],
			select: [
				'id',
				{
					name: 'children',
					conditions: [{ attribute: ['siblings', 'id'], value: 'c6' }],
					select: ['id'],
				},
			],
		});
		const nestedRestFalseMatch = await get('/rel-pk/Parent/p1?select(id,children[siblings.id=p1&select(id,)])');

		assert.deepStrictEqual(
			{
				nestedRestMatch,
				nestedSearchMatch,
				nestedRestFalseMatch,
			},
			{
				nestedRestMatch: {
					id: 'p2',
					children: [{ id: 'c5' }, { id: 'c6' }, { id: 'c7' }],
				},
				nestedSearchMatch: [{ id: 'p2', children: [{ id: 'c5' }, { id: 'c6' }, { id: 'c7' }] }],
				nestedRestFalseMatch: { id: 'p1', children: [] },
			}
		);
	});

	it('an array foreign key with a dangling id filters by element, in conditions and nested selections', async function () {
		const nestedPeersResp = await fetch(
			`${base}/rel-pk/Parent/p2?select(id,peers[references.state=closed&select(id,)])`
		);
		const nestedPeersBody = JSON.parse(await nestedPeersResp.text());

		let syncSearchOutcome;
		try {
			syncSearchOutcome = Array.from(
				Parent.search({
					conditions: [
						{ attribute: 'id', value: 'p1' },
						{ attribute: ['references', 'state'], value: 'closed' },
					],
					select: ['id'],
				})
			).map((row) => ({ id: row.id }));
		} catch (err) {
			syncSearchOutcome = `${err.name}: ${err.message}`;
		}

		const fromFkArrayMatchRest = await get('/rel-pk/Parent/?id=p1&references.id=c2&select(id,)');
		const fromFkArrayMissRest = await get('/rel-pk/Parent/?id=p1&references.id=c6&select(id,)');
		const nestedFromFkArrayPkRest = await get('/rel-pk/Parent/p2?select(id,peers[references.id=c2&select(id,)])');

		assert.deepStrictEqual(
			{
				nestedPeersStatus: nestedPeersResp.status,
				nestedPeersBody,
				syncSearchOutcome,
				fromFkArrayMatchRest,
				fromFkArrayMissRest,
				nestedFromFkArrayPkRest,
			},
			{
				nestedPeersStatus: 200,
				nestedPeersBody: {
					id: 'p2',
					peers: [{ id: 'p1' }, { id: 'p2' }],
				},
				syncSearchOutcome: [{ id: 'p1' }],
				fromFkArrayMatchRest: [{ id: 'p1' }],
				fromFkArrayMissRest: [],
				nestedFromFkArrayPkRest: { id: 'p2', peers: [{ id: 'p1' }] },
			}
		);
	});
});
