require('../testUtils');
const assert = require('node:assert');
const { randomBytes } = require('node:crypto');
const { statSync, truncateSync, unlinkSync, writeFileSync } = require('node:fs');
const { RocksDatabase } = require('@harperfast/rocksdb-js');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const {
	assessBlobReferences,
	classifyRestoredBlobFile,
	createCaptureMarker,
	getFilePathForBlob,
} = require('#src/resources/blob');
const { waitFor } = require('../waitFor.js');

const isLMDB = process.env.HARPER_STORAGE_ENGINE === 'lmdb';
const DATABASE = 'blobassess';

describe('restored blob assessment', function () {
	let tableCount = 0;

	before(function () {
		setupTestDBPath();
		setMainIsWorker(true);
	});

	function newTable() {
		const name = `Assess${++tableCount}`;
		return {
			name,
			Table: table({
				table: name,
				database: DATABASE,
				attributes: [
					{ name: 'id', isPrimaryKey: true },
					{ name: 'blob', type: 'Blob' },
				],
			}),
		};
	}

	async function putBlob(Table, id, body = randomBytes(20000), options) {
		const blob = await createBlob(body, options);
		await Table.put({ id, blob });
		const path = getFilePathForBlob(blob);
		await waitFor(async () => (await classifyRestoredBlobFile(path)) === 'complete', {
			message: `blob file of record ${id} never became complete`,
		});
		return path;
	}

	describe('classifyRestoredBlobFile', function () {
		it('tells a whole file from a capture marker, a missing file and a truncated one', async function () {
			const { Table } = newTable();
			const whole = await putBlob(Table, 1);
			assert.strictEqual(await classifyRestoredBlobFile(whole), 'complete');

			const marker = await putBlob(Table, 2);
			writeFileSync(marker, createCaptureMarker('pending', 'still being written when captured'));
			assert.strictEqual(await classifyRestoredBlobFile(marker), 'marker');

			const missing = await putBlob(Table, 3);
			unlinkSync(missing);
			assert.strictEqual(await classifyRestoredBlobFile(missing), 'missing');

			const truncated = await putBlob(Table, 4);
			truncateSync(truncated, statSync(truncated).size - 100);
			assert.strictEqual(await classifyRestoredBlobFile(truncated), 'incomplete');
		});

		it('inflates a compressed file to decide whether it is whole', async function () {
			const { Table } = newTable();
			const path = await putBlob(Table, 1, Buffer.alloc(20000, 'a'), { compress: true });
			assert.ok(statSync(path).size < 20000, 'precondition: the body is stored compressed');
			assert.strictEqual(await classifyRestoredBlobFile(path), 'complete');
			truncateSync(path, statSync(path).size - 5);
			assert.strictEqual(await classifyRestoredBlobFile(path), 'incomplete');
		});
	});

	describe('assessBlobReferences', function () {
		it('reports verified when every referenced file is whole, counting every record scanned', async function () {
			const { name, Table } = newTable();
			await putBlob(Table, 1);
			await putBlob(Table, 2);
			await Table.put({ id: 3 });
			const assessment = await assessBlobReferences({ [name]: Table });
			assert.deepStrictEqual(assessment, {
				blobIntegrity: 'verified',
				recordsScanned: { [name]: 3 },
				references: 2,
				markers: 0,
				failures: [],
			});
		});

		it('reports unverified when a reference resolves to a capture marker', async function () {
			const { name, Table } = newTable();
			await putBlob(Table, 1);
			const captured = await putBlob(Table, 2);
			writeFileSync(captured, createCaptureMarker('gone', 'reclaimed before the backup copied it'));
			const assessment = await assessBlobReferences({ [name]: Table });
			assert.strictEqual(assessment.blobIntegrity, 'unverified');
			assert.strictEqual(assessment.markers, 1);
			assert.deepStrictEqual(assessment.failures, []);
		});

		it('reports failed, naming the record, for a missing file and for a truncated one', async function () {
			const { name, Table } = newTable();
			const missing = await putBlob(Table, 'missing');
			const truncated = await putBlob(Table, 'truncated');
			const captured = await putBlob(Table, 'captured');
			unlinkSync(missing);
			truncateSync(truncated, statSync(truncated).size - 100);
			writeFileSync(captured, createCaptureMarker('pending', 'captured'));
			const assessment = await assessBlobReferences({ [name]: Table });
			assert.strictEqual(assessment.blobIntegrity, 'failed', 'a failure outranks a marker');
			assert.strictEqual(assessment.references, 3);
			assert.deepStrictEqual(
				assessment.failures.sort((a, b) => String(a.id).localeCompare(String(b.id))),
				[
					{ table: name, id: 'missing', state: 'missing' },
					{ table: name, id: 'truncated', state: 'incomplete' },
				]
			);
		});

		it('fails on a record it cannot decode, even one with no blobs', async function () {
			if (isLMDB) return this.skip();
			const { name, Table } = newTable();
			await Table.put({ id: 1 });
			await Table.put({ id: 3 });
			// the same column family, without Harper's record encoding, to store bytes no record decodes from
			const raw = RocksDatabase.open(Table.primaryStore.rootStore.path, {
				name: Table.primaryStore.name,
				encoding: 'binary',
			});
			try {
				raw.putSync(2, Buffer.from([0xc1, 0xc1, 0xc1]));
			} finally {
				raw.close();
			}
			await assert.rejects(assessBlobReferences({ [name]: Table }), (error) => {
				assert.match(error.message, new RegExp(`Could not read record 2 of table ${name} \\(after id 1\\)`));
				assert.ok(error.cause, 'the decode error is chained');
				return true;
			});
			const lenient = [...Table.primaryStore.getRange({ snapshot: false })].map(({ key }) => key);
			assert.deepStrictEqual(lenient, [1, 2, 3], 'other reads still decode leniently after the scan fails');
		});
	});
});
