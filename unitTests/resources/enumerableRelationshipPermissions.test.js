require('../testUtils');
const assert = require('assert');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { RequestTarget } = require('#src/resources/RequestTarget');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');

const READ = { read: true, insert: false, update: false, delete: false, attribute_permissions: [] };
const roleWith = (tables) => ({ role: { permission: { test: { tables } } } });
const readOnly = (...names) => ({
	...READ,
	attribute_permissions: names.map((attribute_name) => ({ attribute_name, read: true, insert: false, update: false })),
});

describe('Default reads authorize @enumerable relationships against the related table', () => {
	let EnumOrg, EnumDept, EnumEmp, EnumAuthor, EnumBook, EnumPublisher;
	before(async () => {
		setupTestDBPath();
		setMainIsWorker(true);
		EnumOrg = table({
			table: 'EnumOrg',
			database: 'test',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'name' }],
		});
		EnumDept = table({
			table: 'EnumDept',
			database: 'test',
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'name' },
				{ name: 'budget' },
				{ name: 'orgId' },
				{ name: 'org', relationship: { from: 'orgId' }, definition: { tableClass: EnumOrg }, enumerable: true },
			],
		});
		EnumEmp = table({
			table: 'EnumEmp',
			database: 'test',
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'name' },
				{ name: 'deptId' },
				{ name: 'dept', relationship: { from: 'deptId' }, definition: { tableClass: EnumDept }, enumerable: true },
			],
		});
		EnumPublisher = table({
			table: 'EnumPublisher',
			database: 'test',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'name' }],
		});
		const authorDefinition = {};
		const bookDefinition = {};
		EnumBook = table({
			table: 'EnumBook',
			database: 'test',
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'title' },
				{ name: 'authorId', indexed: true },
				{ name: 'publisherId' },
				{ name: 'author', relationship: { from: 'authorId' }, definition: authorDefinition, enumerable: true },
				{
					name: 'publisher',
					relationship: { from: 'publisherId' },
					definition: { tableClass: EnumPublisher },
					enumerable: true,
				},
			],
		});
		bookDefinition.tableClass = EnumBook;
		EnumAuthor = table({
			table: 'EnumAuthor',
			database: 'test',
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'name' },
				{
					name: 'books',
					type: 'array',
					relationship: { to: 'authorId' },
					elements: { definition: bookDefinition },
					enumerable: true,
				},
			],
		});
		authorDefinition.tableClass = EnumAuthor;
		await EnumOrg.put({ id: 'o1', name: 'Org' });
		await EnumDept.put({ id: 'd1', name: 'Eng', budget: 100, orgId: 'o1' });
		await EnumEmp.put({ id: 'e1', name: 'Ann', deptId: 'd1', extra: 'x' });
		await EnumPublisher.put({ id: 'p1', name: 'Press' });
		await EnumAuthor.put({ id: 'a1', name: 'Ada' });
		await EnumBook.put({ id: 'b1', title: 'Notes', authorId: 'a1', publisherId: 'p1' });
	});

	const plain = (value) => JSON.parse(JSON.stringify(value));
	async function getAs(Table, user, id, select, property) {
		const target = new RequestTarget('/' + id);
		target.id = id;
		if (select) target.select = select;
		if (property) target.property = property;
		target.checkPermission = true;
		return plain(await Table.get(target, { user }));
	}
	async function searchAs(Table, user, select) {
		const target = new RequestTarget('/');
		if (select) target.select = select;
		target.checkPermission = true;
		const results = [];
		for await (const result of Table.search(target, { user })) results.push(result);
		return plain(results);
	}
	const fullEmp = {
		id: 'e1',
		name: 'Ann',
		deptId: 'd1',
		extra: 'x',
		dept: { id: 'd1', name: 'Eng', budget: 100, orgId: 'o1', org: { id: 'o1', name: 'Org' } },
	};

	it('leaves out an enumerable relationship to a table the role cannot read', async () => {
		const user = roleWith({ EnumEmp: READ });
		const expected = { id: 'e1', name: 'Ann', deptId: 'd1', extra: 'x' };
		assert.deepStrictEqual(await getAs(EnumEmp, user, 'e1'), expected);
		assert.deepStrictEqual(await searchAs(EnumEmp, user), [expected]);
		assert.deepStrictEqual(await searchAs(EnumEmp, user, ['*']), [expected]);
		assert.deepStrictEqual(await getAs(EnumEmp, user, 'e1', ['*']), expected);
	});

	it('narrows an enumerable relationship to the related attributes the role can read', async () => {
		const user = roleWith({ EnumEmp: READ, EnumDept: readOnly('id', 'name') });
		const expected = { id: 'e1', name: 'Ann', deptId: 'd1', extra: 'x', dept: { id: 'd1', name: 'Eng' } };
		assert.deepStrictEqual(await getAs(EnumEmp, user, 'e1'), expected);
		assert.deepStrictEqual(await searchAs(EnumEmp, user), [expected]);
	});

	it("authorizes the related table's own enumerable relationships", async () => {
		const user = roleWith({ EnumEmp: READ, EnumDept: READ });
		const dept = { id: 'd1', name: 'Eng', budget: 100, orgId: 'o1' };
		assert.deepStrictEqual(await getAs(EnumEmp, user, 'e1'), { ...fullEmp, dept });
		assert.deepStrictEqual(await searchAs(EnumEmp, user, ['id', 'dept']), [{ id: 'e1', dept }]);
		assert.deepStrictEqual(await searchAs(EnumEmp, user, ['id', { name: 'dept', select: ['*'] }]), [
			{ id: 'e1', dept },
		]);
	});

	it('authorizes a relationship read as a property against the related table', async () => {
		await assert.rejects(getAs(EnumEmp, roleWith({ EnumEmp: READ }), 'e1', undefined, 'dept'), /Unauthorized access/);
		const restricted = roleWith({ EnumEmp: READ, EnumDept: readOnly('id', 'name') });
		assert.deepStrictEqual(await getAs(EnumEmp, restricted, 'e1', undefined, 'dept'), { id: 'd1', name: 'Eng' });
		const noOrg = roleWith({ EnumEmp: READ, EnumDept: READ });
		assert.deepStrictEqual(await getAs(EnumEmp, noOrg, 'e1', undefined, 'dept'), {
			id: 'd1',
			name: 'Eng',
			budget: 100,
			orgId: 'o1',
		});
		const readAll = roleWith({ EnumEmp: READ, EnumDept: READ, EnumOrg: READ });
		assert.deepStrictEqual(await getAs(EnumEmp, readAll, 'e1', undefined, 'dept'), fullEmp.dept);
	});

	it('returns default reads unchanged to roles that can read every related table', async () => {
		const user = roleWith({ EnumEmp: READ, EnumDept: READ, EnumOrg: READ });
		assert.deepStrictEqual(await getAs(EnumEmp, user, 'e1'), fullEmp);
		assert.deepStrictEqual(await searchAs(EnumEmp, user), [fullEmp]);
		assert.deepStrictEqual(await getAs(EnumEmp, { role: { permission: { super_user: true } } }, 'e1'), fullEmp);
	});

	it('stops a cyclic enumerable relationship at the key of the record it returns to', async () => {
		const book = { id: 'b1', title: 'Notes', authorId: 'a1', publisherId: 'p1' };
		const readAll = roleWith({ EnumAuthor: READ, EnumBook: READ, EnumPublisher: READ });
		assert.deepStrictEqual(await getAs(EnumAuthor, readAll, 'a1'), {
			id: 'a1',
			name: 'Ada',
			books: [{ ...book, author: { id: 'a1' }, publisher: { id: 'p1', name: 'Press' } }],
		});
		const noPublisher = roleWith({ EnumAuthor: READ, EnumBook: READ });
		const expected = { id: 'a1', name: 'Ada', books: [{ ...book, author: { id: 'a1' } }] };
		assert.deepStrictEqual(await getAs(EnumAuthor, noPublisher, 'a1'), expected);
		assert.deepStrictEqual(await searchAs(EnumAuthor, noPublisher), [expected]);
	});
});
