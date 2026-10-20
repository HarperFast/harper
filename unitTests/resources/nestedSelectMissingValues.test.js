const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { RequestTarget } = require('#src/resources/RequestTarget');
const { Resource, transformForSelect } = require('#src/resources/Resource');
const { getWorkerIndex, setMainIsWorker } = require('#src/server/threads/manageThreads');

describe('nested select over missing relationship values', function () {
	let Parent, Child, previousMainIsWorker;
	const jsonRecord = {
		id: 'plain-json',
		metadata: { label: 'kept', details: { flag: true, hidden: 'omit' }, hidden: 'omit' },
		notes: [{ label: 'first', hidden: 'omit' }, null, 'literal', {}],
		createdAt: new Date('2026-01-01T00:00:00.000Z'),
	};
	const jsonSelection = [
		'id',
		{ name: 'metadata', select: ['label', { name: 'details', select: ['flag'] }] },
		{ name: 'notes', select: ['label'] },
	];
	const projectedJson = {
		id: jsonRecord.id,
		metadata: { label: 'kept', details: { flag: true } },
		notes: [{ label: 'first' }, null, 'literal', { label: undefined }],
	};
	const positional = ['name'];
	positional.asArray = true;
	const projections = [
		{ name: 'scalar', select: 'name', present: 'child' },
		{ name: 'object', select: ['name'], present: { name: 'child' } },
		{ name: 'positional array', select: positional, present: ['child'] },
	];

	before(async function () {
		setupTestDBPath();
		previousMainIsWorker = getWorkerIndex() === 0;
		setMainIsWorker(true);
		Child = table({
			database: 'nested_select_missing',
			table: 'Child',
			attributes: [
				{ name: 'id', isPrimaryKey: true, type: 'Int' },
				{ name: 'name', type: 'String' },
			],
		});
		Parent = table({
			database: 'nested_select_missing',
			table: 'Parent',
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'childId', type: 'Int' },
				{ name: 'childIds', elements: { type: 'Int' } },
				{ name: 'number', type: 'Int' },
				{ name: 'text', type: 'String' },
				{ name: 'flag', type: 'Boolean' },
				{ name: 'metadata', type: 'Any' },
				{ name: 'notes', elements: { type: 'Any' } },
				{ name: 'createdAt', type: 'Date' },
				{
					name: 'child',
					type: 'Child',
					relationship: { from: 'childId' },
					definition: { tableClass: Child },
				},
				{
					name: 'children',
					elements: { type: 'Child', definition: { tableClass: Child } },
					relationship: { from: 'childIds' },
				},
			],
		});
		await Child.put({ id: 1, name: 'child' });
		await Parent.put({ id: 'absent' });
		await Parent.put({ id: 'null-foreign-key', childId: null });
		await Parent.put({ id: 'orphan', childId: 0 });
		await Parent.put({ id: 'present', childId: 1 });
		await Parent.put({ id: 'mixed', childIds: [1, 0] });
		await Parent.put({ id: 'primitives-falsy', number: 0, text: '', flag: false });
		await Parent.put({ id: 'primitives-truthy', number: 1, text: 'value', flag: true });
		await Parent.put(jsonRecord);
		await Parent.put({
			id: 'ordinary-keys',
			metadata: JSON.parse(
				'{"then":"ordinary data","getRecord":"ordinary data","getChanges":"ordinary data","hasOwnProperty":"ordinary data","city":"Denver","constructor":{"city":"Denver","hidden":"omit"},"__proto__":{"city":"Denver","hidden":"omit"}}'
			),
		});
	});

	after(async function () {
		try {
			await Parent?.dropTable();
			await Child?.dropTable();
		} finally {
			setMainIsWorker(previousMainIsWorker);
		}
	});

	for (const projection of projections) {
		it(`assimilates a real promise in a classless ${projection.name} transform`, async function () {
			assert.deepStrictEqual(
				await transformForSelect(projection.select)(Promise.resolve({ name: 'child' })),
				projection.present
			);
		});
		it(`keeps class-backed primitive extraction in a ${projection.name} transform unchanged`, function () {
			const expected =
				projection.name === 'scalar' ? undefined : projection.name === 'object' ? { name: undefined } : [undefined];
			assert.deepStrictEqual(transformForSelect(projection.select, Child)('literal'), expected);
		});
		it(`projects mixed plain JSON arrays in a ${projection.name} selection like search`, async function () {
			const select = projection.name === 'scalar' ? 'label' : ['label'];
			if (projection.name === 'positional array') select.asArray = true;
			const target = new RequestTarget();
			target.id = jsonRecord.id;
			target.select = ['id', { name: 'notes', select }];
			const expected = {
				id: jsonRecord.id,
				notes: [
					projection.name === 'scalar' ? 'first' : projection.name === 'object' ? { label: 'first' } : ['first'],
					null,
					'literal',
					projection.name === 'scalar' ? undefined : projection.name === 'object' ? { label: undefined } : [undefined],
				],
			};
			assert.deepStrictEqual(
				await Parent.search({
					conditions: [{ attribute: 'id', value: jsonRecord.id }],
					select: target.select,
				}).asArray,
				[expected]
			);
			assert.deepStrictEqual(await Parent.get(target), expected);
		});
		for (const [id, expected] of [
			['absent', undefined],
			['null-foreign-key', null],
			['orphan', undefined],
		]) {
			it(`preserves ${id} native relationship values in a ${projection.name} projection`, async function () {
				const target = new RequestTarget();
				target.id = id;
				target.select = ['id', { name: 'child', select: projection.select }];
				const row = await Parent.get(target);
				assert.deepStrictEqual(row, { id, child: expected });
			});
		}
		it(`projects a present native relationship in a ${projection.name} projection`, async function () {
			const target = new RequestTarget();
			target.id = 'present';
			target.select = ['id', { name: 'child', select: projection.select }];
			assert.deepStrictEqual(await Parent.get(target), { id: 'present', child: projection.present });
		});
		it(`preserves missing entries in a ${projection.name} relationship array`, async function () {
			const target = new RequestTarget();
			target.id = 'mixed';
			target.select = ['id', { name: 'children', select: projection.select }];
			assert.deepStrictEqual(await Parent.get(target), {
				id: 'mixed',
				children: [projection.present, undefined],
			});
		});

		for (const value of [undefined, null]) {
			it(`preserves ${value} and its promise in a ${projection.name} transform`, async function () {
				const transform = transformForSelect(projection.select, Child);
				assert.strictEqual(transform(value), value);
				assert.strictEqual(await transform(Promise.resolve(value)), value);
			});
		}
	}

	it('preserves forceNulls on a missing nested relationship', async function () {
		const target = new RequestTarget();
		target.id = 'orphan';
		target.select = ['id', { name: 'child', select: ['name'] }];
		target.select.forceNulls = true;
		assert.deepStrictEqual(await Parent.get(target), { id: 'orphan', child: null });
	});

	it('passes primitive selected values through before constructing a nested transform', async function () {
		for (const expected of [
			{ id: 'primitives-falsy', number: 0, text: '', flag: false },
			{ id: 'primitives-truthy', number: 1, text: 'value', flag: true },
		]) {
			const target = new RequestTarget();
			target.id = expected.id;
			target.select = ['id', ...['number', 'text', 'flag'].map((name) => ({ name, select: ['name'] }))];
			assert.deepStrictEqual(await Parent.get(target), expected);
		}
	});

	it('projects plain nested JSON through native get like native search', async function () {
		const target = new RequestTarget();
		target.id = jsonRecord.id;
		target.select = jsonSelection;
		const searched = await Parent.search({
			conditions: [{ attribute: 'id', value: jsonRecord.id }],
			select: jsonSelection,
		}).asArray;
		assert.deepStrictEqual(searched, [projectedJson]);
		assert.deepStrictEqual(await Parent.get(target), projectedJson);
	});

	it('projects custom Resource JSON without property resolvers after read admission', async function () {
		let admitted = 0;
		class JsonResource extends Resource {
			static loadAsInstance = true;
			allowRead() {
				admitted++;
				return true;
			}
			get() {
				return jsonRecord;
			}
		}
		assert.strictEqual(JsonResource.propertyResolvers, undefined);
		const target = new RequestTarget();
		target.id = jsonRecord.id;
		target.select = jsonSelection;
		target.checkPermission = {};
		const result = await JsonResource.get(target);
		assert.strictEqual(admitted, 1);
		assert.deepStrictEqual(result, projectedJson);
	});

	for (const forceNulls of [false, true]) {
		it(`treats classless function values as absent with forceNulls=${forceNulls}`, async function () {
			class FunctionJson extends Resource {
				static loadAsInstance = true;
				get() {
					return { metadata: { callback() {}, label: 'kept' } };
				}
			}
			const nested = ['callback', 'toString', 'label'];
			nested.forceNulls = forceNulls;
			const target = new RequestTarget();
			target.id = 'json';
			target.select = [{ name: 'metadata', select: nested }];
			assert.deepStrictEqual(await FunctionJson.get(target), {
				metadata: { callback: forceNulls ? null : undefined, toString: forceNulls ? null : undefined, label: 'kept' },
			});
		});
	}

	it('keeps read denial before projecting custom Resource JSON', async function () {
		let read = false;
		class DeniedJsonResource extends Resource {
			static loadAsInstance = true;
			allowRead() {
				return false;
			}
			get() {
				read = true;
				return jsonRecord;
			}
		}
		const target = new RequestTarget();
		target.id = jsonRecord.id;
		target.select = jsonSelection;
		target.checkPermission = {};
		await assert.rejects(
			Promise.resolve().then(() => DeniedJsonResource.get(target)),
			{ statusCode: 401 }
		);
		assert.strictEqual(read, false);
	});

	it('preserves native Date values under plain nested selection like search', async function () {
		const select = ['id', { name: 'createdAt', select: ['name'] }];
		const target = new RequestTarget();
		target.id = jsonRecord.id;
		target.select = select;
		const expected = { id: jsonRecord.id, createdAt: jsonRecord.createdAt };
		assert.deepStrictEqual(
			await Parent.search({
				conditions: [{ attribute: 'id', value: jsonRecord.id }],
				select,
			}).asArray,
			[expected]
		);
		assert.deepStrictEqual(await Parent.get(target), expected);
	});

	it('projects ordinary method-like JSON keys without invoking them', async function () {
		const target = new RequestTarget();
		target.id = 'ordinary-keys';
		target.select = [{ name: 'metadata', select: ['city', 'then', 'getRecord', 'getChanges', 'hasOwnProperty'] }];
		assert.deepStrictEqual(await Parent.get(target), {
			metadata: {
				city: 'Denver',
				then: 'ordinary data',
				getRecord: 'ordinary data',
				getChanges: 'ordinary data',
				hasOwnProperty: 'ordinary data',
			},
		});
	});

	it('projects stored constructor JSON data without leaking sibling fields', async function () {
		const stored = await Parent.get('ordinary-keys');
		assert.strictEqual(Object.hasOwn(stored.metadata, '__proto__'), false);
		assert.deepStrictEqual(stored.metadata.__proto_, { city: 'Denver', hidden: 'omit' });
		const target = new RequestTarget();
		target.id = 'ordinary-keys';
		target.select = [{ name: 'metadata', select: [{ name: 'constructor', select: ['city'] }] }];
		const result = await Parent.get(target);
		assert.deepStrictEqual(result, { metadata: { constructor: { city: 'Denver' } } });
		assert.strictEqual(Object.getPrototypeOf(result.metadata), Object.prototype);
	});

	it('preserves own __proto__ JSON data from a custom Resource without changing output prototypes', async function () {
		class PrototypeJson extends Resource {
			static loadAsInstance = true;
			get() {
				return JSON.parse(
					'{"metadata":{"constructor":{"city":"Denver","hidden":"omit"},"__proto__":{"city":"Denver","hidden":"omit"}}}'
				);
			}
		}
		const target = new RequestTarget();
		target.id = 'json';
		target.select = [
			{
				name: 'metadata',
				select: [
					{ name: 'constructor', select: ['city'] },
					{ name: '__proto__', select: ['city'] },
				],
			},
		];
		const result = await PrototypeJson.get(target);
		assert.deepStrictEqual(
			result,
			JSON.parse('{"metadata":{"constructor":{"city":"Denver"},"__proto__":{"city":"Denver"}}}')
		);
		assert.strictEqual(Object.getPrototypeOf(result.metadata), Object.prototype);
	});

	it('applies nested forceNulls through three JSON levels', async function () {
		const details = ['flag', 'absent'];
		details.forceNulls = true;
		const metadata = ['label', 'absent', { name: 'details', select: details }];
		metadata.forceNulls = true;
		const target = new RequestTarget();
		target.id = jsonRecord.id;
		target.select = [{ name: 'metadata', select: metadata }];
		assert.deepStrictEqual(await Parent.get(target), {
			metadata: { label: 'kept', absent: null, details: { flag: true, absent: null } },
		});
	});

	it('preserves native mutable table projection methods', async function () {
		const loadAsInstance = Parent.loadAsInstance;
		Parent.loadAsInstance = true;
		Parent.getReturnMutable = true;
		try {
			const instance = await Parent.get(jsonRecord.id);
			assert.strictEqual(typeof instance.getRecord, 'function');
			assert.strictEqual(typeof instance.getChanges, 'function');
			const target = new RequestTarget();
			target.id = jsonRecord.id;
			target.select = ['id', { name: 'metadata', select: ['label'] }];
			assert.deepStrictEqual(await Parent.get(target), { id: jsonRecord.id, metadata: { label: 'kept' } });
		} finally {
			Parent.getReturnMutable = false;
			Parent.loadAsInstance = loadAsInstance;
		}
	});

	it('retains registered resolver getters and inherited non-function JSON data', async function () {
		class GetterJson extends Resource {
			static loadAsInstance = true;
			static get propertyResolvers() {
				return { virtual: () => 'computed' };
			}
			get() {
				return { metadata: Object.create({ city: 'Denver' }) };
			}
		}
		const target = new RequestTarget();
		target.id = 'getters';
		target.select = ['virtual', { name: 'metadata', select: ['city'] }];
		assert.deepStrictEqual(await GetterJson.get(target), { virtual: 'computed', metadata: { city: 'Denver' } });
	});
	it('projects a single selection object like a single property name', function () {
		assert.deepStrictEqual(transformForSelect({ name: 'city', select: ['zip'] })({ city: { zip: '80202', x: 1 } }), {
			zip: '80202',
		});
		assert.strictEqual(transformForSelect({ name: 'city' })({ city: 'Denver' }), 'Denver');
	});
});
