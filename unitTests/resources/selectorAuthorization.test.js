const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils.js');
const { table } = require('#src/resources/databases');
const { RequestTarget } = require('#src/resources/RequestTarget');
const { getWorkerIndex, setMainIsWorker } = require('#src/server/threads/manageThreads');

const database = 'selector_authorization';
const broadUser = {
	role: {
		permission: {
			[database]: { tables: { Parent: { read: true }, Child: { read: true }, Leaf: { read: true } } },
		},
	},
};
const restrictedUser = {
	role: {
		permission: {
			[database]: {
				tables: {
					Parent: { read: true },
					Child: {
						read: true,
						attribute_permissions: [
							{ attribute_name: 'id', read: true },
							{ attribute_name: 'leaf', read: true },
						],
					},
					Leaf: { read: true, attribute_permissions: [{ attribute_name: 'id', read: true }] },
				},
			},
		},
	},
};
const expected = (user) => ({
	id: 'p1',
	child: {
		id: 'c1',
		...(user === broadUser ? { secret: 'child value' } : {}),
		leaf: { id: 'l1', ...(user === broadUser ? { secret: 'leaf value' } : {}) },
	},
});
const selectors = {
	object: () => ({ name: 'child', select: ['id', 'secret', { name: 'leaf', select: ['id', 'secret'] }] }),
	braced: () => new RequestTarget('?select(id,child{id,secret,leaf{id,secret}})').select[1],
	query: () => new RequestTarget('?select(id,child[select(id,secret,leaf[select(id,secret)])])').select[1],
};
const assertUnchanged = (selection, original) => {
	assert.deepStrictEqual(structuredClone(selection), original);
	const checkSymbols = (value) => {
		if (value && typeof value === 'object') {
			assert.deepStrictEqual(Object.getOwnPropertySymbols(value), []);
			for (const nested of Object.values(value)) checkSymbols(nested);
		}
	};
	checkSymbols(selection);
};
const freeze = (value) => {
	if (value && typeof value === 'object') {
		for (const nested of Object.values(value)) freeze(nested);
		Object.freeze(value);
	}
	return value;
};

describe('relationship selector authorization isolation', function () {
	this.timeout(15000);
	let Parent, previousMainIsWorker;
	before(async function () {
		setupTestDBPath();
		previousMainIsWorker = getWorkerIndex() === 0;
		setMainIsWorker(true);
		const Leaf = table({
			database,
			table: 'Leaf',
			attributes: [
				{ name: 'id', type: 'ID', isPrimaryKey: true },
				{ name: 'secret', type: 'String' },
			],
		});
		const Child = table({
			database,
			table: 'Child',
			attributes: [
				{ name: 'id', type: 'ID', isPrimaryKey: true },
				{ name: 'secret', type: 'String' },
				{ name: 'leafId', type: 'ID' },
				{ name: 'leaf', relationship: { from: 'leafId' }, type: 'Leaf', definition: { tableClass: Leaf } },
			],
		});
		Parent = table({
			database,
			table: 'Parent',
			attributes: [
				{ name: 'id', type: 'ID', isPrimaryKey: true },
				{ name: 'childId', type: 'ID' },
				{ name: 'metadata', type: 'Any' },
				{ name: 'child', relationship: { from: 'childId' }, type: 'Child', definition: { tableClass: Child } },
			],
		});
		await Leaf.put('l1', { id: 'l1', secret: 'leaf value' });
		await Child.put('c1', { id: 'c1', secret: 'child value', leafId: 'l1' });
		await Parent.put('p1', {
			id: 'p1',
			childId: 'c1',
			metadata: { childId: 'c1', $id: 'stored-id', child: { id: 'stored-child', secret: 'stored-value' } },
		});
	});
	after(function () {
		setMainIsWorker(previousMainIsWorker);
	});
	async function read(method, selection, user, permission = user.role.permission, select = ['id', selection]) {
		const target = { id: 'p1', select, checkPermission: permission };
		if (method === 'get') return Parent.get(target, { user });
		delete target.id;
		target.conditions = [{ attribute: 'id', comparator: 'equals', value: 'p1' }];
		const rows = [];
		for await (const row of Parent.search(target, { user })) rows.push(row);
		assert.strictEqual(rows.length, 1);
		return rows[0];
	}
	for (const method of ['get', 'search']) {
		for (const [order, users] of [
			['broad then restricted', [broadUser, restrictedUser]],
			['restricted then broad', [restrictedUser, broadUser]],
		]) {
			it(`${method} isolates relationships beside stored JSON resolver names, ${order}`, async function () {
				const selection = selectors.object();
				const original = structuredClone(selection);
				const jsonSelection = freeze({
					name: 'metadata',
					select: ['$id', { name: 'child', select: ['id', 'secret'] }],
				});
				const originalJson = structuredClone(jsonSelection);
				for (const user of users) {
					const result = await read(method, selection, user, user.role.permission, ['id', selection, jsonSelection]);
					assert.deepStrictEqual(result, {
						...expected(user),
						metadata: { $id: 'stored-id', child: { id: 'stored-child', secret: 'stored-value' } },
					});
				}
				assertUnchanged(selection, original);
				assertUnchanged(jsonSelection, originalJson);
			});
		}
		for (const [shape, createSelection] of Object.entries(selectors)) {
			for (const [order, users] of [
				['broad then restricted', [broadUser, restrictedUser]],
				['restricted then broad', [restrictedUser, broadUser]],
			]) {
				it(`${method} isolates reused ${shape} selectors, ${order}`, async function () {
					const selection = createSelection();
					const original = structuredClone(selection);
					for (const user of users) assert.deepStrictEqual(await read(method, selection, user), expected(user));
					assertUnchanged(selection, original);
				});
			}
			it(`${method} accepts a frozen ${shape} selector without changing it`, async function () {
				const selection = freeze(createSelection());
				assert.deepStrictEqual(await read(method, selection, restrictedUser), expected(restrictedUser));
			});
		}
		it(`${method} preserves caller metadata on a reusable named array selector`, async function () {
			const selection = selectors.braced();
			selection.asArray = true;
			selection.forceNulls = true;
			const original = structuredClone(selection);
			assert.deepStrictEqual(await read(method, selection, restrictedUser), expected(restrictedUser));
			assertUnchanged(selection, original);
		});
		it(`${method} authorizes parsed nested predicates after copying the selector`, async function () {
			const selection = new RequestTarget('?select(id,child[leafId=l1&select(id,secret,leaf[select(id,secret)])])')
				.select[1];
			const original = structuredClone(selection);
			await assert.rejects(
				() => read(method, selection, restrictedUser),
				(error) => error.statusCode === 403
			);
			assert.deepStrictEqual(await read(method, selection, broadUser), expected(broadUser));
			assertUnchanged(selection, original);
		});
		it(`${method} retains explicit trusted nested permission controls`, async function () {
			const selection = selectors.object();
			selection.checkPermission = restrictedUser.role.permission;
			const original = structuredClone(selection);
			assert.deepStrictEqual(await read(method, selection, broadUser), expected(restrictedUser));
			assertUnchanged(selection, original);
		});
		it(`${method} still omits a related table the caller cannot read`, async function () {
			const deniedUser = {
				role: { permission: { [database]: { tables: { Parent: { read: true }, Child: { read: false } } } } },
			};
			const selection = selectors.object();
			const original = structuredClone(selection);
			assert.deepStrictEqual(await read(method, selection, deniedUser), { id: 'p1' });
			assertUnchanged(selection, original);
		});
	}
});
