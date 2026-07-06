// RFC 0001 — code-first schema registration (promoted from docs/rfcs/spikes/0001).
//
// Proves that a code-first schema *value* compiles into the options the existing
// `table()` factory consumes (resources/databases.ts) — the same factory GraphQL
// drives and dataLoader.ts already uses — yielding a working table with no GraphQL:
// registry entry, attribute metadata, CRUD, schema evolution, and relationships.
//
// `t` / `defineTable` / `compileToTableOptions` below mirror the future public API
// (the typed twin lives in docs/rfcs/spikes/0001/t-builder.spike.ts). Keeping this
// in the suite guards that `table()` continues to accept the shape that API compiles to.

require('../testUtils');
const assert = require('assert');
const { setupTestDBPath } = require('../testUtils');
const { table, databases } = require('#src/resources/databases');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');

// ─── Minimal runtime builder (value shape from the t-builder spike) ──────────

function field(kind, meta = {}) {
	return {
		kind,
		meta,
		nullable() {
			return field(kind, { ...meta, nullable: true });
		},
		indexed() {
			return field(kind, { ...meta, indexed: true });
		},
		primaryKey() {
			return field(kind, { ...meta, primaryKey: true });
		},
	};
}

const t = {
	id: () => field('ID'),
	string: () => field('String'),
	int: () => field('Int'),
	boolean: () => field('Boolean'),
	date: () => field('Date'),
	enum: (values) => field('String', { enum: values }), // enum -> String column at runtime
	createdTime: () => field('Date', { assignCreatedTime: true }),
	relation: (target, opts) => field('relation', { target, ...opts }), // many-to-one (this table holds FK)
	hasMany: (target, opts) => field('relation', { target, ...opts }), // one-to-many (related table holds FK)
};

function defineTable(name, shape) {
	return { name, shape };
}

// The bridge: a defineTable value -> the `table()` factory's options. `registered`
// maps an already-registered defineTable value to its Table class so relationship
// attributes can carry `definition.tableClass` (required for resolution).
function compileToTableOptions(def, { database = 'data', registered } = {}) {
	const attributes = [];
	const declared = new Set(Object.keys(def.shape));
	const fkColumns = new Set();
	for (const [name, f] of Object.entries(def.shape)) {
		if (f.kind === 'relation') {
			const targetDef = f.meta.target();
			const targetClass = registered && registered.get(targetDef);
			const definition = targetClass ? { tableClass: targetClass } : {};
			if (f.meta.from) {
				// many-to-one: this table holds the foreign key
				attributes.push({ name, type: targetDef.name, relationship: { from: f.meta.from }, definition });
				if (!declared.has(f.meta.from)) fkColumns.add(f.meta.from);
			} else if (f.meta.to) {
				// one-to-many: the related table holds the foreign key
				attributes.push({ name, relationship: { to: f.meta.to }, elements: { type: targetDef.name, definition } });
			}
			continue;
		}
		const attr = { name, type: f.kind };
		if (f.meta.primaryKey) attr.isPrimaryKey = true;
		if (f.meta.indexed) attr.indexed = true;
		if (f.meta.nullable) attr.nullable = true;
		if (f.meta.assignCreatedTime) attr.assignCreatedTime = true;
		attributes.push(attr);
	}
	// auto-add foreign-key columns implied by many-to-one relations (indexed for join lookups)
	for (const fk of fkColumns) attributes.push({ name: fk, indexed: true });
	return { table: def.name, database, attributes };
}

const DB = 'codefirst_test';

describe('RFC 0001: code-first defineTable -> table() registration', () => {
	const Tracks = defineTable('Tracks', {
		id: t.id().primaryKey(),
		name: t.string().indexed(),
		duration: t.int().nullable(),
		status: t.enum(['draft', 'published']),
		createdAt: t.createdTime(),
	});
	let TracksTable;

	before(function () {
		setupTestDBPath();
		setMainIsWorker(true);
		TracksTable = table(compileToTableOptions(Tracks, { database: DB }));
	});

	it('registers the table in the databases registry', () => {
		assert.ok(databases[DB], `database "${DB}" should exist`);
		assert.strictEqual(databases[DB].Tracks, TracksTable);
	});

	it('carries the compiled schema as attribute metadata', () => {
		assert.strictEqual(TracksTable.primaryKey, 'id');
		const byName = Object.fromEntries(TracksTable.attributes.map((a) => [a.name, a]));
		assert.deepStrictEqual(Object.keys(byName).sort(), ['createdAt', 'duration', 'id', 'name', 'status']);
		assert.strictEqual(byName.id.isPrimaryKey, true);
		assert.strictEqual(byName.name.indexed, true);
		assert.strictEqual(byName.status.type, 'String', 'enum compiles to a String column');
		assert.strictEqual(byName.createdAt.assignCreatedTime, true);
	});

	it('supports CRUD, with the server-managed timestamp auto-assigned', async () => {
		await TracksTable.put({ id: 'intro', name: 'Intro', status: 'draft' });
		const got = await TracksTable.get('intro');
		assert.strictEqual(got.name, 'Intro');
		assert.strictEqual(got.status, 'draft');
		assert.ok(got.createdAt != null, 'createdAt auto-assigned');

		await TracksTable.put({ id: 'intro', name: 'Intro (remastered)', status: 'published' });
		assert.strictEqual((await TracksTable.get('intro')).name, 'Intro (remastered)');

		await TracksTable.delete('intro');
		assert.ok((await TracksTable.get('intro')) == null, 'record gone after delete');
	});

	it('applies a schema change (added attribute) on re-registration — DDL parity', () => {
		const Tracks2 = defineTable('Tracks', {
			id: t.id().primaryKey(),
			name: t.string().indexed(),
			duration: t.int().nullable(),
			status: t.enum(['draft', 'published']),
			createdAt: t.createdTime(),
			isrc: t.string().indexed(), // newly added
		});
		const TracksTable2 = table(compileToTableOptions(Tracks2, { database: DB }));
		assert.strictEqual(TracksTable2, TracksTable, 'same class re-asserted, not duplicated');
		assert.ok(
			TracksTable.attributes.map((a) => a.name).includes('isrc'),
			'added attribute present after re-registration'
		);
	});
});

describe('RFC 0001: code-first @relationship end-to-end', () => {
	const Authors = defineTable('Authors', {
		id: t.id().primaryKey(),
		name: t.string(),
	});
	const Books = defineTable('Books', {
		id: t.id().primaryKey(),
		title: t.string(),
		author: t.relation(() => Authors, { from: 'authorId' }), // many-to-one
	});

	const registered = new Map();
	let AuthorsTable, BooksTable;

	before(function () {
		setupTestDBPath();
		setMainIsWorker(true);
		// Register the target first so the relationship attribute can carry definition.tableClass.
		AuthorsTable = table(compileToTableOptions(Authors, { database: DB, registered }));
		registered.set(Authors, AuthorsTable);
		BooksTable = table(compileToTableOptions(Books, { database: DB, registered }));
		registered.set(Books, BooksTable);
	});

	it('compiles a relation into a relationship attribute + auto-added indexed FK column', () => {
		const byName = Object.fromEntries(BooksTable.attributes.map((a) => [a.name, a]));
		assert.ok(byName.author, 'relationship attribute present');
		assert.strictEqual(byName.author.type, 'Authors', 'relationship targets the related type');
		assert.deepStrictEqual(byName.author.relationship, { from: 'authorId' });
		assert.strictEqual(byName.author.definition.tableClass, AuthorsTable, 'definition links the related class');
		assert.ok(byName.authorId, 'foreign-key column auto-added');
		assert.strictEqual(byName.authorId.indexed, true, 'FK column indexed for join lookups');
	});

	it('resolves the related record through the relationship', async () => {
		await AuthorsTable.put({ id: 'a1', name: 'Ada' });
		await BooksTable.put({ id: 'b1', title: 'On Computation', authorId: 'a1' });

		const context = {};
		const book = await BooksTable.get('b1', context);
		assert.strictEqual(book.title, 'On Computation');
		assert.strictEqual(book.authorId, 'a1', 'foreign key round-trips');

		const author = await book.author; // relationship resolves to the Author record
		assert.ok(author, 'relationship resolved');
		assert.strictEqual(author.name, 'Ada');
	});
});
