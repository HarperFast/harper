// Test-only probes for harper#3225: they read and rewrite catalog rows through the table's own
// catalog store, which no public API exposes.

function tableFor(query) {
	return databases.data[query.get('table')];
}

// GET /StripPrimaryFlag/?table=X rewrites X's bare `<table>/` row without isPrimaryKey, the
// shape of the catalog row whose store a 5.3.2 startup opened as an index store
export class StripPrimaryFlag extends Resource {
	static loadAsInstance = false;
	get(target) {
		const table = tableFor(target);
		const key = `${table.tableName}/`;
		const row = { ...table.dbisDB.getSync(key) };
		delete row.isPrimaryKey;
		delete row.is_hash_attribute;
		table.dbisDB.putSync(key, row);
		return table.dbisDB.getSync(key);
	}
}

// GET /CatalogRow/?table=X&attribute=Y returns the persisted descriptor for X/Y (Y empty: the bare row)
export class CatalogRow extends Resource {
	static loadAsInstance = false;
	get(target) {
		const table = tableFor(target);
		return table.dbisDB.getSync(`${table.tableName}/${target.get('attribute') ?? ''}`) ?? null;
	}
}

// GET /TableState/?table=X reports what the live class believes about its primary key
export class TableState extends Resource {
	static loadAsInstance = false;
	get(target) {
		const table = tableFor(target);
		return {
			primaryKey: table.primaryKey ?? null,
			primaryAttributes: table.attributes.filter((attribute) => attribute.isPrimaryKey).map(({ name }) => name),
			attributes: table.attributes.map(({ name }) => name),
			newIdType: typeof table.getNewId(),
		};
	}
}
