// An unaudited table's `add` patch stores its received identity in the record header (0x80).
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
const {
	RecordEncoder,
	HAS_ADDITIONAL_AUDIT_REFS,
	HAS_EXPIRATION,
	HAS_REPLICA_DEADLINE,
	HAS_RESIDENCY_ID,
	HAS_RESIDENCY_SLOT,
	HAS_NODE_ID,
} = require('#src/resources/RecordEncoder');
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
		// varied body lengths: a misread ref count lands on different bytes per record
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
				assert(entry.metadataFlags & HAS_ADDITIONAL_AUDIT_REFS, `migrated record ${id} lost its audit-ref flag`);
				assert.deepStrictEqual(entry.receivedIdentityRefs, source.refs, `migrated record ${id} lost its refs`);
			}
		} finally {
			cf.close();
			root.close();
		}
	});
});

describe('migration: a record it cannot write fails the migration', function () {
	let rootPath, targetPath, Broken;

	before(async function () {
		if (!isLMDB) return this.skip();
		rootPath = setupTestDBPath();
		setMainIsWorker(true);
		Broken = table({
			table: 'AuditRefBroken',
			database: 'auditrefbroken',
			audit: false,
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'n' }],
		});
		await Broken.put({ id: 'whole', n: 0 });
		await Broken.put({ id: 'flagged', n: 0 });
		await Broken.patch('flagged', { n: { __op__: 'add', value: 1 } });
		// keep the refs flag, drop the refs: decode yields none, so the migration has nothing to re-encode it with
		const { version } = Broken.primaryStore.getEntry('flagged');
		const rawDbi = Broken.primaryStore.rootStore.openDB('AuditRefBroken/', { encoding: 'binary', useVersions: true });
		const bytes = Buffer.from(rawDbi.getBinary('flagged'));
		const flags = bytes.readUInt32BE(0) & 0xffffff;
		assert(flags & HAS_ADDITIONAL_AUDIT_REFS);
		let countAt = 4;
		if (flags & HAS_EXPIRATION) countAt += 8;
		if (flags & HAS_REPLICA_DEADLINE) countAt += 8;
		if (flags & HAS_RESIDENCY_ID) countAt += 4;
		if (flags & HAS_RESIDENCY_SLOT) countAt += 2;
		if (flags & HAS_NODE_ID) countAt += 4;
		const bodyAt = countAt + 1 + bytes[countAt] * 12;
		await rawDbi.put(
			'flagged',
			Buffer.concat([bytes.subarray(0, countAt), Buffer.from([0]), bytes.subarray(bodyAt)]),
			version
		);
		assert.strictEqual(Broken.primaryStore.getEntry('flagged').receivedIdentityRefs, undefined);
		targetPath = path.join(rootPath, 'rocks-migrated-audit-refs-broken', 'auditrefbroken');
		await fs.remove(targetPath);
	});

	after(async function () {
		if (rootPath) await fs.remove(path.join(rootPath, 'rocks-migrated-audit-refs-broken'));
	});

	it('rejects instead of finishing without the record', async function () {
		await assert.rejects(
			copyDB.copyDbToRocks(Broken.primaryStore.rootStore, 'auditrefbroken', targetPath),
			/AuditRefBroken\/ failed to write 1 record/
		);
	});
});
