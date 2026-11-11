// Table-level expiration and eviction on the primary catalog row (harper-pro#1179).
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
const { defineTable, types } = require('#src/resources/defineTable');
const { loadGQLSchema } = require('#src/resources/graphql');

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
		Legacy.dbisDB.putSync(`${tableName}/id`, { ...value, name: 'id', isPrimaryKey: true, expiration: 'Infinity' });
		await commitCatalog(Legacy);
		assert.deepStrictEqual(catalogExpiration(Legacy), {}, 'a non-finite value is not a TTL');
	});

	it('reports a numeric-string expiration that a create persisted as given', async function () {
		const tableName = 'ExpiryStringCreate';
		const Created = keyed(tableName, { expiration: '45' });
		await commitCatalog(Created);
		assert.deepStrictEqual(catalogExpiration(Created), { expiration: 45 });
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

	it("rejects a peer definition's invalid TTL on a table it creates, naming the field", function () {
		for (const [suffix, settings, field] of [
			['Eviction', { expiration: 60, eviction: -1 }, 'eviction'],
			['EvictionOnly', { eviction: -1 }, 'eviction'],
			['NonNumeric', { expiration: 'soon' }, 'expiration'],
		]) {
			const tableName = `ExpiryPeerInvalid${suffix}`;
			assert.throws(
				() => keyed(tableName, { origin: 'cluster', schemaDefined: undefined, ...settings }),
				new RegExp(`^Error: ${field} of '${DATABASE}.${tableName}' must be a non-negative number`),
				suffix
			);
			assert.strictEqual(databases[DATABASE][tableName], undefined, suffix);
		}
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
	it('clears a saved expiration and eviction that a re-declaration sets to 0, null or "0" (#3934)', async function () {
		for (const [suffix, cleared] of [
			['Zero', { expiration: 0, eviction: 0 }],
			['Null', { expiration: null, eviction: null }],
			['String', { expiration: '0', eviction: '0' }],
		]) {
			const tableName = `ExpiryCleared${suffix}`;
			const Declared = keyed(tableName, { expiration: 600, eviction: 300 });
			keyed(tableName, cleared);
			await commitCatalog(Declared);
			const { value } = primaryRow(Declared);
			assert(!('expiration' in value) && !('eviction' in value), `${suffix}: ${JSON.stringify(value)}`);
			assert.deepStrictEqual(catalogExpiration(Declared), {}, suffix);
			assert(!Declared.expirationMS, `${suffix}: this thread still applies ${Declared.expirationMS}ms`);
			assert.strictEqual(Declared.evictionMS, 0, suffix);

			delete databases[DATABASE][tableName];
			resetDatabases();
			const Restarted = getDatabases()[DATABASE][tableName];
			assert(!Restarted.expirationMS, `${suffix}: a restart loads ${Restarted.expirationMS}ms`);
			assert.strictEqual(Restarted.evictionMS, 0, suffix);
		}
	});

	it('clears only the setting a re-declaration sets to 0', async function () {
		const tableName = 'ExpiryClearedEvictionOnly';
		const Declared = keyed(tableName, { expiration: 600, eviction: 300 });
		keyed(tableName, { expiration: 600, eviction: 0 });
		await commitCatalog(Declared);
		assert.deepStrictEqual(catalogExpiration(Declared), { expiration: 600 });
		assert.strictEqual(Declared.evictionMS, 0);
	});

	it('drops a TTL this thread loaded from the catalog when its re-declaration clears it', async function () {
		const tableName = 'ExpiryLoadedThenCleared';
		const Loaded = keyed(tableName);
		await writeCatalogSettings(Loaded, { expiration: 120, eviction: 60 });
		resetDatabases();
		assert.strictEqual(Loaded.expirationMS, 120000);

		keyed(tableName, { expiration: 0 });
		await commitCatalog(Loaded);
		assert(!Loaded.expirationMS, `this thread still applies ${Loaded.expirationMS}ms`);
		assert.deepStrictEqual(catalogExpiration(Loaded), { eviction: 60 }, 'an omitted eviction stays saved');
		assert.strictEqual(Loaded.evictionMS, 60000, 'and stays applied');
	});

	it('keeps the saved value of the setting a re-declaration omits, on disk and in memory', async function () {
		const tableName = 'ExpiryPartialUpdate';
		const Declared = keyed(tableName, { expiration: 60, eviction: 3600 });
		keyed(tableName, { expiration: 120 });
		await commitCatalog(Declared);
		assert.deepStrictEqual(catalogExpiration(Declared), { expiration: 120, eviction: 3600 });
		assert.strictEqual(Declared.expirationMS, 120000);
		assert.strictEqual(Declared.evictionMS, 3600000);
	});

	it('keeps the omitted setting as the row it writes holds it, not as an earlier read saw it', async function () {
		const tableName = 'ExpiryInheritedUnderLock';
		const Declared = keyed(tableName, { expiration: 60, eviction: 300 });
		await commitCatalog(Declared);
		const { key } = primaryRow(Declared);
		const catalog = Declared.dbisDB;
		const originalGetSync = catalog.getSync;
		let raced = false;
		catalog.getSync = function (readKey, ...rest) {
			const value = originalGetSync.call(this, readKey, ...rest);
			if (readKey === key && !raced) {
				raced = true;
				// another thread saves a new eviction right after this declaration's first read of the row
				catalog.putSync(key, { ...value, eviction: 3600 });
			}
			return value;
		};
		try {
			keyed(tableName, { expiration: 120 });
		} finally {
			catalog.getSync = originalGetSync;
		}
		await commitCatalog(Declared);
		assert.deepStrictEqual(catalogExpiration(Declared), { expiration: 120, eviction: 3600 });
		assert.strictEqual(Declared.evictionMS, 3600000);
	});

	it('does not clear a TTL application code configured when the schema declares none', async function () {
		const tableName = 'ExpiryApplicationKept';
		const Configured = keyed(tableName);
		Configured.setTTLExpiration({ expiration: 30, eviction: 10 });
		keyed(tableName, { expiration: null, eviction: null });
		assert.strictEqual(Configured.expirationMS, 30000);
		assert.strictEqual(Configured.evictionMS, 10000);
	});

	it('keeps a TTL application code set through a re-declaration with none, isolated or not (QA-5424)', async function () {
		for (const isolatedApplicationOwner of [true, false]) {
			const tableName = `ExpiryApplicationRedeclared${isolatedApplicationOwner ? 'Isolated' : 'Shared'}`;
			const Configured = keyed(tableName, { expiration: null, eviction: null, isolatedApplicationOwner });
			Configured.setTTLExpiration({ expiration: 30, eviction: 10 });
			keyed(tableName, { expiration: null, eviction: null, isolatedApplicationOwner });
			assert.strictEqual(Configured.expirationMS, 30000, `isolatedApplicationOwner: ${isolatedApplicationOwner}`);
			assert.strictEqual(Configured.evictionMS, 10000, `isolatedApplicationOwner: ${isolatedApplicationOwner}`);
			await commitCatalog(Configured);
			assert.deepStrictEqual(catalogExpiration(Configured), {}, 'an application TTL is never saved');
		}
	});

	it('keeps only the expiration a number-form call set over a schema TTL the schema then drops', async function () {
		const tableName = 'ExpiryNumberFormOverSchema';
		const Declared = keyed(tableName, { expiration: 60, eviction: 3600, scanInterval: 3600 });
		Declared.setTTLExpiration(30);
		keyed(tableName, { expiration: null, eviction: null });
		assert.strictEqual(Declared.expirationMS, 30000);
		assert.strictEqual(Declared.evictionMS, 0, "the eviction was the schema's");
		keyed(tableName, { expiration: null, eviction: null });
		assert.strictEqual(Declared.expirationMS, 30000, 'a further declaration without a TTL keeps it');
	});

	it("clears a TTL an isolated application's schema declared when it declares none", async function () {
		const tableName = 'ExpiryIsolatedSchemaCleared';
		const Declared = keyed(tableName, { expiration: 600, eviction: 300, isolatedApplicationOwner: true });
		assert.strictEqual(Declared.expirationMS, 600000);
		keyed(tableName, { expiration: null, eviction: null, isolatedApplicationOwner: true });
		await commitCatalog(Declared);
		assert.deepStrictEqual(catalogExpiration(Declared), {});
		assert(!Declared.expirationMS, `this thread still applies ${Declared.expirationMS}ms`);
		assert.strictEqual(Declared.evictionMS, 0);
	});

	it('clears a schema TTL that replaced the one application code set, when the schema drops it', async function () {
		for (const isolatedApplicationOwner of [true, false]) {
			const tableName = `ExpirySchemaReplacedApplication${isolatedApplicationOwner ? 'Isolated' : 'Shared'}`;
			const Configured = keyed(tableName, { isolatedApplicationOwner });
			Configured.setTTLExpiration({ expiration: 30 });
			keyed(tableName, { expiration: 120, isolatedApplicationOwner });
			assert.strictEqual(Configured.expirationMS, 120000);
			keyed(tableName, { expiration: null, eviction: null, isolatedApplicationOwner });
			assert(
				!Configured.expirationMS,
				`isolatedApplicationOwner ${isolatedApplicationOwner} kept ${Configured.expirationMS}ms`
			);
		}
	});

	it('loads a saved value no declaration could save now as absent', async function () {
		const tableName = 'ExpiryLegacyInvalid';
		const Legacy = keyed(tableName);
		await writeCatalogSettings(Legacy, { expiration: { legacy: 1n }, eviction: -1 });
		delete databases[DATABASE][tableName];
		resetDatabases();
		const Restarted = getDatabases()[DATABASE][tableName];
		assert(Restarted, 'the table must still load');
		assert(!Restarted.expirationMS);
		assert.strictEqual(Restarted.evictionMS, 0);
		keyed(tableName, { expiration: 0, eviction: 0 });
		await commitCatalog(Restarted);
		const { value } = primaryRow(Restarted);
		assert(!('expiration' in value) && !('eviction' in value), 'the next declaration rewrites the row');
	});

	it('brings a loaded class up to date when another thread clears the catalog (#3934)', async function () {
		const tableName = 'ExpiryAdoptedClear';
		const Loaded = keyed(tableName);
		await writeCatalogSettings(Loaded, { expiration: 120, eviction: 60 });
		resetDatabases();
		assert.strictEqual(Loaded.expirationMS, 120000);

		const { key, value } = primaryRow(Loaded);
		const cleared = { ...value };
		delete cleared.expiration;
		delete cleared.eviction;
		Loaded.dbisDB.putSync(key, cleared);
		await commitCatalog(Loaded);
		resetDatabases();
		assert(!Loaded.expirationMS, `the reload kept ${Loaded.expirationMS}ms`);
		assert.strictEqual(Loaded.evictionMS, 0);
	});

	it('keeps a saved TTL through callers that do not author it', async function () {
		const tableName = 'ExpiryAddAttribute';
		const Declared = keyed(tableName, { expiration: 600, eviction: 300 });
		await Declared.addAttributes([{ name: 'added', type: 'String' }]);
		await commitCatalog(Declared);
		assert.deepStrictEqual(catalogExpiration(Declared), { expiration: 600, eviction: 300 });
		assert.strictEqual(Declared.expirationMS, 600000);
	});

	it('clears a TTL that a @table directive no longer declares (#3934)', async function () {
		const tableName = 'ExpiryGraphqlRemoved';
		await loadGQLSchema(`type ${tableName} @table(database: "${DATABASE}", expiration: 600, eviction: 300) {
			id: ID @primaryKey
		}`);
		const Declared = databases[DATABASE][tableName];
		await commitCatalog(Declared);
		assert.deepStrictEqual(catalogExpiration(Declared), { expiration: 600, eviction: 300 });

		await loadGQLSchema(`type ${tableName} @table(database: "${DATABASE}") {
			id: ID @primaryKey
		}`);
		await commitCatalog(Declared);
		assert.deepStrictEqual(catalogExpiration(Declared), {});
		assert(!Declared.expirationMS, `this thread still applies ${Declared.expirationMS}ms`);
		assert.strictEqual(Declared.evictionMS, 0);
	});

	it('clears a TTL that defineTable options no longer declare (#3934)', async function () {
		const tableName = 'ExpiryDefineTableRemoved';
		const shape = { id: types.id.primaryKey };
		const Declared = defineTable(tableName, shape, { database: DATABASE, expiration: 600 });
		await commitCatalog(Declared);
		assert.deepStrictEqual(catalogExpiration(Declared), { expiration: 600 });

		defineTable(tableName, shape, { database: DATABASE });
		await commitCatalog(Declared);
		assert.deepStrictEqual(catalogExpiration(Declared), {});
		assert(!Declared.expirationMS, `this thread still applies ${Declared.expirationMS}ms`);
	});

	it('rejects an invalid TTL before a create, naming the table and field (#1286, #3935)', async function () {
		for (const [field, value] of [
			['expiration', -1],
			['eviction', -1],
			['scanInterval', -1],
			['expiration', 'soon'],
			['eviction', Infinity],
			['expiration', Number.NaN],
			['expiration', 1e308],
			['expiration', ''],
			['expiration', true],
			['eviction', [5]],
		]) {
			const tableName = `ExpiryInvalidCreate_${field}_${String(value).replace(/\W/g, '')}`;
			assert.throws(
				() => keyed(tableName, { [field]: value }),
				(error) =>
					error.statusCode === 400 &&
					error.message.includes(field) &&
					error.message.includes(`${DATABASE}.${tableName}`),
				`${field}: ${value}`
			);
			assert.strictEqual(databases[DATABASE][tableName], undefined, `${field}: ${value} created the table`);
		}
	});
});
