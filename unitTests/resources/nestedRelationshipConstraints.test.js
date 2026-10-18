const assert = require('node:assert');
const { createServer } = require('node:http');
const { setupTestDBPath } = require('../testUtils.js');
const { table } = require('#src/resources/databases');
const { RocksDatabase } = require('@harperfast/rocksdb-js');
const { Resources } = require('#src/resources/Resources');
const { transaction } = require('#src/resources/transaction');
const { RequestTarget } = require('#src/resources/RequestTarget');
const { handleApplication } = require('#src/server/REST');
const { Request } = require('#src/server/serverHelpers/Request');
const { getWorkerIndex, setMainIsWorker } = require('#js/server/threads/manageThreads');
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

const ordinaryUser = {
	role: {
		permission: {
			nested_constraints: {
				tables: {
					Parent: { read: true },
					Child: {
						read: true,
						attribute_permissions: [
							{ attribute_name: 'id', read: true },
							{ attribute_name: 'state', read: true },
						],
					},
				},
			},
		},
	},
};

const ordinaryAllUser = {
	role: { permission: { nested_constraints: { tables: { Parent: { read: true }, Child: { read: true } } } } },
};

describe('nested relationship constraints', function () {
	this.timeout(15000);
	let Parent, Child, server, base, previousMainIsWorker;
	let projected;
	before(async function () {
		setupTestDBPath();
		previousMainIsWorker = getWorkerIndex() === 0;
		setMainIsWorker(true);
		Child = table({
			database: 'nested_constraints',
			table: 'Child',
			attributes: [
				{ name: 'id', type: 'ID', isPrimaryKey: true },
				{ name: 'parentId', type: 'String', indexed: true },
				{ name: 'state', type: 'String', indexed: true },
				{ name: 'score', type: 'Int', indexed: true },
				{ name: 'observed', computed: true },
				{
					name: 'siblings',
					relationship: { to: 'parentId', from: 'parentId' },
					elements: { type: 'Child', definition: {} },
				},
			],
		});
		Child.attributes.find((attribute) => attribute.name === 'siblings').elements.definition.tableClass = Child;
		Child.updatedAttributes();
		Child.setComputedAttribute('observed', (record) => {
			projected.push(record.id);
			return record.score;
		});
		Parent = table({
			database: 'nested_constraints',
			table: 'Parent',
			attributes: [
				{ name: 'id', type: 'ID', isPrimaryKey: true },
				{ name: 'childId', type: 'ID' },
				{ name: 'childIds', elements: { type: 'ID' } },
				{
					name: 'children',
					relationship: { to: 'parentId' },
					elements: { type: 'Child', definition: { tableClass: Child } },
				},
				{ name: 'child', relationship: { from: 'childId' }, type: 'Child', definition: { tableClass: Child } },
				{
					name: 'references',
					relationship: { from: 'childIds' },
					elements: { type: 'Child', definition: { tableClass: Child } },
				},
			],
		});
		await Parent.put('p1', { id: 'p1', childId: 'c1', childIds: ['c1', 'missing', 'c2', 'c3', 'c4'] });
		await Parent.put('p2', { id: 'p2', childId: 'missing' });
		for (const child of children) await Child.put(child.id, child);
		const resources = new Resources();
		resources.set('Parent', Parent);
		resources.set('Child', Child);
		let rest;
		handleApplication({
			resources,
			options: { getAll: () => ({ webSocket: false }) },
			routeFor: () => ({ urlPath: '/nested-constraints' }),
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
				request.user =
					input.headers['x-fixture-role'] === 'all'
						? ordinaryAllUser
						: input.headers['x-fixture-role']
							? ordinaryUser
							: { role: { permission: { super_user: true } } };
				const response = await rest(request, () => ({ status: 404, headers: new Map(), body: 'not found' }));
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
		setMainIsWorker(previousMainIsWorker);
	});
	beforeEach(function () {
		projected = [];
	});
	async function get(path, headers) {
		const response = await fetch(base + path, { headers });
		const text = await response.text();
		assert.strictEqual(response.status, 200, text);
		return JSON.parse(text);
	}
	async function query(selection, extra = {}) {
		const rows = [];
		for await (const row of Parent.search(
			{ select: ['id', selection], ...extra },
			extra.checkPermission ? { user: ordinaryUser } : undefined
		))
			rows.push(row);
		return rows;
	}
	const ids = (rows, name = 'children') => rows.map((row) => row[name].map((child) => child?.id));
	it('retains unfiltered relationship contents', async function () {
		assert.deepStrictEqual(ids(await get('/Parent/?select(id,children{id,state,score})')), [
			['c1', 'c2', 'c3', 'c4'],
			['c5', 'c6', 'c7'],
		]);
	});
	for (const single of [false, true]) {
		const path = single ? '/Parent/p1?' : '/Parent/?';
		const rows = (result) => (single ? [result] : result);
		it(`applies nested limit per parent over HTTP (${single ? 'record' : 'collection'})`, async function () {
			assert.deepStrictEqual(
				ids(rows(await get(path + 'select(id,children[limit(1)&select(id,state,score)])'))),
				single ? [['c1']] : [['c1'], ['c5']]
			);
		});
		it(`applies nested predicates over HTTP (${single ? 'record' : 'collection'})`, async function () {
			assert.deepStrictEqual(
				ids(rows(await get(path + 'select(id,children[state=open&select(id,state,score)])'))),
				single ? [['c1', 'c3', 'c4']] : [['c1', 'c3', 'c4'], ['c6']]
			);
		});
		it(`filters before limiting over HTTP (${single ? 'record' : 'collection'})`, async function () {
			assert.deepStrictEqual(
				ids(
					rows(await get(path + 'select(id,children[state=open&score=ge=number:30&limit(1)&select(id,state,score)])'))
				),
				single ? [['c3']] : [['c3'], ['c6']]
			);
		});
	}
	it('retains outer relationship filter candidates', async function () {
		assert.deepStrictEqual(
			ids(
				await get('/Parent/?children.state=open&children.score=ge=number:30&select(id,children[limit(1)&select(id,)])')
			),
			[['c3'], ['c6']]
		);
	});
	it('retains the outer relationship predicate control', async function () {
		assert.deepStrictEqual(
			ids(await get('/Parent/?children.state=open&children.score=ge=number:30&select(id,children{id})')),
			[['c3', 'c4'], ['c6']]
		);
	});
	it('retains the child endpoint control', async function () {
		assert.deepStrictEqual(
			await get('/Child/?parentId=p1&state=open&score=ge=number:30&sort(score)&limit(1)&select(id,)'),
			[{ id: 'c3' }]
		);
	});
	it('retains the parent limit control', async function () {
		const rows = await get('/Parent/?limit(1)&select(id,children{id})');
		assert.strictEqual(rows.length, 1);
		assert.strictEqual(rows[0].children.length, 4);
	});
	it('sorts eligible children before offset and limit', async function () {
		assert.deepStrictEqual(
			ids(
				await query({
					name: 'children',
					conditions: [{ attribute: 'state', value: 'open' }],
					sort: { attribute: 'score', descending: true },
					offset: 1,
					limit: 1,
					select: ['id'],
				})
			),
			[['c3'], []]
		);
	});
	it('preserves parents when no child matches', async function () {
		assert.deepStrictEqual(
			ids(
				await query({
					name: 'children',
					conditions: [{ attribute: 'score', comparator: 'gt', value: 100 }],
					limit: 1,
					select: ['id'],
				})
			),
			[[], []]
		);
	});
	it('coerces typed values and compiles boolean groups and negation', async function () {
		const selection = {
			name: 'children',
			conditions: [
				{
					operator: 'or',
					conditions: [
						{ attribute: 'score', value: '30' },
						{ attribute: 'score', value: '50' },
					],
				},
				{ attribute: 'state', comparator: 'not_in', value: ['closed'] },
			],
			select: ['id'],
		};
		assert.deepStrictEqual(ids(await query(selection)), [['c3'], ['c6']]);
		assert.strictEqual(selection.conditions[0].conditions[0].value, '30');
		assert.strictEqual(selection.conditions[1].comparator, 'not_in');
	});
	it('does not project the unused tail of a limited relationship', async function () {
		const rows = await query({ name: 'children', limit: 1, select: ['id', 'observed'] });
		assert.deepStrictEqual(ids(rows), [['c1'], ['c5']]);
		assert.deepStrictEqual(projected, ['c1', 'c5']);
	});
	it('returns empty arrays for zero limits without projecting children', async function () {
		assert.deepStrictEqual(ids(await query({ name: 'children', limit: 0, select: ['id', 'observed'] })), [[], []]);
		assert.deepStrictEqual(projected, []);
	});
	for (const field of ['limit', 'offset'])
		for (const value of [-1, 1.5, NaN, Infinity]) {
			it(`rejects invalid nested ${field} ${value}`, async function () {
				await assert.rejects(
					() => query({ name: 'children', [field]: value, select: ['id'] }),
					(error) => error.statusCode === 400
				);
			});
		}
	it('filters singular relationships without removing the parent', async function () {
		const rows = await query({ name: 'child', conditions: [{ attribute: 'state', value: 'closed' }], select: ['id'] });
		assert.deepStrictEqual(
			rows.map((row) => row.id),
			['p1', 'p2']
		);
		assert(rows.every((row) => row.child === undefined));
	});
	it('filters FK arrays and excludes missing entries when conditions apply', async function () {
		const rows = await query({
			name: 'references',
			conditions: [{ attribute: 'state', value: 'open' }],
			limit: 2,
			select: ['id'],
		});
		assert.deepStrictEqual(rows[0].references, [{ id: 'c1' }, { id: 'c3' }]);
		assert.strictEqual(rows[1].references, undefined);
	});
	it('supports structured single-record get', async function () {
		const row = await Parent.get({
			id: 'p1',
			select: [
				'id',
				{ name: 'children', conditions: [{ attribute: 'state', value: 'open' }], limit: 1, select: ['id'] },
			],
		});
		assert.deepStrictEqual(row, { id: 'p1', children: [{ id: 'c1' }] });
	});
	it('supports a parsed offset and sort', async function () {
		const rows = [];
		for await (const row of Parent.search(
			new RequestTarget('?select(id,children[sort(-score)&limit(1,2)&select(id,)])')
		))
			rows.push(row);
		assert.deepStrictEqual(ids(rows), [['c3'], ['c6']]);
	});
	it('preserves nested limits without a select through ordinary-role authorization', async function () {
		const rows = await get('/Parent/?select(id,children[limit(1)])', { 'x-fixture-role': 'all' });
		assert.deepStrictEqual(ids(rows), [['c1'], ['c5']]);
		assert.strictEqual(rows[0].children[0].score, 10);
	});
	it('denies predicates on a child attribute the caller cannot read', async function () {
		await assert.rejects(
			() =>
				query(
					{ name: 'children', conditions: [{ attribute: 'score', comparator: 'gt', value: 20 }], select: ['id'] },
					{ checkPermission: true }
				),
			(error) => error.statusCode === 403
		);
	});
	it('honors readable predicates after ordinary-role authorization', async function () {
		const rows = await get('/Parent/?select(id,children[state=open&limit(1)&select(id,)])', {
			'x-fixture-role': 'ordinary',
		});
		assert.deepStrictEqual(ids(rows), [['c1'], ['c6']]);
	});
	it('preserves FK holes when only pagination is requested', async function () {
		const rows = await query({ name: 'references', limit: 2, select: ['id'] });
		assert.deepStrictEqual(rows[0].references, [{ id: 'c1' }, undefined]);
	});
	it('supports asynchronous child projection', async function () {
		Child.setComputedAttribute('observed', (record) => Promise.resolve(record.score));
		try {
			const rows = await query({ name: 'children', limit: 1, select: ['id', 'observed'] });
			assert.deepStrictEqual(rows[0].children, [{ id: 'c1', observed: 10 }]);
		} finally {
			Child.setComputedAttribute('observed', (record) => {
				projected.push(record.id);
				return record.score;
			});
		}
	});
	it('bounds child entry reads before materialization in a synchronous window', function () {
		if (!(Child.primaryStore instanceof RocksDatabase)) return this.skip();
		const before = Child.primaryStore.readCount;
		const rows = Array.from(
			new Parent(undefined, {}).search({ select: ['id', { name: 'children', limit: 1, select: ['id'] }] })
		);
		const after = Child.primaryStore.readCount;
		assert.deepStrictEqual(ids(rows), [['c1'], ['c5']]);
		assert.strictEqual(after - before, 2, 'one child entry read per parent, including cache hits');
		const unlimited = Array.from(
			new Parent(undefined, {}).search({ select: ['id', { name: 'children', select: ['id'] }] })
		);
		const unbounded = Child.primaryStore.readCount;
		assert.strictEqual(unlimited.flatMap((row) => row.children).length, children.length);
		assert.strictEqual(unbounded - after, children.length, 'positive control reads the full relationship');
	});
	it('applies constraints independently at two relationship depths', async function () {
		const rows = await query({
			name: 'children',
			limit: 1,
			select: [
				'id',
				{
					name: 'siblings',
					conditions: [{ attribute: 'state', value: 'open' }],
					sort: { attribute: 'score', descending: true },
					limit: 1,
					select: ['id'],
				},
			],
		});
		assert.deepStrictEqual(rows[0].children, [{ id: 'c1', siblings: [{ id: 'c4' }] }]);
		assert.deepStrictEqual(rows[1].children, [{ id: 'c5', siblings: [{ id: 'c6' }] }]);
	});
	it('keeps repeated programmatic selections reusable', async function () {
		const selection = {
			name: 'children',
			conditions: [{ attribute: 'score', comparator: 'ge', value: '30' }],
			limit: 1,
			select: ['id'],
		};
		assert.deepStrictEqual(ids(await query(selection)), [['c3'], ['c6']]);
		assert.deepStrictEqual(ids(await query(selection)), [['c3'], ['c6']]);
		assert.strictEqual(selection.conditions[0].value, '30');
	});
	it('validates pagination even when no parent matches', async function () {
		await assert.rejects(
			() =>
				query({ name: 'children', limit: -1, select: ['id'] }, { conditions: [{ attribute: 'id', value: 'absent' }] }),
			(error) => error.statusCode === 400
		);
	});
	it('rejects unsupported full-text predicates explicitly', async function () {
		await assert.rejects(
			() =>
				query({
					name: 'children',
					conditions: [{ attribute: 'state', comparator: 'matches', value: 'open' }],
					select: ['id'],
				}),
			(error) => error.statusCode === 400
		);
	});
	it('closes owned nested iterators when a transaction abandons an async projection', async function () {
		if (!(Child.primaryStore instanceof RocksDatabase)) return this.skip();
		let entered, release;
		const started = new Promise((resolve) => {
			entered = resolve;
		});
		const pending = new Promise((resolve) => {
			release = resolve;
		});
		Child.setComputedAttribute('observed', (record) => {
			entered();
			return pending.then(() => record.score);
		});
		try {
			await transaction({}, async (txn) => {
				const rows = Parent.search({ select: ['id', { name: 'children', limit: 1, select: ['id', 'observed'] }] });
				const iterator = rows[Symbol.asyncIterator]();
				const first = iterator.next();
				await started;
				assert(txn.closeOwnedReadIterators() > 0);
				assert.strictEqual(txn.closeOwnedReadIterators(), 0);
				release();
				await first;
				await iterator.return();
			});
		} finally {
			release();
			Child.setComputedAttribute('observed', (record) => {
				projected.push(record.id);
				return record.score;
			});
		}
	});
});
