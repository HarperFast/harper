// Code-first schema: the canonical `defineTable` + `types` model (runtime behavior).
//
// `defineTable` eagerly registers through the same `table()` factory GraphQL drives
// (resources/databases.ts) and returns the live table class — the import IS the handle.
// Covered here: registry entry, attribute metadata, canonical properties projection, CRUD,
// schema evolution, relationships via lazy thunks (including a FORWARD reference), and the
// front-end parity guardrail (code-first and GraphQL project identical `properties`).

require('../testUtils');
const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { databases, table } = require('#src/resources/databases');
const { loadGQLSchema } = require('#src/resources/graphql');
const { setMainIsWorker } = require('#src/server/threads/manageThreads');
const { RequestTarget } = require('#src/resources/RequestTarget');
const { defineTable, types } = require('#src/resources/defineTable');
const { transaction } = require('#src/resources/transaction');

const { id, string, int, date } = types;
const DB = 'codefirst_test';

describe('canonical defineTable — eager registration', () => {
	let Track;

	before(function () {
		setupTestDBPath();
		setMainIsWorker(true);
		Track = defineTable(
			'Track',
			{
				id: id.primaryKey,
				name: string.indexed,
				duration: int.nullable,
				status: types.enum(['draft', 'published']).indexed,
				createdAt: date.createdTime,
			},
			{ database: DB }
		);
	});

	it('returns the live registered class — the handle IS the registry entry', () => {
		assert.ok(databases[DB], `database "${DB}" should exist`);
		assert.strictEqual(databases[DB].Track, Track);
		assert.strictEqual(Track.tableName, 'Track');
	});

	it('carries the compiled schema as attribute metadata', () => {
		assert.strictEqual(Track.primaryKey, 'id');
		const byName = Object.fromEntries(Track.attributes.map((a) => [a.name, a]));
		assert.deepStrictEqual(Object.keys(byName).sort(), ['createdAt', 'duration', 'id', 'name', 'status']);
		assert.strictEqual(byName.id.isPrimaryKey, true);
		assert.strictEqual(byName.name.indexed, true);
		assert.strictEqual(byName.name.nullable, false, 'plain field is required, like GraphQL `!`');
		assert.strictEqual(byName.duration.nullable, undefined, '.nullable leaves the attr unmarked, like GraphQL plain');
		assert.strictEqual(byName.status.type, 'String', 'enum compiles to a String column');
		assert.strictEqual(byName.createdAt.assignCreatedTime, true);
		assert.strictEqual(byName.createdAt.nullable, undefined, 'server-managed stays unmarked');
	});

	it('co-populates the canonical properties Record (same projector as GraphQL)', () => {
		const { properties } = Track;
		assert.ok(properties, 'Table.properties Record exists');
		assert.strictEqual(properties.id.type, 'string', 'ID → JSON Schema "string"');
		assert.strictEqual(properties.id.primaryKey, true);
		assert.strictEqual(properties.duration.type, 'integer', 'Int → JSON Schema "integer"');
		assert.strictEqual(properties.status.type, 'string', 'enum → String → "string"');
		assert.strictEqual(properties.createdAt.assignCreatedTime, true);
	});

	it('supports CRUD through the handle, with the server-managed timestamp auto-assigned', async () => {
		await Track.put({ id: 'intro', name: 'Intro', status: 'draft' });
		const got = await Track.get('intro');
		assert.strictEqual(got.name, 'Intro');
		assert.strictEqual(got.status, 'draft');
		assert.ok(got.createdAt != null, 'createdAt auto-assigned');

		await Track.put({ id: 'intro', name: 'Intro (remastered)', status: 'published' });
		assert.strictEqual((await Track.get('intro')).name, 'Intro (remastered)');

		await Track.delete('intro');
		assert.ok((await Track.get('intro')) == null, 'record gone after delete');
	});

	it('re-defining the table applies the schema change (added attribute) — DDL parity', () => {
		const Track2 = defineTable(
			'Track',
			{
				id: id.primaryKey,
				name: string.indexed,
				duration: int.nullable,
				status: types.enum(['draft', 'published']).indexed,
				createdAt: date.createdTime,
				isrc: string.indexed, // newly added
			},
			{ database: DB }
		);
		assert.strictEqual(Track2, Track, 'same class re-asserted, not duplicated');
		assert.ok(Track.attributes.map((a) => a.name).includes('isrc'), 'added attribute present after re-definition');
	});
});

describe('canonical relationships — lazy thunks, forward reference', () => {
	let Book, Author;

	before(function () {
		setupTestDBPath();
		setMainIsWorker(true);
		// Book references Author BEFORE Author is defined — the thunk defers resolution to first
		// use (by which time Author exists), exactly like module-scope forward references.
		Book = defineTable(
			'Book',
			{
				id: id.primaryKey,
				title: string,
				authorId: id.indexed, // the FK must be declared (typed + writable), like GraphQL
				author: types.relation(() => Author, { from: 'authorId' }), // many-to-one, forward ref
			},
			{ database: DB }
		);
		Author = defineTable(
			'Author',
			{
				id: id.primaryKey,
				name: string,
				books: types.hasMany(() => Book, { to: 'authorId' }), // one-to-many, back ref
			},
			{ database: DB }
		);
	});

	it('compiles a relation into a relationship attribute alongside the declared FK column', () => {
		const byName = Object.fromEntries(Book.attributes.map((a) => [a.name, a]));
		assert.ok(byName.author, 'relationship attribute present');
		assert.strictEqual(byName.author.type, 'Author', 'lazy type resolves to the related table name');
		assert.deepStrictEqual(byName.author.relationship, { from: 'authorId' });
		assert.strictEqual(byName.author.definition.tableClass, Author, 'definition links the related class');
		assert.strictEqual(byName.author.definition.type, 'Author', 'definition carries type for OpenAPI components');
		assert.strictEqual(byName.author.definition.attributes, Author.attributes, 'definition carries attributes');
		assert.strictEqual(byName.authorId.type, 'ID', 'declared FK is typed');
		assert.strictEqual(byName.authorId.indexed, true, 'FK column indexed for join lookups');
		assert.ok(Book.properties.authorId, 'declared FK projected into the canonical properties Record');
	});

	it('rejects a relation whose foreign key is not declared in the shape', () => {
		assert.throws(
			() =>
				defineTable(
					'Orphan',
					{
						id: id.primaryKey,
						other: types.relation(() => Author, { from: 'otherId' }), // otherId not declared
					},
					{ database: DB }
				),
			/foreign key "otherId", which must be declared/
		);
	});

	it('compiles hasMany into an array relationship with lazy element type', () => {
		const byName = Object.fromEntries(Author.attributes.map((a) => [a.name, a]));
		assert.ok(byName.books, 'hasMany attribute present');
		assert.strictEqual(byName.books.type, 'array');
		assert.deepStrictEqual(byName.books.relationship, { to: 'authorId' });
		assert.strictEqual(byName.books.elements.type, 'Book');
		assert.strictEqual(byName.books.elements.definition.tableClass, Book);
	});

	it('resolves related records in both directions', async () => {
		await Author.put({ id: 'a1', name: 'Ada' });
		await Book.put({ id: 'b1', title: 'On Computation', authorId: 'a1' });

		const book = await Book.get('b1', {});
		assert.strictEqual(book.title, 'On Computation');
		assert.strictEqual(book.authorId, 'a1', 'foreign key round-trips');
		const author = await book.author; // forward-referenced relation resolves
		assert.ok(author, 'relationship resolved');
		assert.strictEqual(author.name, 'Ada');

		const authorRec = await Author.get('a1', {});
		const books = await authorRec.books; // hasMany resolves through the FK index
		assert.ok(Array.isArray(books), 'hasMany resolves to an array');
		assert.strictEqual(books.length, 1);
		assert.strictEqual(books[0].title, 'On Computation');
	});
});

describe('relationOf/hasManyOf — mutual-pair escape hatch', () => {
	// `relationOf`/`hasManyOf` exist to break a TYPE-level const-initializer cycle; at RUNTIME they
	// compile through the exact same code path as `relation`/`hasMany` (the type param is erased —
	// only the value shape,
	// `{ kind: 'relation', meta: { target, from|to } }`, drives compileTypeDef). This proves that
	// equivalence: a Publisher<->Edition pair built with the *Of variants resolves identically to
	// the plain-variant Book<->Author pair above.
	let Edition, Publisher;

	before(function () {
		setupTestDBPath();
		setMainIsWorker(true);
		Edition = defineTable(
			'Edition',
			{
				id: id.primaryKey,
				name: string,
				publisherId: id.indexed,
				publisher: types.relationOf(() => Publisher, { from: 'publisherId' }),
			},
			{ database: DB }
		);
		Publisher = defineTable(
			'Publisher',
			{
				id: id.primaryKey,
				name: string,
				editions: types.hasManyOf(() => Edition, { to: 'publisherId' }),
			},
			{ database: DB }
		);
	});

	it('compiles to the same attribute shape as relation/hasMany', () => {
		const editionAttr = Edition.attributes.find((a) => a.name === 'publisher');
		assert.strictEqual(editionAttr.type, 'Publisher');
		assert.deepStrictEqual(editionAttr.relationship, { from: 'publisherId' });
		assert.strictEqual(editionAttr.definition.tableClass, Publisher);

		const publisherAttr = Publisher.attributes.find((a) => a.name === 'editions');
		assert.strictEqual(publisherAttr.type, 'array');
		assert.deepStrictEqual(publisherAttr.relationship, { to: 'publisherId' });
		assert.strictEqual(publisherAttr.elements.definition.tableClass, Edition);
	});

	it('resolves related records in both directions', async () => {
		await Publisher.put({ id: 'p1', name: 'O.C.' });
		await Edition.put({ id: 'e1', name: 'First', publisherId: 'p1' });

		const edition = await Edition.get('e1', {});
		const publisher = await edition.publisher;
		assert.strictEqual(publisher.name, 'O.C.');

		const publisherRec = await Publisher.get('p1', {});
		const editions = await publisherRec.editions;
		assert.strictEqual(editions.length, 1);
		assert.strictEqual(editions[0].name, 'First');
	});
});

describe('code-first ⇔ GraphQL front-end parity', () => {
	// The two authoring front-ends must project an identical canonical `properties` Record for an
	// equivalent schema — the guardrail against the front-ends silently diverging (RFC §4.2).
	// Nullability mapping: code-first plain field ≡ GraphQL `!`; `.nullable` ≡ GraphQL plain.
	const FIELDS = ['id', 'name', 'duration', 'status', 'createdAt'];

	before(async function () {
		setupTestDBPath();
		setMainIsWorker(true);
		defineTable('CodeParity', {
			id: id.primaryKey,
			name: string.indexed,
			duration: int.nullable,
			status: types.enum(['draft', 'published']),
			createdAt: date.createdTime,
		}); // default 'data' database
		await loadGQLSchema(`
			type GqlParity @table {
				id: ID @primaryKey
				name: String! @indexed
				duration: Int
				status: String!
				createdAt: Date @createdTime
			}
		`);
	});

	it('projects the same properties fragment per field from both front-ends', () => {
		const code = databases.data.CodeParity.properties;
		const gql = databases.data.GqlParity.properties;
		for (const field of FIELDS) {
			assert.deepStrictEqual(
				code[field],
				gql[field],
				`field "${field}" projects identically from code-first and GraphQL`
			);
		}
	});
});

describe('types.date — every modifier keeps the Date builder surface', () => {
	const DATE_FLAGS = ['nullable', 'indexed', 'primaryKey', 'createdTime', 'updatedTime'];

	before(function () {
		setupTestDBPath();
		setMainIsWorker(true);
	});

	it('accumulates flags in any chain order, timestamps included', () => {
		const cases = [
			[date.indexed.createdTime, { indexed: true, assignCreatedTime: true }],
			[date.createdTime.indexed, { indexed: true, assignCreatedTime: true }],
			[date.nullable.updatedTime, { nullable: true, assignUpdatedTime: true }],
			[date.updatedTime.nullable, { nullable: true, assignUpdatedTime: true }],
			[date.primaryKey.createdTime, { primaryKey: true, assignCreatedTime: true }],
			[date.createdTime.updatedTime, { assignCreatedTime: true, assignUpdatedTime: true }],
			[date.updatedTime.createdTime, { assignCreatedTime: true, assignUpdatedTime: true }],
			[date.indexed.indexed.updatedTime, { indexed: true, assignUpdatedTime: true }],
			[
				date.createdTime.indexed.nullable.updatedTime,
				{ indexed: true, nullable: true, assignCreatedTime: true, assignUpdatedTime: true },
			],
		];
		for (const [field, meta] of cases) {
			assert.strictEqual(field.kind, 'Date');
			assert.deepStrictEqual(field.meta, meta);
			for (const flag of DATE_FLAGS) assert.ok(field[flag], `${JSON.stringify(meta)} still offers .${flag}`);
		}
	});

	it('derives fresh fields, leaving the source of a chain unchanged', () => {
		const indexed = date.indexed;
		const created = indexed.createdTime;
		const updated = indexed.updatedTime;
		assert.deepStrictEqual(date.meta, {});
		assert.deepStrictEqual(indexed.meta, { indexed: true });
		assert.deepStrictEqual(created.meta, { indexed: true, assignCreatedTime: true });
		assert.deepStrictEqual(updated.meta, { indexed: true, assignUpdatedTime: true });
	});

	it('offers the timestamp flags only on Date fields', () => {
		for (const field of [string, id.indexed, int.nullable, types.enum(['a', 'b']).indexed, types.any]) {
			assert.strictEqual(field.createdTime, undefined);
			assert.strictEqual(field.updatedTime, undefined);
		}
	});

	it('assigns and indexes timestamps declared after other modifiers', async () => {
		const Stamped = defineTable(
			'StampedChain',
			{
				id: id.primaryKey,
				label: string,
				createdAt: date.nullable.indexed.createdTime,
				updatedAt: date.indexed.updatedTime,
			},
			{ database: DB }
		);
		const byName = Object.fromEntries(Stamped.attributes.map((a) => [a.name, a]));
		assert.strictEqual(byName.createdAt.assignCreatedTime, true);
		assert.strictEqual(byName.createdAt.indexed, true);
		assert.strictEqual(byName.updatedAt.assignUpdatedTime, true);
		assert.strictEqual(byName.updatedAt.indexed, true);
		await Stamped.put({ id: 's1', label: 'first' });
		const stored = await Stamped.get('s1');
		assert.ok(stored.createdAt instanceof Date);
		assert.ok(stored.updatedAt instanceof Date);
		const found = [];
		for await (const record of Stamped.search({
			conditions: [{ attribute: 'updatedAt', comparator: 'greater_than_equal', value: stored.updatedAt }],
		}))
			found.push(record.id);
		assert.deepStrictEqual(found, ['s1']);
	});
});

describe('schema re-declaration retires the previous declaration’s accessors', () => {
	const EVOLVE_DB = 'codefirst_evolution';

	before(function () {
		setupTestDBPath();
		setMainIsWorker(true);
	});

	it('rejects new own fields on sealed tracked updates without rejecting untouched legacy data', async () => {
		const options = { database: EVOLVE_DB, sealed: true };
		const shape = { id: id.primaryKey, label: string, when: date.nullable };
		const Item = defineTable('SealedRetirement', { ...shape, legacyCode: int.nullable }, options);
		await Item.put({ id: 'i1', label: 'original', legacyCode: 42 });
		defineTable('SealedRetirement', shape, options);

		await transaction(async () => {
			const record = await Item.update('i1');
			record.label = 'permitted';
		});
		assert.strictEqual((await Item.get('i1')).legacyCode, 42);

		for (const name of ['legacyCode', 'neverDeclared']) {
			for (const changeDeclared of [false, true]) {
				await assert.rejects(
					async () =>
						transaction(async () => {
							const record = await Item.update('i1');
							if (changeDeclared) record.label = 'rejected';
							record[name] = 'new own value';
						}),
					(error) => error.name === 'ValidationError' && error.message.includes(`Property ${name} is not allowed`)
				);
				const stored = await Item.get('i1');
				assert.strictEqual(stored.label, 'permitted');
				assert.strictEqual(stored.legacyCode, 42);
				assert.strictEqual(stored.neverDeclared, undefined);
			}
		}
		await Item.patch('i1', { label: 'plain patch' });
		assert.strictEqual((await Item.get('i1')).legacyCode, 42);
		await assert.rejects(
			async () => Item.patch('i1', { neverDeclared: 'no' }),
			/Property neverDeclared is not allowed/
		);
		await transaction(async () => {
			const record = await Item.update('i1');
			record.label = 'coerced own field';
			Object.defineProperty(record, 'when', {
				value: '2026-01-01T00:00:00.000Z',
				enumerable: true,
				writable: true,
			});
		});
		assert.strictEqual((await Item.get('i1')).when.toISOString(), '2026-01-01T00:00:00.000Z');
	});

	it('keeps retired own fields writable on unsealed tracked updates', async () => {
		const options = { database: EVOLVE_DB, sealed: false };
		const shape = { id: id.primaryKey, label: string };
		const Item = defineTable('UnsealedRetirement', { ...shape, legacyCode: int.nullable }, options);
		await Item.put({ id: 'i1', label: 'original', legacyCode: 42 });
		defineTable('UnsealedRetirement', shape, options);
		await transaction(async () => {
			const record = await Item.update('i1');
			record.label = 'changed';
			record.legacyCode = 'now untyped';
		});
		assert.strictEqual((await Item.get('i1')).legacyCode, 'now untyped');
	});

	it('keeps live timestamps and resolvers after a raw expression reload fails', async () => {
		const Writer = defineTable('FailureWriter', { id: id.primaryKey, name: string }, { database: EVOLVE_DB });
		const Item = defineTable(
			'FailedReload',
			{
				id: id.primaryKey,
				label: string,
				writerId: id.indexed,
				writer: types.relation(() => Writer, { from: 'writerId' }),
				createdAt: date.createdTime,
				touchedAt: date.updatedTime,
			},
			{ database: EVOLVE_DB }
		);
		await Writer.put({ id: 'w1', name: 'Ursula' });
		await Item.put({ id: 'before', label: 'before', writerId: 'w1' });
		const resolverMap = Item.propertyResolvers;
		const recordPrototype = Item.primaryStore.encoder.structPrototype;
		const writerGetter = Object.getOwnPropertyDescriptor(recordPrototype, 'writer').get;
		const originalAttributes = Item.attributes.map((attribute) => ({ ...attribute }));
		assert.throws(
			() =>
				table({
					database: EVOLVE_DB,
					table: 'FailedReload',
					attributes: [
						originalAttributes[0],
						{ name: 'newComputed', computed: {}, computedFromExpression: 'label.toUpperCase()' },
						{ name: 'broken', computed: {}, computedFromExpression: 'label +' },
						...originalAttributes.slice(1),
					],
				}),
			SyntaxError
		);
		await Item.put({ id: 'after', label: 'after', writerId: 'w1' });
		const stored = await Item.get('after');
		assert.ok(stored.createdAt instanceof Date, 'failed reload preserves created-time stamping');
		assert.ok(stored.touchedAt instanceof Date, 'failed reload preserves updated-time stamping');
		assert.strictEqual((await stored.writer).name, 'Ursula');
		assert.strictEqual(Item.propertyResolvers, resolverMap);
		assert.strictEqual(Object.getOwnPropertyDescriptor(recordPrototype, 'writer').get, writerGetter);
		assert.strictEqual(Object.getOwnPropertyDescriptor(recordPrototype, 'newComputed'), undefined);
		assert.strictEqual(Object.getOwnPropertyDescriptor(Item.prototype, 'newComputed'), undefined);
		assert.strictEqual(Item.userResolvers.newComputed, undefined);
		const selected = [];
		for await (const record of Item.search(new RequestTarget('?id=after&select(label,writer)'))) selected.push(record);
		assert.strictEqual(selected[0].writer.name, 'Ursula');
		table({ database: EVOLVE_DB, table: 'FailedReload', attributes: originalAttributes });
		await Item.put({ id: 'recovered', label: 'recovered', writerId: 'w1' });
		assert.ok((await Item.get('recovered')).createdAt instanceof Date);
	});

	it('a GraphQL reload turning a relationship into a stored field keeps the stored value (typed structs)', async () => {
		await loadGQLSchema(`
			type RetireBook @table {
				id: ID @primaryKey
				title: String
				authorId: ID @indexed
			}
			type RetireAuthor @table(randomAccessFields: true) {
				id: ID @primaryKey
				name: String
				books: [RetireBook] @relationship(to: authorId)
			}
		`);
		const { RetireBook, RetireAuthor } = databases.data;
		assert.ok(RetireAuthor.primaryStore.encoder.randomAccessStructure);
		await RetireBook.put({ id: 'b1', title: 'Earthsea', authorId: 'a1' });
		await RetireAuthor.put({ id: 'a1', name: 'Ursula' });
		await RetireAuthor.put({ id: 'a2', name: 'Tove' });
		assert.deepStrictEqual(
			Array.from(await (await RetireAuthor.get('a1')).books, (book) => book.title),
			['Earthsea']
		);

		await loadGQLSchema(`
			type RetireAuthor @table(randomAccessFields: true) {
				id: ID @primaryKey
				name: String
				books: [String]
			}
		`);
		assert.strictEqual((await RetireAuthor.get('a2')).books, undefined);
		await RetireAuthor.put({ id: 'a1', name: 'Ursula', books: ['Earthsea', 'Tehanu'] });
		assert.deepStrictEqual((await RetireAuthor.get('a1')).books, ['Earthsea', 'Tehanu']);
		assert.deepStrictEqual(RetireAuthor.primaryStore.getSync('a1').books, ['Earthsea', 'Tehanu']);
		assert.strictEqual(RetireAuthor.primaryStore.encoder.resolvedAttributeNames, undefined);
		assert.strictEqual(
			Object.getOwnPropertyDescriptor(RetireAuthor.primaryStore.encoder.structPrototype, 'books'),
			undefined
		);
	});

	it('a GraphQL reload turning a @computed into a stored field reads the stored value', async () => {
		await loadGQLSchema(`
			type RetireComputed @table {
				id: ID @primaryKey
				first: String
				last: String
				fullName: String @computed(from: "first + ' ' + last")
			}
		`);
		const { RetireComputed } = databases.data;
		await RetireComputed.put({ id: 'p1', first: 'Ursula', last: 'Le Guin' });
		assert.strictEqual((await RetireComputed.get('p1')).fullName, 'Ursula Le Guin');

		await loadGQLSchema(`
			type RetireComputed @table {
				id: ID @primaryKey
				first: String
				last: String
				fullName: String
			}
		`);
		await RetireComputed.put({ id: 'p1', first: 'Ursula', last: 'Le Guin', fullName: 'U. K. Le Guin' });
		assert.strictEqual((await RetireComputed.get('p1')).fullName, 'U. K. Le Guin');
		assert.strictEqual(
			Object.getOwnPropertyDescriptor(RetireComputed.primaryStore.encoder.structPrototype, 'fullName'),
			undefined
		);
	});

	it('keeps a retained relationship resolving when a sibling is removed, and restores a re-added one', async () => {
		const Writer = defineTable('Writer', { id: id.primaryKey, name: string }, { database: EVOLVE_DB });
		const Press = defineTable('Press', { id: id.primaryKey, name: string }, { database: EVOLVE_DB });
		const novelShape = {
			id: id.primaryKey,
			title: string,
			writerId: id.indexed.nullable,
			alternateWriterId: id.indexed.nullable,
			pressId: id.indexed.nullable,
			writer: types.relation(() => Writer, { from: 'writerId' }),
		};
		const withPress = { ...novelShape, press: types.relation(() => Press, { from: 'pressId' }) };
		const Novel = defineTable('Novel', withPress, { database: EVOLVE_DB });
		await Writer.put({ id: 'w1', name: 'Ursula' });
		await Writer.put({ id: 'w2', name: 'Tove' });
		await Press.put({ id: 'p1', name: 'Parnassus' });
		await Novel.put({ id: 'n1', title: 'Earthsea', writerId: 'w1', alternateWriterId: 'w2', pressId: 'p1' });
		assert.strictEqual((await (await Novel.get('n1')).press).name, 'Parnassus');

		defineTable('Novel', novelShape, { database: EVOLVE_DB });
		const withoutPress = await Novel.get('n1');
		assert.strictEqual((await withoutPress.writer).name, 'Ursula');
		assert.strictEqual(withoutPress.press, undefined);
		assert.strictEqual(Object.getOwnPropertyDescriptor(Novel.prototype, 'press'), undefined);
		assert.ok(Object.getOwnPropertyDescriptor(Novel.prototype, 'writer')?.get?.isAttribute);
		defineTable(
			'Novel',
			{ ...novelShape, writer: types.relation(() => Writer, { from: 'alternateWriterId' }) },
			{ database: EVOLVE_DB }
		);
		assert.strictEqual((await (await Novel.get('n1')).writer).name, 'Tove');

		defineTable('Novel', withPress, { database: EVOLVE_DB });
		const readded = await Novel.get('n1');
		assert.strictEqual((await readded.writer).name, 'Ursula');
		assert.strictEqual((await readded.press).name, 'Parnassus');
	});

	it('stamps a timestamp field added on re-declaration and stops stamping a removed one', async () => {
		const Log = defineTable(
			'StampEvolve',
			{ id: id.primaryKey, label: string, touchedAt: date.updatedTime },
			{ database: EVOLVE_DB }
		);
		await Log.put({ id: 'l1', label: 'first' });
		assert.ok((await Log.get('l1')).touchedAt instanceof Date);

		defineTable(
			'StampEvolve',
			{ id: id.primaryKey, label: string, createdAt: date.indexed.createdTime },
			{ database: EVOLVE_DB }
		);
		await Log.put({ id: 'l2', label: 'second' });
		const second = await Log.get('l2');
		assert.ok(second.createdAt instanceof Date, 'the added createdTime field is stamped');
		assert.strictEqual(second.touchedAt, undefined, 'the removed updatedTime field is no longer written');
		assert.strictEqual(Log.createdTimeProperty?.name, 'createdAt');
		assert.strictEqual(Log.updatedTimeProperty, undefined);
	});

	it('still checks the target table’s read permission for a retained relationship', async () => {
		const Secret = defineTable('SecretNote', { id: id.primaryKey, text: string }, { database: EVOLVE_DB });
		const Open = defineTable('OpenNote', { id: id.primaryKey, text: string }, { database: EVOLVE_DB });
		const docShape = {
			id: id.primaryKey,
			name: string,
			secretId: id.indexed.nullable,
			openId: id.indexed.nullable,
			secret: types.relation(() => Secret, { from: 'secretId' }),
		};
		const Doc = defineTable(
			'GatedDoc',
			{ ...docShape, open: types.relation(() => Open, { from: 'openId' }) },
			{ database: EVOLVE_DB }
		);
		await Secret.put({ id: 's1', text: 'classified' });
		await Open.put({ id: 'o1', text: 'public' });
		await Doc.put({ id: 'd1', name: 'doc', secretId: 's1', openId: 'o1' });
		const user = {
			role: {
				permission: {
					[EVOLVE_DB]: {
						tables: {
							GatedDoc: { read: true, insert: false, update: false, delete: false, attribute_permissions: [] },
							SecretNote: { read: false, insert: false, update: false, delete: false, attribute_permissions: [] },
							OpenNote: { read: true, insert: false, update: false, delete: false, attribute_permissions: [] },
						},
					},
				},
			},
		};
		const searchAs = async (query) => {
			const target = new RequestTarget(query);
			target.checkPermission = true;
			const results = [];
			for await (const result of Doc.search(target, { user })) results.push(result);
			return results;
		};
		const [before] = await searchAs('?id=d1&select(name,secret,open)');
		assert.strictEqual(before.name, 'doc');
		assert.strictEqual(before.secret, undefined, 'no read permission on SecretNote');
		assert.strictEqual(before.open.text, 'public');

		defineTable('GatedDoc', docShape, { database: EVOLVE_DB });
		const [after] = await searchAs('?id=d1&select(name,secret)');
		assert.strictEqual(after.name, 'doc');
		assert.strictEqual(after.secret, undefined, 'still no read permission on SecretNote');
	});
});
