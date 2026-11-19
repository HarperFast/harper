require('../testUtils');
const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { waitFor } = require('../waitFor');
const { loadGQLSchema } = require('#src/resources/graphql');
const { databases, getDatabases, resetDatabases, table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#src/server/threads/manageThreads');

const KEYED_ATTRIBUTES = [{ name: 'id', isPrimaryKey: true }, { name: 'title' }];

function primaryDescriptor(Table) {
	return Table.dbisDB.getSync(Table.tableName + '/');
}

function auditEntriesFor(Table) {
	const entries = [];
	for (const entry of Table.auditStore.getRange({ start: 1 })) {
		if (entry.tableId === Table.tableId) entries.push(entry);
	}
	return entries;
}

async function commitCatalog(Table) {
	if (Table.dbisDB.committed) await Table.dbisDB.committed;
}

// what another thread's declaration leaves behind: a catalog row this thread's class has not loaded
async function writeCatalogSettings(Table, settings) {
	Table.dbisDB.putSync(Table.tableName + '/', { ...primaryDescriptor(Table), ...settings });
	await commitCatalog(Table);
}

async function acceptsUndeclaredProperty(Table, id) {
	try {
		await Table.put(id, { value: 'v', undeclared: 1 });
		return true;
	} catch (error) {
		if (/Property undeclared is not allowed/.test(error.message)) return false;
		throw error;
	}
}

// a role that may read only an attribute the table does not declare, which grants the primary key only while unsealed
function undeclaredReader(tableName) {
	const user = {
		role: {
			permission: {
				settings_reassert: {
					tables: {
						[tableName]: {
							read: true,
							insert: false,
							update: false,
							delete: false,
							attribute_permissions: [{ attribute_name: 'undeclared', read: true, insert: false, update: false }],
						},
					},
				},
			},
		},
	};
	return (Table, id) => {
		const request = { user, authorize: true, id };
		return Table.get(request, request).then((record) => JSON.parse(JSON.stringify(record)));
	};
}

describe('@table settings re-assert on existing tables', () => {
	before(function () {
		setupTestDBPath();
		setMainIsWorker(true);
	});

	it('applies an audit change to a table with no declared primary key', async function () {
		await loadGQLSchema(`
		type NoPkAudit @table(database: "settings_reassert", audit: false) {
			value: String
		}`);
		const Tbl = databases.settings_reassert.NoPkAudit;
		assert.strictEqual(Tbl.audit, false);
		assert.strictEqual(primaryDescriptor(Tbl).audit, false);
		await Tbl.put(1, { value: 'one' });
		await Tbl.put(2, { value: 'two' });
		assert.strictEqual(auditEntriesFor(Tbl).length, 0);

		await loadGQLSchema(`
		type NoPkAudit @table(database: "settings_reassert", audit: true) {
			value: String
		}`);
		await Tbl.dbisDB.committed;
		assert.strictEqual(primaryDescriptor(Tbl).audit, true);
		assert.strictEqual(databases.settings_reassert.NoPkAudit.audit, true);
		await databases.settings_reassert.NoPkAudit.put(3, { value: 'three' });
		assert.strictEqual(auditEntriesFor(databases.settings_reassert.NoPkAudit).length, 1);
	});

	it('applies expiration and eviction changes to a table with no declared primary key', async function () {
		await loadGQLSchema(`
		type NoPkTTL @table(database: "settings_reassert") {
			value: String
		}`);
		const Tbl = databases.settings_reassert.NoPkTTL;
		assert.strictEqual(primaryDescriptor(Tbl).expiration, undefined);
		assert.strictEqual(primaryDescriptor(Tbl).eviction, undefined);

		await loadGQLSchema(`
		type NoPkTTL @table(database: "settings_reassert", expiration: 3600, eviction: 7200) {
			value: String
		}`);
		await Tbl.dbisDB.committed;
		assert.strictEqual(primaryDescriptor(Tbl).expiration, 3600);
		assert.strictEqual(primaryDescriptor(Tbl).eviction, 7200);
		assert.strictEqual(databases.settings_reassert.NoPkTTL.expirationMS, 3600000);
	});

	it('still applies settings changes to a table with a declared primary key', async function () {
		await loadGQLSchema(`
		type PkAudit @table(database: "settings_reassert", audit: false) {
			id: Int @primaryKey
			value: String
		}`);
		const Tbl = databases.settings_reassert.PkAudit;
		assert.strictEqual(Tbl.audit, false);
		await Tbl.put(1, { value: 'one' });
		assert.strictEqual(auditEntriesFor(Tbl).length, 0);

		await loadGQLSchema(`
		type PkAudit @table(database: "settings_reassert", audit: true) {
			id: Int @primaryKey
			value: String
		}`);
		await Tbl.dbisDB.committed;
		assert.strictEqual(primaryDescriptor(Tbl).audit, true);
		assert.strictEqual(databases.settings_reassert.PkAudit.audit, true);
		await databases.settings_reassert.PkAudit.put(2, { value: 'two' });
		assert.strictEqual(auditEntriesFor(databases.settings_reassert.PkAudit).length, 1);
	});

	it('does not rewrite the catalog row when the directive is unchanged', async function () {
		await loadGQLSchema(`
		type NoPkStable @table(database: "settings_reassert", audit: false, expiration: 3600) {
			value: String
		}`);
		const Tbl = databases.settings_reassert.NoPkStable;
		await Tbl.dbisDB.committed;
		const before = { ...primaryDescriptor(Tbl) };
		const schemaVersionBefore = Tbl.schemaVersion;

		await loadGQLSchema(`
		type NoPkStable @table(database: "settings_reassert", audit: false, expiration: 3600) {
			value: String
		}`);
		await Tbl.dbisDB.committed;
		assert.deepStrictEqual({ ...primaryDescriptor(Tbl) }, before);
		assert.strictEqual(Tbl.schemaVersion, schemaVersionBefore);
	});

	it('clears TTL and replication on a table with no declared primary key', async function () {
		await loadGQLSchema(`
		type NoPkReverse @table(database: "settings_reassert", replicate: true, expiration: 3600, eviction: 7200) {
			value: String
		}`);
		const Tbl = databases.settings_reassert.NoPkReverse;
		assert.strictEqual(Tbl.replicate, true);
		assert.strictEqual(Tbl.expirationMS, 3600000);

		await loadGQLSchema(`
		type NoPkReverse @table(database: "settings_reassert", replicate: false, expiration: 0) {
			value: String
		}`);
		await commitCatalog(Tbl);
		const descriptor = primaryDescriptor(Tbl);
		assert.strictEqual(descriptor.replicate, false);
		assert.strictEqual(descriptor.expiration, undefined);
		assert.strictEqual(descriptor.eviction, undefined);
		assert.strictEqual(Tbl.replicate, false);
		assert(!Tbl.expirationMS, `the table still expires records after ${Tbl.expirationMS}ms`);
		assert(!Tbl.evictionMS, `the table still evicts records after ${Tbl.evictionMS}ms`);
	});

	it('enforces sealed on the declaring thread as soon as a re-declaration turns it on', async function () {
		await loadGQLSchema(`
		type NoPkSealOn @table(database: "settings_reassert") {
			value: String
		}`);
		const Tbl = databases.settings_reassert.NoPkSealOn;
		assert.strictEqual(await acceptsUndeclaredProperty(Tbl, 1), true);
		const schemaVersionBefore = Tbl.schemaVersion;

		await loadGQLSchema(`
		type NoPkSealOn @table(database: "settings_reassert", sealed: true) {
			value: String
		}`);
		await commitCatalog(Tbl);
		assert.strictEqual(primaryDescriptor(Tbl).sealed, true);
		assert(
			Tbl.schemaVersion > schemaVersionBefore,
			'a sealed-only change must announce a schema change to other threads'
		);
		assert.strictEqual(Tbl.sealed, true);
		assert.strictEqual(await acceptsUndeclaredProperty(Tbl, 2), false);
	});

	it('stops enforcing sealed as soon as a re-declaration turns it off', async function () {
		await loadGQLSchema(`
		type NoPkSealOff @table(database: "settings_reassert", sealed: true) {
			value: String
		}`);
		const Tbl = databases.settings_reassert.NoPkSealOff;
		assert.strictEqual(await acceptsUndeclaredProperty(Tbl, 1), false);

		await loadGQLSchema(`
		type NoPkSealOff @table(database: "settings_reassert", sealed: false) {
			value: String
		}`);
		await commitCatalog(Tbl);
		assert.strictEqual(primaryDescriptor(Tbl).sealed, false);
		assert.strictEqual(Tbl.sealed, false);
		assert.strictEqual(await acceptsUndeclaredProperty(Tbl, 2), true);
	});

	it('keeps sealed when a re-declaration drops @sealed', async function () {
		await loadGQLSchema(`
		type NoPkSealKept @table(database: "settings_reassert") @sealed {
			value: String
		}`);
		const Tbl = databases.settings_reassert.NoPkSealKept;
		await loadGQLSchema(`
		type NoPkSealKept @table(database: "settings_reassert") {
			value: String
		}`);
		await commitCatalog(Tbl);
		assert.strictEqual(primaryDescriptor(Tbl).sealed, true);
		assert.strictEqual(await acceptsUndeclaredProperty(Tbl, 1), false);
	});

	it("applies another thread's sealed change when the loaded class reloads", async function () {
		await loadGQLSchema(`
		type NoPkSealReload @table(database: "settings_reassert") {
			value: String
		}`);
		const Loaded = databases.settings_reassert.NoPkSealReload;
		await writeCatalogSettings(Loaded, { sealed: true });
		resetDatabases();
		assert.strictEqual(
			getDatabases().settings_reassert.NoPkSealReload,
			Loaded,
			'the reload must keep the loaded class'
		);
		assert.strictEqual(await acceptsUndeclaredProperty(Loaded, 1), false);

		await writeCatalogSettings(Loaded, { sealed: false });
		resetDatabases();
		assert.strictEqual(await acceptsUndeclaredProperty(Loaded, 2), true);
	});

	it("leaves a loaded table's sealed alone when a peer definition differs", async function () {
		await loadGQLSchema(`
		type NoPkSealPeer @table(database: "settings_reassert") {
			value: String
		}`);
		const Loaded = databases.settings_reassert.NoPkSealPeer;
		table({
			table: 'NoPkSealPeer',
			database: 'settings_reassert',
			attributes: [{ name: 'value', type: 'String' }],
			sealed: true,
			origin: 'cluster',
		});
		await commitCatalog(Loaded);
		assert.notStrictEqual(primaryDescriptor(Loaded).sealed, true);
		assert.strictEqual(await acceptsUndeclaredProperty(Loaded, 1), true);
	});

	it('withdraws the primary key a cached permission granted from an undeclared attribute once sealed', async function () {
		const declaration = { table: 'SealedKeyGrant', database: 'settings_reassert', attributes: KEYED_ATTRIBUTES };
		const Tbl = table(declaration);
		await Tbl.put('k-1', { id: 'k-1', title: 'hidden' });
		const read = undeclaredReader('SealedKeyGrant');
		assert.deepStrictEqual(await read(Tbl, 'k-1'), { id: 'k-1' });

		table({ ...declaration, sealed: true });
		assert.deepStrictEqual(await read(Tbl, 'k-1'), {});
	});

	it("re-derives a cached primary key grant when another thread's sealed change reloads the class", async function () {
		// only the key: a reload of a table with any other attribute re-derives every grant through updatedAttributes()
		const Loaded = table({
			table: 'SealedKeyGrantReload',
			database: 'settings_reassert',
			attributes: [{ name: 'id', isPrimaryKey: true }],
		});
		await Loaded.put('k-1', { id: 'k-1', title: 'hidden' });
		const read = undeclaredReader('SealedKeyGrantReload');
		assert.deepStrictEqual(await read(Loaded, 'k-1'), { id: 'k-1' });

		await writeCatalogSettings(Loaded, { sealed: true });
		resetDatabases();
		assert.deepStrictEqual(await read(Loaded, 'k-1'), {});

		await writeCatalogSettings(Loaded, { sealed: false });
		resetDatabases();
		assert.deepStrictEqual(await read(Loaded, 'k-1'), { id: 'k-1' });
	});

	it('keeps the sealed a subclass assigns off the table it extends', async function () {
		await loadGQLSchema(`
		type NoPkSealSubclass @table(database: "settings_reassert") {
			value: String
		}`);
		const Tbl = databases.settings_reassert.NoPkSealSubclass;
		class Strict extends Tbl {}
		Strict.sealed = true;
		assert.strictEqual(Strict.sealed, true);
		assert.strictEqual(Tbl.sealed, undefined);
		assert.strictEqual(await acceptsUndeclaredProperty(Tbl, 1), true);
	});

	it('keeps an open subscription delivering after a re-declaration turns audit off, and stops auditing on the next load', async function () {
		await loadGQLSchema(`
		type NoPkAuditOff @table(database: "settings_reassert", audit: true) {
			value: String
		}`);
		const Tbl = databases.settings_reassert.NoPkAuditOff;
		const received = [];
		const subscription = await Tbl.subscribe({});
		subscription.on('data', (event) => received.push(event.id));
		try {
			await Tbl.put(1, { value: 'one' });
			await waitFor(() => received.includes(1), { message: 'the subscription never received the first write' });

			await loadGQLSchema(`
			type NoPkAuditOff @table(database: "settings_reassert", audit: false) {
				value: String
			}`);
			await commitCatalog(Tbl);
			assert.strictEqual(primaryDescriptor(Tbl).audit, false);
			await Tbl.put(2, { value: 'two' });
			await waitFor(() => received.includes(2), {
				message: 'the subscription stopped receiving writes after audit was turned off',
			});
		} finally {
			subscription.close();
		}

		Tbl.cleanup();
		delete databases.settings_reassert.NoPkAuditOff;
		resetDatabases();
		const Reloaded = getDatabases().settings_reassert.NoPkAuditOff;
		assert.notStrictEqual(Reloaded, Tbl);
		assert.strictEqual(Reloaded.audit, false);
		const auditedBefore = auditEntriesFor(Reloaded).length;
		await Reloaded.put(3, { value: 'three' });
		assert.strictEqual(auditEntriesFor(Reloaded).length, auditedBefore);
	});
});
