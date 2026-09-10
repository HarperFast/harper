const assert = require('assert');
const { setupTestDBPath } = require('../testUtils');
const { loadGQLSchema } = require('#src/resources/graphql');
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
});
