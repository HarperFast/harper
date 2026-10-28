require('../testUtils');
const assert = require('assert');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
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

		await Table.stripAttributeValues(['a']);

		for (const id of ids) assert.deepStrictEqual({ ...(await Table.get(id)) }, { id, keep: id * 2 }, `row ${id}`);
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
