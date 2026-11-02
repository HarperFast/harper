// Table-level expiration and eviction live on the table's primary catalog row (harper-pro#1179): a
// re-declaration persists them whether or not it names a primary key, a peer's definition sets them only on
// a table it creates, and a reload brings a class that did not declare them up to date with the catalog.
require('../testUtils');
const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const {
	catalogExpiration,
	databases,
	getDatabases,
	onUpdatedTable,
	resetDatabases,
	table,
} = require('#src/resources/databases');

const DATABASE = 'test';

async function commitCatalog(Table) {
	if (Table.dbisDB.committed) await Table.dbisDB.committed;
}

function primaryRow(Table) {
	const named = Table.primaryKey && Table.dbisDB.getSync(`${Table.tableName}/${Table.primaryKey}`);
	if (named?.isPrimaryKey) return { key: `${Table.tableName}/${Table.primaryKey}`, value: named };
	return { key: `${Table.tableName}/`, value: Table.dbisDB.getSync(`${Table.tableName}/`) };
}

// what another thread's declaration leaves behind: a catalog row this thread's class has not loaded
async function writeCatalogSettings(Table, settings) {
	const { key, value } = primaryRow(Table);
	Table.dbisDB.putSync(key, { ...value, ...settings });
	await commitCatalog(Table);
}

function keyless(tableName, options) {
	return table({
		table: tableName,
		database: DATABASE,
		schemaDefined: true,
		attributes: [{ name: 'cacheControl', type: 'String' }],
		...options,
	});
}

function keyed(tableName, options) {
	return table({
		table: tableName,
		database: DATABASE,
		schemaDefined: true,
		attributes: [
			{ name: 'id', type: 'ID', isPrimaryKey: true },
			{ name: 'cacheControl', type: 'String' },
		],
		...options,
	});
}

describe('table-level expiration persistence (harper-pro#1179)', () => {
	before(function () {
		setupTestDBPath();
	});

	it('persists settings when a keyless table is re-declared, and loads them on the next start', async function () {
		const tableName = 'ExpiryKeylessRedeclared';
		const Created = keyless(tableName);
		assert.strictEqual(Created.primaryKey, undefined);
		assert.deepStrictEqual(catalogExpiration(Created), {});

		keyless(tableName, { expiration: 600, eviction: 300, audit: false });
		await commitCatalog(Created);
		const { value } = primaryRow(Created);
		assert.strictEqual(value.expiration, 600);
		assert.strictEqual(value.eviction, 300);
		assert.strictEqual(value.audit, false);
		assert.deepStrictEqual(catalogExpiration(Created), { expiration: 600, eviction: 300 });

		delete databases[DATABASE][tableName];
		resetDatabases();
		const Restarted = getDatabases()[DATABASE][tableName];
		assert.strictEqual(Restarted.expirationMS, 600000);
		assert.strictEqual(Restarted.evictionMS, 300000);
	});

	it('reports what a keyed re-declaration persisted', async function () {
		const tableName = 'ExpiryKeyedRedeclared';
		const Created = keyed(tableName);
		keyed(tableName, { expiration: 900, eviction: 60 });
		await commitCatalog(Created);
		assert.deepStrictEqual(catalogExpiration(Created), { expiration: 900, eviction: 60 });
	});

	it('leaves the catalog untouched when a re-declaration omits a persisted setting', async function () {
		const tableName = 'ExpiryOmittedOnRedeclare';
		const Declared = keyless(tableName, { expiration: 600 });
		await commitCatalog(Declared);
		const updates = [];
		const listener = onUpdatedTable((updated) => {
			if (updated.tableName === tableName) updates.push(updated);
		});
		try {
			keyless(tableName);
		} finally {
			listener.remove();
		}
		assert.deepStrictEqual(updates, [], 'an unchanged row must not be rewritten and announced');
		assert.deepStrictEqual(catalogExpiration(Declared), { expiration: 600 });
	});

	it('reads the named primary row, as declareTable and initStores do', async function () {
		const tableName = 'ExpiryNamedPrimaryRow';
		const Legacy = keyed(tableName);
		const { value } = primaryRow(Legacy);
		Legacy.dbisDB.putSync(`${tableName}/id`, { ...value, name: 'id', isPrimaryKey: true, expiration: 77 });
		await commitCatalog(Legacy);
		assert.deepStrictEqual(catalogExpiration(Legacy), { expiration: 77 });
	});

	it('brings a loaded class that did not declare the table up to date with the catalog on reload', async function () {
		const tableName = 'ExpiryAdoptedOnReload';
		const Loaded = keyed(tableName);
		assert.strictEqual(Loaded.expirationMS, undefined);
		await writeCatalogSettings(Loaded, { expiration: 120, eviction: 60 });

		resetDatabases();
		assert.strictEqual(getDatabases()[DATABASE][tableName], Loaded, 'the reload must keep the loaded class');
		assert.strictEqual(Loaded.expirationMS, 120000);
		assert.strictEqual(Loaded.evictionMS, 60000);

		resetDatabases();
		assert.strictEqual(Loaded.expirationMS, 120000, 'an unchanged catalog changes nothing');
		assert.strictEqual(Loaded.evictionMS, 60000);
	});

	it('adopts an eviction-only catalog row as expiration 0, as a fresh load does', async function () {
		const tableName = 'ExpiryEvictionOnly';
		const Loaded = keyless(tableName);
		await writeCatalogSettings(Loaded, { eviction: 90 });

		resetDatabases();
		assert.strictEqual(Loaded.expirationMS, 0);
		assert.strictEqual(Loaded.evictionMS, 90000);

		delete databases[DATABASE][tableName];
		resetDatabases();
		const Restarted = getDatabases()[DATABASE][tableName];
		assert.strictEqual(Restarted.expirationMS, 0);
		assert.strictEqual(Restarted.evictionMS, 90000);
	});

	it("keeps a TTL this thread's own declaration set, even when it repeats the loaded value", async function () {
		const tableName = 'ExpiryDeclaredHere';
		const Declared = keyed(tableName, { expiration: 600 });
		keyed(tableName, { expiration: 600 });
		await writeCatalogSettings(Declared, { expiration: 900 });

		resetDatabases();
		assert.strictEqual(Declared.expirationMS, 600000);
	});

	it('does not let a rejected declaration claim the TTL', async function () {
		const tableName = 'ExpiryRejectedDeclaration';
		const Loaded = keyed(tableName);
		assert.throws(() => keyed(tableName, { expiration: -5 }), /negative/);
		await commitCatalog(Loaded);
		assert.strictEqual(primaryRow(Loaded).value.expiration, undefined, 'the rejected value must not reach the catalog');
		assert.strictEqual(Loaded.expirationMS, undefined);
		await writeCatalogSettings(Loaded, { expiration: 120 });

		resetDatabases();
		assert.strictEqual(Loaded.expirationMS, 120000);
	});

	it('rejects a negative value before a keyless re-declaration changes anything', async function () {
		const tableName = 'ExpiryRejectedKeyless';
		const Loaded = keyless(tableName);
		assert.throws(
			() =>
				keyless(tableName, {
					expiration: -5,
					attributes: [
						{ name: 'cacheControl', type: 'String' },
						{ name: 'tag', type: 'String', indexed: true },
					],
				}),
			/negative/
		);
		await commitCatalog(Loaded);
		assert.strictEqual(Loaded.dbisDB.getSync(`${tableName}/tag`), undefined, 'no attribute row or index build');
		assert(!Loaded.attributes.some((attribute) => attribute.name === 'tag'));
		assert.deepStrictEqual(catalogExpiration(Loaded), {});
	});

	it('keeps a TTL application code set on this thread', async function () {
		const tableName = 'ExpiryConfiguredByApplication';
		const Configured = keyed(tableName);
		Configured.setTTLExpiration(30);
		await writeCatalogSettings(Configured, { expiration: 900 });

		resetDatabases();
		assert.strictEqual(Configured.expirationMS, 30000);
	});

	it("applies a peer definition's settings to a table it creates, as a catalog load", async function () {
		const tableName = 'ExpiryPeerCreated';
		const Created = keyed(tableName, { origin: 'cluster', schemaDefined: undefined, expiration: 45, eviction: 15 });
		await commitCatalog(Created);
		assert.strictEqual(Created.expirationMS, 45000);
		assert.strictEqual(Created.evictionMS, 15000);
		assert.deepStrictEqual(catalogExpiration(Created), { expiration: 45, eviction: 15 });

		// the peer's values are not this thread's declaration, so a later local one persisted elsewhere wins
		await writeCatalogSettings(Created, { expiration: 3600 });
		resetDatabases();
		assert.strictEqual(Created.expirationMS, 3600000);
	});

	it("leaves an existing table's settings alone when a peer definition differs", async function () {
		const tableName = 'ExpiryPeerExisting';
		const Local = keyed(tableName, { expiration: 600 });
		keyed(tableName, {
			origin: 'cluster',
			schemaDefined: undefined,
			expiration: 30,
			eviction: 30,
			attributes: [
				{ name: 'id', type: 'ID', isPrimaryKey: true },
				{ name: 'cacheControl', type: 'String' },
				{ name: 'fromPeer', type: 'String' },
			],
		});
		await commitCatalog(Local);
		assert(
			Local.attributes.some((attribute) => attribute.name === 'fromPeer'),
			'the peer definition must reach the table'
		);
		assert.strictEqual(Local.expirationMS, 600000);
		assert.strictEqual(Local.evictionMS, 0);
		assert.deepStrictEqual(catalogExpiration(Local), { expiration: 600 });
	});
});
