// RFC 0001 — code-first schema: the canonical `defineTable` + `types` model
// (docs/rfcs/spikes/0001/canonical-track.spike.ts is the type-level proof; this is the runtime).
//
// `defineTable` eagerly registers through the same `table()` factory GraphQL drives
// (resources/databases.ts) and returns the live table class — the import IS the handle.
// Covered here: registry entry, attribute metadata, canonical properties projection, CRUD,
// schema evolution, relationships via lazy thunks (including a FORWARD reference), and the
// front-end parity guardrail (code-first and GraphQL project identical `properties`).

require('../testUtils');
const assert = require('assert');
const { setupTestDBPath } = require('../testUtils');
const { databases } = require('#src/resources/databases');
const { loadGQLSchema } = require('#src/resources/graphql');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { defineTable, types } = require('#src/resources/defineTable');

const { id, string, int, date } = types;
const DB = 'codefirst_test';

describe('RFC 0001: canonical defineTable — eager registration', () => {
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

describe('RFC 0001: canonical relationships — lazy thunks, forward reference', () => {
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

describe('RFC 0001: code-first ⇔ GraphQL front-end parity', () => {
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
