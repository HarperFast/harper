const fs = require('fs-extra');
const assert = require('node:assert');
const path = require('node:path');
const { open } = require('lmdb');
const env_mgr = require('#src/utility/environment/environmentManager');
const { table, resetDatabases } = require('#src/resources/databases');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const copyDB = require('#src/bin/copyDb');
const audit_store = require('#src/resources/auditStore');
const OpenEnvironmentObject = require('#src/utility/lmdb/OpenEnvironmentObject').default;
const { OpenDBIObject } = require('#src/utility/lmdb/OpenDBIObject');
const { AUDIT_STORE_NAME } = require('#src/utility/lmdb/terms');
const { createBlob, getBlobPathsForDatabaseName } = require('#src/resources/blob');
const { get: envGet } = require('#src/utility/environment/environmentManager');
const { CONFIG_PARAMS } = require('#src/utility/hdbTerms');

/**
 * Regressions for harper#2048 — `copy-db`/`compactOnStart` produced a silently degraded copy and
 * exited 0. Each test below fails on the base revision:
 *
 *  - the tombstone length heuristic also matched the shared-structures dictionary, so a table with
 *    short attribute names (small dictionary) copied to records that all decode as null;
 *  - `getKeys()` + `getEntry()` yielded one entry per unique key, collapsing every dupSort index;
 *  - the blob store was never copied, so the copy could not resolve any file-backed value;
 *  - the audit store was copied into the *source* environment, so the copy had no audit log;
 *  - every recognised tombstone was dropped regardless of age, losing deletes the runtime still
 *    needs to reject a peer's stale copy of the record.
 */
describe('copy-db integrity (harper#2048)', () => {
	if ((process.env.HARPER_STORAGE_ENGINE || envGet(CONFIG_PARAMS.STORAGE_ENGINE)) !== 'lmdb') return;

	const DATABASE = 'copy-integrity';
	const RECORD_COUNT = 3000; // enough entries to cross copyDbi's 5000-outstanding-write await fence
	const DUPLICATE_COUNT = 20;
	let storage_path;
	let storage_path_before;
	let root_path_before;
	let base_path_before;
	let audit_retention_before;
	let blob_root;
	let ShortAttributes;
	let Wide;
	let deleted_fresh_id;
	let deleted_backdated_id;
	let open_copies = [];

	// Short attribute names keep the shared-structures dictionary small (9 bytes for this shape), the
	// only shape that reproduces the dictionary being taken for a delete tombstone.
	const openShortAttributes = () =>
		table({
			table: 'S',
			database: DATABASE,
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'a' }, { name: 'b' }],
		});
	const openWide = () =>
		table({
			table: 'WideAttributeNames',
			database: DATABASE,
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'groupingAttributeName', indexed: true },
				{ name: 'uniqueAttributeName', indexed: true },
				{ name: 'attachment' },
			],
		});

	before(async () => {
		storage_path = path.resolve(__dirname, '../envDir/copyIntegrity');
		storage_path_before = env_mgr.get('storage_path');
		root_path_before = env_mgr.get('rootPath');
		// blob roots resolve from the HDB base path, so point that at this fixture too — otherwise the
		// fixture's blob files land in the shared unit-test root and this suite depends on run order
		base_path_before = env_mgr.getHdbBasePath();
		audit_retention_before = audit_store.auditRetention;
		await fs.remove(storage_path);
		env_mgr.setProperty('storage_path', storage_path);
		env_mgr.setProperty('rootPath', storage_path);
		env_mgr.setHdbBasePath(storage_path);
		setMainIsWorker(true);

		ShortAttributes = openShortAttributes();
		Wide = openWide();

		let written;
		for (let i = 0; i < RECORD_COUNT; i++) {
			written = ShortAttributes.put({ id: i, a: i, b: 'v' + i });
		}
		for (let i = 0; i < DUPLICATE_COUNT; i++) {
			written = Wide.put({
				id: 'dup' + i,
				groupingAttributeName: 'sharedIndexedValue',
				uniqueAttributeName: 'unique-' + i,
			});
		}
		// A record with a file-backed blob, so the copy has blob bytes to carry
		written = Wide.put({
			id: 'withBlob',
			groupingAttributeName: 'sharedIndexedValue',
			uniqueAttributeName: 'unique-blob',
			attachment: await createBlob(Buffer.alloc(20000, 'b')), // over the 8192 file-storage threshold
		});
		await written;

		// One delete inside the audit-retention window: its tombstone must survive the copy
		deleted_fresh_id = 'dup0';
		await Wide.delete(deleted_fresh_id);

		// A replicated delete can arrive now with an origin version older than retention. LMDB's local
		// timestamp, not that origin version, determines when its audit entry and tombstone may expire.
		deleted_backdated_id = 'backdated-delete';
		const backdated_version = Date.now() - audit_retention_before - 10_000;
		await Wide.put(
			deleted_backdated_id,
			{
				groupingAttributeName: 'sharedIndexedValue',
				uniqueAttributeName: 'backdated-delete',
			},
			{ timestamp: backdated_version - 1 }
		);
		await Wide.delete(deleted_backdated_id, { timestamp: backdated_version });

		blob_root = getBlobPathsForDatabaseName(DATABASE)[0];
	});

	beforeEach(async () => {
		audit_store.setAuditRetention(audit_retention_before);
		open_copies = [];
	});

	afterEach(() => {
		for (const copy_env of open_copies) {
			try {
				copy_env.close();
			} catch {
				// a copy env that never opened, or already closed, is nothing to clean up
			}
		}
	});

	after(async () => {
		audit_store.setAuditRetention(audit_retention_before);
		await fs.remove(storage_path);
		env_mgr.setProperty('storage_path', storage_path_before);
		env_mgr.setProperty('rootPath', root_path_before);
		env_mgr.setHdbBasePath(base_path_before);
		resetDatabases();
	});

	/**
	 * Copy the database and open the copy for inspection at its own path. Reads must go to the copy's
	 * own environment: swapping the file over the source path instead would keep answering from the
	 * source, since lmdb-js hands back the already-open environment (and its mmap of the replaced
	 * file) for a path, and the live stores cache records and tombstones besides. The copy's DBIs are
	 * opened with the same `OpenDBIObject` the runtime uses, so a record only decodes here if the
	 * copied shared-structures dictionary decodes it.
	 */
	async function copyForInspection(name = 'inspect') {
		const copy_path = path.join(storage_path, name + '.mdb');
		await fs.remove(copy_path);
		await fs.remove(copy_path + '-lock');
		await copyDB.copyDb(DATABASE, copy_path, { blobs: 'preserve-source-roots' });
		const copy_env = open(new OpenEnvironmentObject(copy_path));
		open_copies.push(copy_env);
		return {
			primary: (store) => copy_env.openDB(store.name, new OpenDBIObject(false, true)),
			index: (store) => copy_env.openDB(store.name, new OpenDBIObject(true, false)),
		};
	}

	it('keeps every record readable when the shared-structures dictionary is small', async () => {
		const copy = await copyForInspection('short-attributes');
		const records = copy.primary(ShortAttributes.primaryStore);
		let readable = 0;
		for (let i = 0; i < RECORD_COUNT; i++) {
			if (records.get(i)?.b === 'v' + i) readable++;
		}
		assert.strictEqual(readable, RECORD_COUNT, 'every record in the copy should still decode');
	});

	it('keeps every duplicate of a dupSort secondary index', async () => {
		const copy = await copyForInspection('duplicates');
		// the deleted record dropped its index entries; the blob-bearing record shares the value
		const expected = DUPLICATE_COUNT - 1 + 1;
		const indexed = Array.from(copy.index(Wide.indices.groupingAttributeName).getValues('sharedIndexedValue'));
		assert.strictEqual(indexed.length, expected, 'the index should still hold one entry per record');
	});

	it('keeps a tombstone that is still inside the audit-retention window', async () => {
		const copy = await copyForInspection('fresh-tombstone');
		const entry = copy.primary(Wide.primaryStore).getEntry(deleted_fresh_id);
		assert.ok(entry, 'the delete tombstone should be copied while it is inside audit retention');
		assert.strictEqual(entry.value, null, 'a tombstone is a null value with a version');
		assert.ok(entry.version > 0, 'the tombstone keeps its version');
	});

	it('keeps a freshly applied tombstone whose origin version predates retention', async () => {
		const cutoff = Date.now() - audit_store.auditRetention;
		const source_entry = Wide.primaryStore.getEntry(deleted_backdated_id);
		assert.ok(source_entry.version < cutoff, 'premise: the replicated origin version is already past retention');
		assert.ok(source_entry.localTime > cutoff, 'premise: the tombstone was applied locally inside retention');

		const copy = await copyForInspection('backdated-tombstone');
		const copied_entry = copy.primary(Wide.primaryStore).getEntry(deleted_backdated_id);
		assert.ok(copied_entry, 'the locally fresh tombstone should survive the copy');
		assert.strictEqual(copied_entry.value, null, 'the copied entry remains a tombstone');
	});

	it('drops a tombstone that is past the audit-retention window', async () => {
		audit_store.setAuditRetention(-1000); // every existing tombstone is now past retention
		const copy = await copyForInspection('expired-tombstone');
		assert.strictEqual(
			copy.primary(Wide.primaryStore).getEntry(deleted_fresh_id),
			undefined,
			'an expired tombstone is purged by the copy'
		);
	});

	it('copies the blob store beside the target and documents the layout', async () => {
		const copy_path = path.join(storage_path, 'with-blobs.mdb');
		await copyDB.copyDb(DATABASE, copy_path, { blobs: 'copy' });
		const blob_copy_root = copy_path + '-blobs';
		assert.ok(await fs.exists(path.join(blob_copy_root, 'README.md')), 'the copy documents its blob layout');

		const sourceFiles = await listFiles(blob_root);
		assert.ok(sourceFiles.length > 0, 'the fixture wrote at least one blob file');
		const copiedFiles = await listFiles(path.join(blob_copy_root, '0'));
		assert.deepStrictEqual(copiedFiles, sourceFiles, 'every blob file is copied, at its original relative path');
		for (const relative_path of sourceFiles) {
			assert.ok(
				(await fs.readFile(path.join(blob_root, relative_path))).equals(
					await fs.readFile(path.join(blob_copy_root, '0', relative_path))
				),
				`blob ${relative_path} should be byte-identical in the copy`
			);
		}
	});

	it('restores as a different database, blob attachment and all, from the copy plus its blob directory', async () => {
		const restored_database = 'copy-integrity-restored';
		const copy_path = path.join(storage_path, restored_database + '.mdb');
		await copyDB.copyDb(DATABASE, copy_path, { blobs: 'copy' });

		// The documented restore: the environment file under the new database's name, and each
		// <rootIndex> tree in that database's matching blob root.
		await fs.copy(path.join(copy_path + '-blobs', '0'), getBlobPathsForDatabaseName(restored_database)[0]);
		resetDatabases();

		const Restored = table({
			table: 'WideAttributeNames',
			database: restored_database,
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'groupingAttributeName', indexed: true },
				{ name: 'uniqueAttributeName', indexed: true },
				{ name: 'attachment' },
			],
		});
		const record = await Restored.get('withBlob');
		assert.ok(record, 'the restored copy still has the blob-bearing record');
		const attachment = await record.attachment.arrayBuffer();
		assert.ok(
			Buffer.from(attachment).equals(Buffer.alloc(20000, 'b')),
			'the attachment reads back byte-exact from the restored blob root'
		);
	});

	it('copies the audit log into the target rather than back into the source', async () => {
		const source_audit = Wide.primaryStore.rootStore.auditStore;
		const source_entries = readAuditEntries(source_audit);
		assert.ok(source_entries.length > 0, 'the fixture wrote audit entries');

		const copy_path = path.join(storage_path, 'with-audit.mdb');
		await copyDB.copyDb(DATABASE, copy_path, { blobs: 'preserve-source-roots' });

		// the source is unchanged: the copy must not write anything back into it
		assert.deepStrictEqual(readAuditEntries(source_audit), source_entries, 'the source audit log is untouched');

		const copy_env = open(new OpenEnvironmentObject(copy_path));
		try {
			const copied_audit = copy_env.openDB(AUDIT_STORE_NAME, {
				create: false,
				...audit_store.AUDIT_STORE_OPTIONS,
			});
			assert.ok(copied_audit, 'the copy has an audit store');
			assert.deepStrictEqual(readAuditEntries(copied_audit), source_entries, 'the copied audit log matches the source');
		} finally {
			copy_env.close();
		}
	});

	it('refuses a copy target that already exists', async () => {
		const copy_path = path.join(storage_path, 'existing-target.mdb');
		await fs.writeFile(copy_path, 'not a database');
		await assert.rejects(
			() => copyDB.copyDb(DATABASE, copy_path, { blobs: 'copy' }),
			/already exists/,
			'an existing target would be merged into rather than replaced'
		);
	});

	it('requires the caller to declare what happens to the blobs', async () => {
		await assert.rejects(
			() => copyDB.copyDb(DATABASE, path.join(storage_path, 'no-disposition.mdb'), {}),
			/requires a blob disposition/
		);
		await assert.rejects(
			() => copyDB.copyDb(DATABASE, path.join(storage_path, 'no-disposition.mdb')),
			/requires a blob disposition/
		);
	});

	it('refuses to copy a database whose tables span multiple environments', async () => {
		const database = require('#src/resources/databases').getDatabases()[DATABASE];
		database.ForeignEnvironment = {
			primaryStore: { name: 'ForeignEnvironment/id', rootStore: { path: '/somewhere/else.mdb' } },
			indices: {},
		};
		try {
			await assert.rejects(
				() => copyDB.copyDb(DATABASE, path.join(storage_path, 'multi-env.mdb'), { blobs: 'copy' }),
				/spans 2 storage environments/
			);
		} finally {
			delete database.ForeignEnvironment;
		}
	});

	/** Relative paths of every file under `root`, sorted — [] when the directory does not exist. */
	async function listFiles(root) {
		if (!(await fs.exists(root))) return [];
		const files = [];
		const stack = [root];
		while (stack.length > 0) {
			const directory = stack.pop();
			for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
				const entry_path = path.join(directory, entry.name);
				if (entry.isDirectory()) stack.push(entry_path);
				else files.push(path.relative(root, entry_path));
			}
		}
		return files.sort();
	}

	/** Every audit entry as `[printable key, hex value]`, so source and copy compare byte-for-byte. */
	function readAuditEntries(store) {
		const entries = [];
		for (const key of store.getRange({ values: false })) {
			const value = store.getBinary(key);
			entries.push([
				typeof key === 'symbol' ? `symbol:${key.description}` : key,
				value && Buffer.from(value).toString('hex'),
			]);
		}
		return entries;
	}
});
