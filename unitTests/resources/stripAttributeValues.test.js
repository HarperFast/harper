require('../testUtils');
const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { table, getDatabases } = require('#src/resources/databases');
const { RequestTarget } = require('#src/resources/RequestTarget');
const { cleanupOrphans, decodeFromDatabase, getFilePathForBlob, saveBlob } = require('#src/resources/blob');
const { existsSync } = require('node:fs');
const { Readable } = require('node:stream');
const { setMainIsWorker } = require('#src/server/threads/manageThreads');
const { VERSION_REUSED, FULL_WRITE_HEAD } = require('#src/resources/RecordEncoder');

const isRocksDB = process.env.HARPER_STORAGE_ENGINE !== 'lmdb';

describe('Table.stripAttributeValues', () => {
	let tableCount = 0;
	before(() => {
		setupTestDBPath();
		setMainIsWorker(true);
	});
	const makeTable = (options = {}) =>
		table({
			table: `StripValues${tableCount++}`,
			database: 'test',
			audit: true,
			attributes: [{ name: 'id', isPrimaryKey: true }],
			...options,
		});
	const readEntry = (Table, id) => Table.primaryStore.getEntry(id, { uncachedRead: true });

	it('keeps the version, metadata and local time of each rewritten record', async () => {
		const Table = makeTable({ expiration: 3600 });
		for (let index = 0; index < 3; index++)
			await Table.put(`row-${index}`, { id: `row-${index}`, a: index, keep: 'k' });
		const before = ['row-0', 'row-1', 'row-2'].map((id) => readEntry(Table, id));
		assert.ok(before.every((entry) => entry.expiresAt > Date.now()));
		if (isRocksDB) assert.ok(before.every((entry) => entry.metadataFlags & FULL_WRITE_HEAD));

		await Table.stripAttributeValues(['a']);

		for (const previous of before) {
			const entry = readEntry(Table, previous.key);
			assert.deepStrictEqual({ ...entry.value }, { id: previous.key, keep: 'k' });
			assert.strictEqual(entry.version, previous.version);
			assert.strictEqual(entry.expiresAt, previous.expiresAt);
			assert.strictEqual(entry.nodeId, previous.nodeId);
			assert.strictEqual(entry.residencyId, previous.residencyId);
			assert.deepStrictEqual(entry.additionalAuditRefs, previous.additionalAuditRefs);
			assert.strictEqual(entry.metadataFlags & ~VERSION_REUSED, previous.metadataFlags & ~FULL_WRITE_HEAD);
			assert.strictEqual(entry.metadataFlags & FULL_WRITE_HEAD, 0);
			if (isRocksDB) {
				// the same version now names a different value, so no cache may vouch for the old one
				assert.ok(entry.metadataFlags & VERSION_REUSED);
			} else {
				assert.ok(previous.localTime > 0);
				assert.strictEqual(entry.localTime, previous.localTime);
			}
		}
	});

	it('rejects still-declared attributes before changing rows or indexes', async () => {
		const Table = makeTable({
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'a', indexed: true },
			],
		});
		await Table.put('indexed', { id: 'indexed', a: 'value', keep: 'retained' });

		await assert.rejects(Table.stripAttributeValues(['keep', 'a']), { statusCode: 409 });

		assert.deepStrictEqual({ ...readEntry(Table, 'indexed').value }, { id: 'indexed', a: 'value', keep: 'retained' });
		const ids = [];
		for await (const row of Table.search(new RequestTarget('?a=value'), {})) ids.push(row.id);
		assert.deepStrictEqual(ids, ['indexed']);
	});

	for (const partial of [false, true]) {
		it(`keeps audit-referenced blob files after a ${partial ? 'partial' : 'complete'} blob strip and orphan cleanup`, async () => {
			const Table = makeTable({ database: 'strip_blob_history' });
			const rootStore = Table.primaryStore.rootStore;
			const payload = Buffer.alloc(20000, 'd');
			const dropped = await createBlob(Readable.from(payload), { size: payload.length });
			const record = { id: 'blob', dropped };
			if (partial) record.kept = await createBlob(Readable.from(Buffer.alloc(20000, 'k')), { size: 20000 });
			await Table.put('blob', record);
			const before = readEntry(Table, 'blob');
			const auditRecord = Table.auditStore.get(before.localTime, Table.tableId, 'blob', before.nodeId);
			assert.ok(auditRecord, 'the original blob write is retained in the audit log');
			const droppedPath = decodeFromDatabase(() => getFilePathForBlob(dropped), rootStore);
			assert.ok(droppedPath && existsSync(droppedPath), 'the dropped blob is file-backed');
			const orphan = await createBlob(Readable.from(Buffer.alloc(20000, 'o')), { size: 20000 });
			await decodeFromDatabase(() => saveBlob(orphan).saving, rootStore);
			const orphanPath = decodeFromDatabase(() => getFilePathForBlob(orphan), rootStore);
			assert.ok(orphanPath && existsSync(orphanPath), 'the control is a real unreferenced file');

			await Table.stripAttributeValues(['dropped']);
			assert.strictEqual(readEntry(Table, 'blob').value.dropped, undefined);
			assert.strictEqual(await cleanupOrphans(getDatabases().strip_blob_history), 1);

			assert.strictEqual(existsSync(orphanPath), false, 'orphan cleanup still removes unreferenced files');
			assert.ok(existsSync(droppedPath), 'the retained audit value still owns the dropped blob');
			const historical = auditRecord.getValue(Table.primaryStore);
			assert.deepStrictEqual(Buffer.from(await historical.dropped.bytes()), payload);
			if (partial)
				assert.deepStrictEqual(
					Buffer.from(await readEntry(Table, 'blob').value.kept.bytes()),
					Buffer.alloc(20000, 'k')
				);
		});
	}

	it('leaves a deleted record deleted and a record without the attribute untouched', async () => {
		const Table = makeTable();
		await Table.put('gone', { id: 'gone', a: 1 });
		await Table.put('without', { id: 'without', keep: 1 });
		await Table.delete('gone');
		const tombstone = readEntry(Table, 'gone');
		assert.ok(tombstone && tombstone.value == null, 'an audited delete leaves a tombstone');
		const untouched = Table.primaryStore.getBinary('without');

		await Table.stripAttributeValues(['a']);

		const after = readEntry(Table, 'gone');
		assert.strictEqual(after.value, tombstone.value);
		assert.strictEqual(after.version, tombstone.version);
		assert.strictEqual(after.metadataFlags, tombstone.metadataFlags);
		assert.strictEqual(await Table.get('gone'), null);
		assert.deepStrictEqual(Buffer.from(Table.primaryStore.getBinary('without')), Buffer.from(untouched));
	});

	it('two concurrent strips of different attributes both take effect', async () => {
		const Table = makeTable();
		const ids = ['c-0', 'c-1', 'c-2'];
		for (const id of ids) await Table.put(id, { id, a: 1, b: 2, keep: 3 });

		await Promise.all([Table.stripAttributeValues(['a']), Table.stripAttributeValues(['b'])]);

		for (const id of ids) assert.deepStrictEqual({ ...readEntry(Table, id).value }, { id, keep: 3 });
	});

	it('strips more rows than one batch, typed-structure records included', async () => {
		const Table = makeTable({ randomAccessFields: true });
		const ids = Array.from({ length: 250 }, (_, index) => index);
		await Promise.all(ids.map((id) => Table.put(id, { id, a: `value-${id}`, keep: id * 2 })));

		assert.ok(Table.primaryStore.encoder.typedStructs.length > 0, 'the fixture uses typed structures');
		assert.ok(Object.hasOwn(readEntry(Table, 0).value, 'a'));
		await Table.stripAttributeValues(['a']);

		for (const id of ids) {
			const row = await Table.get(id);
			assert.strictEqual(row.id, id);
			assert.strictEqual(row.keep, id * 2);
			assert.strictEqual(row.a, undefined);
		}
	});

	it('gives a row stored without a version one, and keeps it readable', async function () {
		// lmdb-js versions every put
		if (!isRocksDB) this.skip();
		const Table = makeTable();
		await Table.primaryStore.put('raw', { id: 'raw', a: 1, b: 2 });
		assert.strictEqual(readEntry(Table, 'raw').version, undefined, 'a raw put stores no version');

		await Table.stripAttributeValues(['a']);

		const entry = readEntry(Table, 'raw');
		assert.deepStrictEqual({ ...entry.value }, { id: 'raw', b: 2 });
		assert.ok(entry.version > 0);
	});

	it('does not rewrite a row for a name it only inherits', async () => {
		const Table = makeTable();
		await Table.put('plain', { id: 'plain', a: 1 });
		const stored = Buffer.from(Table.primaryStore.getBinary('plain'));

		await Table.stripAttributeValues(['toString']);

		assert.deepStrictEqual(Buffer.from(Table.primaryStore.getBinary('plain')), stored);
	});
});
