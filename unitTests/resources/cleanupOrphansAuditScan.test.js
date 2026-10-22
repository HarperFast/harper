require('../testUtils');
const assert = require('node:assert');
const { existsSync, mkdirSync, writeFileSync } = require('node:fs');
const { dirname, join } = require('node:path');
const { randomBytes } = require('node:crypto');
const { setupTestDBPath } = require('../testUtils');
const { table, getDatabases } = require('#src/resources/databases');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { createBlob, cleanupOrphans, getFilePathForBlob, getRootBlobPathsForDB } = require('#src/resources/blob');

const DATABASE = 'cleanupOrphansAuditScan';

describe('cleanupOrphans scans audit values the record no longer holds', () => {
	let OrderTest;
	before(() => {
		setupTestDBPath();
		setMainIsWorker(true);
		OrderTest = table({
			table: 'OrderTest',
			database: DATABASE,
			audit: true,
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'tag' },
				{ name: 'extra' },
				{ name: 'data', type: 'Blob' },
			],
		});
	});

	// Above the inline threshold, so the blob is stored as a file.
	function blobWithFile() {
		return createBlob(randomBytes(20_000));
	}

	// The blob files the stored audit records of `id` reference.
	function auditBlobPaths(id) {
		const paths = [];
		for (const record of OrderTest.auditStore.getRange({ start: 0, end: Infinity })) {
			if (record.tableId !== OrderTest.tableId || record.recordId !== id) continue;
			const value = record.getValue(OrderTest.primaryStore);
			if (value?.data) paths.push(getFilePathForBlob(value.data));
		}
		return paths;
	}

	async function sweep() {
		return cleanupOrphans(getDatabases()[DATABASE], DATABASE);
	}

	// The audit entry of the older write keeps its own blob while the record keeps the newer one, so the
	// superseded blob is referenced by nothing except that retained audit entry.
	it('keeps the blob of an out-of-order patch that a newer patch superseded', async () => {
		const id = 'ooo-patch';
		const base = Date.now() + 10_000;
		await OrderTest.patch(id, { tag: 'newer', data: await blobWithFile() }, { timestamp: base + 100 });
		await OrderTest.patch(id, { extra: 'older', data: await blobWithFile() }, { timestamp: base });
		const paths = auditBlobPaths(id);
		assert.equal(paths.length, 2, 'both audit entries should reference a blob');
		await sweep();
		for (const path of paths) assert(existsSync(path), `blob ${path} referenced by a live audit entry was unlinked`);
		assert.equal(auditBlobPaths(id).length, 2);
		for (const record of OrderTest.auditStore.getRange({ start: 0, end: Infinity })) {
			if (record.tableId !== OrderTest.tableId || record.recordId !== id) continue;
			const value = record.getValue(OrderTest.primaryStore);
			assert((await value.data.bytes()).length > 0);
		}
	});

	it('keeps the blob of an out-of-order put that a newer patch superseded', async () => {
		const id = 'ooo-put';
		const base = Date.now() + 20_000;
		await OrderTest.patch(id, { data: await blobWithFile() }, { timestamp: base + 100 });
		await OrderTest.put(
			id,
			{ id, tag: 'from-put', extra: 'from-put', data: await blobWithFile() },
			{ timestamp: base }
		);
		const paths = auditBlobPaths(id);
		assert.equal(paths.length, 2, 'both audit entries should reference a blob');
		await sweep();
		for (const path of paths) assert(existsSync(path), `blob ${path} referenced by a live audit entry was unlinked`);
		for (const record of OrderTest.auditStore.getRange({ start: 0, end: Infinity })) {
			if (record.tableId !== OrderTest.tableId || record.recordId !== id) continue;
			const value = record.getValue(OrderTest.primaryStore);
			assert((await value.data.bytes()).length > 0);
		}
	});

	it('reclaims the blob of an audit entry that has been removed', async function () {
		// RocksDB expires audit entries by purging log segments, which the sweep's scan from the start
		// still reads until the segment rotates; only LMDB removes an entry on demand.
		if (OrderTest.auditStore.reusableIterable) return this.skip();
		const id = 'removed-audit';
		await OrderTest.put(id, { id, data: await blobWithFile() });
		const [path] = auditBlobPaths(id);
		assert(existsSync(path));
		for (const record of [...OrderTest.auditStore.getRange({ start: 0, end: Infinity })]) {
			if (record.tableId === OrderTest.tableId && record.recordId === id) await OrderTest.auditStore.remove(record.key);
		}
		await OrderTest.primaryStore.remove(id);
		assert.equal(auditBlobPaths(id).length, 0);
		await sweep();
		assert(!existsSync(path), 'a blob nothing references any more should be reclaimed');
	});

	it('still reclaims a blob file that nothing references', async () => {
		const [root] = getRootBlobPathsForDB(OrderTest.primaryStore.rootStore);
		const orphan = join(root, 'orphan-control', 'unreferenced');
		mkdirSync(dirname(orphan), { recursive: true });
		writeFileSync(orphan, Buffer.alloc(64));
		await sweep();
		assert(!existsSync(orphan), 'an unreferenced file should be reclaimed');
	});
});
