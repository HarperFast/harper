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
				{ name: 'metadata', type: 'Any' },
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
		await Parent.put('p1', {
			id: 'p1',
			childId: 'c1',
			childIds: ['c1', 'missing', 'c2', 'c3', 'c4'],
			metadata: { label: 'kept', hidden: 'omit' },
		});
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
		if (previousMainIsWorker !== undefined) setMainIsWorker(previousMainIsWorker);
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
				const rows = Parent.search({ select: ['id', { name: 'children', limit: 2, select: ['id', 'observed'] }] });
				const iterator = rows[Symbol.asyncIterator]();
				const first = iterator.next();
				await started;
				assert(txn.closeOwnedReadIterators() >= 2, 'owns both parent and nested child iterators');
				assert.strictEqual(txn.closeOwnedReadIterators(), 0);
				const readsAtClose = Child.primaryStore.readCount;
				release();
				const result = await first;
				assert.deepStrictEqual(result.value.children, []);
				assert.strictEqual(Child.primaryStore.readCount, readsAtClose, 'no reads after cancellation');
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
	it('keeps comparison reads of FK arrays synchronous and array-valued', function () {
		const values = Parent.propertyResolvers.references(
			{ childIds: ['c1', 'c2'] },
			{},
			undefined,
			false,
			undefined,
			true
		);
		assert(Array.isArray(values));
		assert.deepStrictEqual(
			values.map((record) => record.id),
			['c1', 'c2']
		);
	});
	it('resolves asynchronous constrained relationships in positional single-record selections', async function () {
		Child.setComputedAttribute('observed', (record) => Promise.resolve(record.score));
		const select = ['id', { name: 'children', limit: 1, select: ['id', 'observed'] }];
		select.asArray = true;
		try {
			assert.deepStrictEqual(await Parent.get({ id: 'p1', select }), ['p1', [{ id: 'c1', observed: 10 }]]);
		} finally {
			Child.setComputedAttribute('observed', (record) => {
				projected.push(record.id);
				return record.score;
			});
		}
	});
	it('yields while scanning rejected children before an unsatisfied limit', async function () {
		await Parent.put('p-yield', { id: 'p-yield' });
		const rows = Array.from({ length: 2050 }, (_, index) => ({
			id: `yield-${index}`,
			parentId: 'p-yield',
			state: 'closed',
			score: index,
		}));
		await Child.put(rows);
		try {
			const results = new Parent(undefined, {}).search({
				conditions: [{ attribute: 'id', value: 'p-yield' }],
				select: [
					'id',
					{ name: 'children', conditions: [{ attribute: 'state', value: 'absent' }], limit: 1, select: ['id'] },
				],
			});
			let yielded = false;
			setImmediate(() => {
				yielded = true;
			});
			const iterator = results[Symbol.asyncIterator]();
			try {
				const first = await iterator.next();
				assert.strictEqual(yielded, true, 'rejected candidates yield to the event loop');
				assert.deepStrictEqual(first.value.children, []);
			} finally {
				await iterator.return();
			}
		} finally {
			await Child.delete({ conditions: [{ attribute: 'parentId', value: 'p-yield' }] });
			await Parent.delete('p-yield');
		}
	});
	for (const id of [undefined, 'p1']) {
		it(`rejects unsupported plain JSON query constraints before reading ${id || 'a collection'}`, async function () {
			const target = { select: ['id', { name: 'metadata', limit: 1, select: ['label'] }] };
			await assert.rejects(
				async () => {
					if (id) await Parent.get({ id, ...target });
					else for await (const row of Parent.search(target)) void row;
				},
				(error) => error.statusCode === 400
			);
		});
	}
	it('rejects unsupported options nested below plain JSON projections', async function () {
		await assert.rejects(
			async () =>
				Parent.get({
					id: 'p1',
					select: [{ name: 'metadata', select: [{ name: 'tags', limit: 1, select: ['label'] }] }],
				}),
			(error) => error.statusCode === 400
		);
	});
	it('does not mutate caller selection objects when a nested sort propagates to a relationship', async function () {
		const selection = {
			name: 'children',
			sort: { attribute: ['siblings', 'score'], descending: true },
			limit: 1,
			select: Object.freeze(['id', Object.freeze({ name: 'siblings', select: ['id', 'score'] })]),
		};
		const before = JSON.stringify(selection);
		await query(selection);
		await query(selection);
		assert.strictEqual(JSON.stringify(selection), before);
	});
	it('drops missing FK targets when sorting, matching the existing sort contract', async function () {
		const rows = await query({ name: 'references', sort: { attribute: 'score' }, limit: 2, select: ['id'] });
		assert.deepStrictEqual(rows[0].references, [{ id: 'c1' }, { id: 'c2' }]);
	});
	it('preserves an absent foreign key under a zero limit without reading children', async function () {
		const rows = await query({ name: 'references', limit: 0, select: ['id'] });
		assert.deepStrictEqual(rows[0].references, []);
		assert.strictEqual(rows[1].references, undefined);
	});
	for (const single of [false, true])
		it(`retains plain JSON bracket projections without constraints (${single ? 'record' : 'collection'})`, async function () {
			const result = await get((single ? '/Parent/p1?' : '/Parent/?') + 'select(id,metadata[select(label,)])');
			const row = single ? result : result[0];
			assert.deepStrictEqual(row.metadata, { label: 'kept' });
		});
	for (const nestedOnly of [false, true])
		it(`cancels in-flight child projections when the parent iterator is returned (${nestedOnly ? 'nested-only' : 'direct'})`, async function () {
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
					const selection = nestedOnly
						? { name: 'children', select: ['id', { name: 'siblings', limit: 2, select: ['id', 'observed'] }] }
						: { name: 'children', limit: 2, select: ['id', 'observed'] };
					const results = Parent.search({ select: ['id', selection] });
					const iterator = results[Symbol.asyncIterator]();
					const first = Promise.resolve(iterator.next()).then(
						(value) => ({ value }),
						(error) => ({ error })
					);
					await started;
					await iterator.return();
					const readsAtReturn = Child.primaryStore.readCount;
					release();
					const settled = await first;
					assert.ifError(settled.error);
					assert.strictEqual(Child.primaryStore.readCount, readsAtReturn, 'returning the parent must stop child reads');
					assert.strictEqual(txn.closeOwnedReadIterators(), 0, 'no abandoned nested cursor remains owned');
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
