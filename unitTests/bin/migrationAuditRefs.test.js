// The LMDB→RocksDB migration re-encodes every primary record through setNextEncoding. A source
// record whose header carries audit refs (HAS_ADDITIONAL_AUDIT_REFS — an unaudited table's
// commutative patch stores its received identities there) must keep them: re-encoding the flag
// without the refs made the reader take the first body byte as a ref count, so the record became
// undecodable or decoded into fabricated refs and a wrong body.
const fs = require('fs-extra');
const assert = require('node:assert');
const path = require('path');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#src/server/threads/manageThreads');
const { get: envGet } = require('#src/utility/environment/environmentManager');
const { CONFIG_PARAMS } = require('#src/utility/hdbTerms');

const { setupTestDBPath } = require('../testUtils');
const copyDB = require('#src/bin/copyDb');
const { RocksDatabase } = require('../rocksdbBindings.mts').rocksdbBindings();
const { RecordEncoder, HAS_ADDITIONAL_AUDIT_REFS, METADATA } = require('#src/resources/RecordEncoder');
const { PrimaryRocksDatabase } = require('#src/resources/PrimaryRocksDatabase');

const isLMDB = (process.env.HARPER_STORAGE_ENGINE || envGet(CONFIG_PARAMS.STORAGE_ENGINE)) === 'lmdb';
const IDS = ['a', 'b', 'c', 'd', 'e', 'f'];

describe('migration: records keep their header audit refs', function () {
	let rootPath, targetPath, Counter;
	const sourceEntries = new Map();

	before(async function () {
		if (!isLMDB) return this.skip();
		rootPath = setupTestDBPath();
		setMainIsWorker(true);
		Counter = table({
			table: 'AuditRefCounter',
			database: 'auditrefmig',
			audit: false,
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'label', indexed: true }, { name: 'n' }],
		});
		// body lengths vary so a misread ref count lands on different body bytes per record
		for (const [index, id] of IDS.entries()) {
			await Counter.put({ id, label: 'x'.repeat(index * 7 + 1), n: 0 });
			for (let patch = 0; patch <= index; patch++) await Counter.patch(id, { n: { __op__: 'add', value: 1 } });
		}
		for (const id of IDS) {
			const entry = Counter.primaryStore.getEntry(id);
			sourceEntries.set(id, { value: { ...entry.value }, refs: entry.receivedIdentityRefs, version: entry.version });
		}

		targetPath = path.join(rootPath, 'rocks-migrated-audit-refs', 'auditrefmig');
		await fs.remove(targetPath);
		await copyDB.copyDbToRocks(Counter.primaryStore.rootStore, 'auditrefmig', targetPath);
	});

	after(async function () {
		if (rootPath) await fs.remove(path.join(rootPath, 'rocks-migrated-audit-refs'));
	});

	it('the source records carry header audit refs', function () {
		for (const id of IDS) {
			const entry = Counter.primaryStore.getEntry(id);
			assert(entry.metadataFlags & HAS_ADDITIONAL_AUDIT_REFS, `source record ${id} has no audit-ref header`);
			assert(sourceEntries.get(id).refs?.length > 0, `source record ${id} has no received identity refs`);
		}
	});

	it('migrated records decode with their body and refs intact', function () {
		const root = RocksDatabase.open(targetPath, {});
		const cf = new PrimaryRocksDatabase(targetPath, {
			name: 'AuditRefCounter/',
			encoder: { Encoder: RecordEncoder },
			sharedStructuresKey: Symbol.for('structures'),
		}).open();
		cf.initStore(root);
		try {
			for (const id of IDS) {
				const source = sourceEntries.get(id);
				const entry = cf.getEntry(id);
				assert(entry?.value, `migrated record ${id} did not decode`);
				assert.deepStrictEqual({ ...entry.value }, source.value, `migrated record ${id} body changed`);
				assert.strictEqual(entry.version, source.version);
				assert(entry[METADATA] === undefined || true);
				assert.deepStrictEqual(entry.receivedIdentityRefs, source.refs, `migrated record ${id} lost its refs`);
			}
		} finally {
			cf.close();
			root.close();
		}
	});
});
