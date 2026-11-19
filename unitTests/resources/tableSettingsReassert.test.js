require('../testUtils');
const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { waitFor } = require('../waitFor');
const { loadGQLSchema } = require('#src/resources/graphql');
const { databases, getDatabases, resetDatabases, table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');

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

describe('@table settings re-assert on existing tables', () => {
	before(function () {
		setupTestDBPath();
		setMainIsWorker(true);
	});

	it('applies an audit change to a table with no declared primary key', async function () {
		await loadGQLSchema(`
		type NoPkAudit @table(audit: false) {
			value: String
		}`);
		const Tbl = tables.NoPkAudit;
		assert.strictEqual(Tbl.audit, false);
		assert.strictEqual(primaryDescriptor(Tbl).audit, false);
		await Tbl.put(1, { value: 'one' });
		await Tbl.put(2, { value: 'two' });
		assert.strictEqual(auditEntriesFor(Tbl).length, 0);

		await loadGQLSchema(`
		type NoPkAudit @table(audit: true) {
			value: String
		}`);
		await Tbl.dbisDB.committed;
		assert.strictEqual(primaryDescriptor(Tbl).audit, true);
		assert.strictEqual(tables.NoPkAudit.audit, true);
		await tables.NoPkAudit.put(3, { value: 'three' });
		assert.strictEqual(auditEntriesFor(tables.NoPkAudit).length, 1);
	});

	it('applies expiration and eviction changes to a table with no declared primary key', async function () {
		await loadGQLSchema(`
		type NoPkTTL @table {
			value: String
		}`);
		const Tbl = tables.NoPkTTL;
		assert.strictEqual(primaryDescriptor(Tbl).expiration, undefined);
		assert.strictEqual(primaryDescriptor(Tbl).eviction, undefined);

		await loadGQLSchema(`
		type NoPkTTL @table(expiration: 3600, eviction: 7200) {
			value: String
		}`);
		await Tbl.dbisDB.committed;
		assert.strictEqual(primaryDescriptor(Tbl).expiration, 3600);
		assert.strictEqual(primaryDescriptor(Tbl).eviction, 7200);
		assert.strictEqual(tables.NoPkTTL.expirationMS, 3600000);
	});

	it('still applies settings changes to a table with a declared primary key', async function () {
		await loadGQLSchema(`
		type PkAudit @table(audit: false) {
			id: Int @primaryKey
			value: String
		}`);
		const Tbl = tables.PkAudit;
		assert.strictEqual(Tbl.audit, false);
		await Tbl.put(1, { value: 'one' });
		assert.strictEqual(auditEntriesFor(Tbl).length, 0);

		await loadGQLSchema(`
		type PkAudit @table(audit: true) {
			id: Int @primaryKey
			value: String
		}`);
		await Tbl.dbisDB.committed;
		assert.strictEqual(primaryDescriptor(Tbl).audit, true);
		assert.strictEqual(tables.PkAudit.audit, true);
		await tables.PkAudit.put(2, { value: 'two' });
		assert.strictEqual(auditEntriesFor(tables.PkAudit).length, 1);
	});

	it('does not rewrite the catalog row when the directive is unchanged', async function () {
		await loadGQLSchema(`
		type NoPkStable @table(audit: false, expiration: 3600) {
			value: String
		}`);
		const Tbl = tables.NoPkStable;
		await Tbl.dbisDB.committed;
		const before = { ...primaryDescriptor(Tbl) };
		const schemaVersionBefore = Tbl.schemaVersion;

		await loadGQLSchema(`
		type NoPkStable @table(audit: false, expiration: 3600) {
			value: String
		}`);
		await Tbl.dbisDB.committed;
		assert.deepStrictEqual({ ...primaryDescriptor(Tbl) }, before);
		assert.strictEqual(Tbl.schemaVersion, schemaVersionBefore);
	});

	it('clears TTL and replication on a table with no declared primary key', async function () {
		await loadGQLSchema(`
		type NoPkReverse @table(replicate: true, expiration: 3600, eviction: 7200) {
			value: String
		}`);
		const Tbl = tables.NoPkReverse;
		assert.strictEqual(Tbl.replicate, true);
		assert.strictEqual(Tbl.expirationMS, 3600000);

		await loadGQLSchema(`
		type NoPkReverse @table(replicate: false, expiration: 0) {
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
		type NoPkSealOn @table {
			value: String
		}`);
		const Tbl = tables.NoPkSealOn;
		assert.strictEqual(await acceptsUndeclaredProperty(Tbl, 1), true);

		await loadGQLSchema(`
		type NoPkSealOn @table(sealed: true) {
			value: String
		}`);
		await commitCatalog(Tbl);
		assert.strictEqual(primaryDescriptor(Tbl).sealed, true);
		assert.strictEqual(Tbl.sealed, true);
		assert.strictEqual(await acceptsUndeclaredProperty(Tbl, 2), false);
	});

	it('stops enforcing sealed as soon as a re-declaration turns it off', async function () {
		await loadGQLSchema(`
		type NoPkSealOff @table(sealed: true) {
			value: String
		}`);
		const Tbl = tables.NoPkSealOff;
		assert.strictEqual(await acceptsUndeclaredProperty(Tbl, 1), false);

		await loadGQLSchema(`
		type NoPkSealOff @table(sealed: false) {
			value: String
		}`);
		await commitCatalog(Tbl);
		assert.strictEqual(primaryDescriptor(Tbl).sealed, false);
		assert.strictEqual(Tbl.sealed, false);
		assert.strictEqual(await acceptsUndeclaredProperty(Tbl, 2), true);
	});

	it('keeps sealed when a re-declaration drops @sealed', async function () {
		await loadGQLSchema(`
		type NoPkSealKept @table @sealed {
			value: String
		}`);
		const Tbl = tables.NoPkSealKept;
		await loadGQLSchema(`
		type NoPkSealKept @table {
			value: String
		}`);
		await commitCatalog(Tbl);
		assert.strictEqual(primaryDescriptor(Tbl).sealed, true);
		assert.strictEqual(await acceptsUndeclaredProperty(Tbl, 1), false);
	});

	it("applies another thread's sealed change when the loaded class reloads", async function () {
		await loadGQLSchema(`
		type NoPkSealReload @table {
			value: String
		}`);
		const Loaded = tables.NoPkSealReload;
		await writeCatalogSettings(Loaded, { sealed: true });
		resetDatabases();
		assert.strictEqual(getDatabases().data.NoPkSealReload, Loaded, 'the reload must keep the loaded class');
		assert.strictEqual(await acceptsUndeclaredProperty(Loaded, 1), false);

		await writeCatalogSettings(Loaded, { sealed: false });
		resetDatabases();
		assert.strictEqual(await acceptsUndeclaredProperty(Loaded, 2), true);
	});

	it("leaves a loaded table's sealed alone when a peer definition differs", async function () {
		await loadGQLSchema(`
		type NoPkSealPeer @table {
			value: String
		}`);
		const Loaded = tables.NoPkSealPeer;
		table({
			table: 'NoPkSealPeer',
			database: 'data',
			attributes: [{ name: 'value', type: 'String' }],
			sealed: true,
			origin: 'cluster',
		});
		await commitCatalog(Loaded);
		assert.notStrictEqual(primaryDescriptor(Loaded).sealed, true);
		assert.strictEqual(await acceptsUndeclaredProperty(Loaded, 1), true);
	});

	it('withdraws the primary key a cached permission granted from an undeclared attribute once sealed', async function () {
		const Tbl = table({
			table: 'SealedKeyGrant',
			database: 'settings_reassert',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'title' }],
		});
		await Tbl.put('k-1', { id: 'k-1', title: 'hidden' });
		const user = {
			role: {
				permission: {
					settings_reassert: {
						tables: {
							SealedKeyGrant: {
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
		const read = () => {
			const request = { user, authorize: true, id: 'k-1' };
			return Tbl.get(request, request).then((record) => JSON.parse(JSON.stringify(record)));
		};
		assert.deepStrictEqual(await read(), { id: 'k-1' });

		table({
			table: 'SealedKeyGrant',
			database: 'settings_reassert',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'title' }],
			sealed: true,
		});
		assert.deepStrictEqual(await read(), {});
	});

	it('keeps an open subscription delivering after a re-declaration turns audit off, and stops auditing on the next load', async function () {
		await loadGQLSchema(`
		type NoPkAuditOff @table(audit: true) {
			value: String
		}`);
		const Tbl = tables.NoPkAuditOff;
		const received = [];
		const subscription = await Tbl.subscribe({});
		subscription.on('data', (event) => received.push(event.id));
		try {
			await Tbl.put(1, { value: 'one' });
			await waitFor(() => received.includes(1), { message: 'the subscription never received the first write' });

			await loadGQLSchema(`
			type NoPkAuditOff @table(audit: false) {
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

		delete databases.data.NoPkAuditOff;
		resetDatabases();
		const Reloaded = getDatabases().data.NoPkAuditOff;
		assert.notStrictEqual(Reloaded, Tbl);
		assert.strictEqual(Reloaded.audit, false);
		const auditedBefore = auditEntriesFor(Reloaded).length;
		await Reloaded.put(3, { value: 'three' });
		assert.strictEqual(auditEntriesFor(Reloaded).length, auditedBefore);
	});
});
