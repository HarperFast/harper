/**
 * RFC 0001 — Spike (c): register a table from a `defineTable` value (no GraphQL).
 *
 * GOAL: de-risk the migration/DDL-parity question. Prove that a code-first schema
 * value compiles into the SAME options the existing `table()` factory consumes
 * (resources/databases.ts) — the factory GraphQL itself drives, and that
 * dataLayer/.../dataLoader.ts already uses for non-GraphQL tables — yielding a
 * fully working table: registered in the `databases` registry, with the right
 * attribute metadata, and supporting CRUD.
 *
 * This reuses the value shape produced by the spike (b) `t` builder (objects with
 * `kind` + `meta`). The compiler below is the whole bridge: defineTable value ->
 * `{ table, database, attributes }`.
 *
 * Run (uses the repo's .mocharc.json -> mocha.init.js bootstrap + node options):
 *   npx mocha docs/rfcs/spikes/0001/defineTable-registration.spike.test.js
 */

require('../../../../unitTests/testUtils');
const assert = require('assert');
const { setupTestDBPath } = require('../../../../unitTests/testUtils');
const { table, databases } = require('#src/resources/databases');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');

// ─────────────────────────────────────────────────────────────────────────────
// Minimal runtime `t` builder + defineTable (the value shape from spike (b)).
// Kept tiny and dependency-free; the typed twin lives in t-builder.spike.ts.
// ─────────────────────────────────────────────────────────────────────────────

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
};

function defineTable(name, shape) {
	return { name, shape };
}

/**
 * The bridge: a defineTable value -> the `table()` factory's TableDefinition.
 * Maps each builder field's `kind`/`meta` onto a Harper attribute. This is the
 * exact shape graphql.ts produces from a `@table` type — so both front-ends
 * converge on `table()`/`makeTable()` and share all downstream DDL semantics.
 */
function compileToTableOptions(def, { database = 'data' } = {}) {
	const attributes = Object.entries(def.shape).map(([name, f]) => {
		const attr = { name, type: f.kind };
		if (f.meta.primaryKey) attr.isPrimaryKey = true;
		if (f.meta.indexed) attr.indexed = true;
		if (f.meta.nullable) attr.nullable = true;
		if (f.meta.assignCreatedTime) attr.assignCreatedTime = true;
		return attr;
	});
	return { table: def.name, database, attributes };
}

// ─────────────────────────────────────────────────────────────────────────────
// The spike
// ─────────────────────────────────────────────────────────────────────────────

const DB = 'codefirst_spike';

// A code-first schema, authored as a value (mirrors the RFC's running example).
const Tracks = defineTable('Tracks', {
	id: t.id().primaryKey(),
	name: t.string().indexed(),
	duration: t.int().nullable(),
	status: t.enum(['draft', 'published']),
	createdAt: t.createdTime(),
});

describe('RFC 0001 spike (c): defineTable -> table() registration', () => {
	let TracksTable;

	before(function () {
		setupTestDBPath();
		setMainIsWorker(true);
		// The whole point: a value goes in, a registered Harper table comes out.
		TracksTable = table(compileToTableOptions(Tracks, { database: DB }));
	});

	it('registers the table in the databases registry', () => {
		assert.ok(databases[DB], `database "${DB}" should exist`);
		assert.strictEqual(databases[DB].Tracks, TracksTable, 'Tracks should be registered and identical');
	});

	it('carries the compiled schema as attribute metadata', () => {
		assert.strictEqual(TracksTable.primaryKey, 'id', 'primary key detected from the value');
		const byName = Object.fromEntries(TracksTable.attributes.map((a) => [a.name, a]));
		assert.deepStrictEqual(Object.keys(byName).sort(), ['createdAt', 'duration', 'id', 'name', 'status']);
		assert.strictEqual(byName.id.isPrimaryKey, true);
		assert.strictEqual(byName.name.indexed, true);
		assert.strictEqual(byName.status.type, 'String', 'enum compiles to a String column');
		assert.strictEqual(byName.createdAt.assignCreatedTime, true, 'server-managed timestamp flag preserved');
	});

	it('supports CRUD, with the server-managed timestamp auto-assigned', async () => {
		await TracksTable.put({ id: 'intro', name: 'Intro', status: 'draft' });

		const got = await TracksTable.get('intro');
		assert.strictEqual(got.name, 'Intro');
		assert.strictEqual(got.status, 'draft');
		assert.ok(got.createdAt != null, 'createdAt should be auto-assigned by the table machinery');

		// update path
		await TracksTable.put({ id: 'intro', name: 'Intro (remastered)', status: 'published' });
		const updated = await TracksTable.get('intro');
		assert.strictEqual(updated.name, 'Intro (remastered)');
		assert.strictEqual(updated.status, 'published');

		// delete path (absent record reads back nullish — null or undefined depending on load mode)
		await TracksTable.delete('intro');
		assert.ok((await TracksTable.get('intro')) == null, 'record should be gone after delete');
	});

	it('applies a schema change (added attribute) on re-registration — DDL parity', () => {
		// Re-run the bridge with an added column, exactly as a schema edit would.
		const Tracks2 = defineTable('Tracks', {
			id: t.id().primaryKey(),
			name: t.string().indexed(),
			duration: t.int().nullable(),
			status: t.enum(['draft', 'published']),
			createdAt: t.createdTime(),
			isrc: t.string().indexed(), // newly added
		});
		const TracksTable2 = table(compileToTableOptions(Tracks2, { database: DB }));
		assert.strictEqual(TracksTable2, TracksTable, 'same table class is re-asserted, not duplicated');
		const names = TracksTable.attributes.map((a) => a.name);
		assert.ok(names.includes('isrc'), 'added attribute is present after re-registration');
	});
});
