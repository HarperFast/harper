'use strict';

const assert = require('node:assert');
const { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { Worker } = require('node:worker_threads');
const { acquireRestoreLock, releaseRestoreLock, restoreMetaDir } = require('#src/dataLayer/restoreMarker');
const {
	newRestoreReceipt,
	readRestoreReceipt,
	receiptBlocksDiscovery,
	removeRestoreReceipt,
	removeUnreadableRestoreReceipt,
	restoreReceiptPath,
	writeRestoreReceipt,
	RESTORE_RECEIPT_VERSION,
} = require('#src/dataLayer/restoreReceipt');

describe('restoreReceipt', function () {
	let tempDir;
	let dbPath;
	let lock;

	function receiptFor(path, fields = {}) {
		return newRestoreReceipt({
			route: 'online',
			state: 'applying',
			database: 'orders',
			database_path: path,
			source_database: 'orders',
			backup_dir: join(tempDir, 'backups', 'orders'),
			backup_id: 3,
			options: {},
			...fields,
		});
	}

	beforeEach(function () {
		tempDir = mkdtempSync(join(tmpdir(), 'harper.unit-test.restore-receipt-'));
		dbPath = join(tempDir, 'orders');
		lock = acquireRestoreLock(dbPath);
	});

	afterEach(function () {
		releaseRestoreLock(lock);
		rmSync(tempDir, { recursive: true, force: true });
	});

	it('reads back what it wrote, stamped with the current version', function () {
		const written = writeRestoreReceipt(lock, receiptFor(dbPath, { expected_tables: ['Order'] }));
		const read = readRestoreReceipt(dbPath);
		assert.strictEqual(read.kind, 'valid');
		assert.deepStrictEqual(read.receipt, written);
		assert.strictEqual(read.receipt.version, RESTORE_RECEIPT_VERSION);
		assert.strictEqual(read.receipt.attempts, 0);
		assert.deepStrictEqual(
			readdirSync(restoreMetaDir(dbPath)).filter((name) => !name.endsWith('.lock')),
			[restoreReceiptPath(dbPath).slice(restoreMetaDir(dbPath).length + 1)],
			'no temp file is left beside the receipt'
		);
	});

	it('reads a missing receipt as absent, which does not block discovery', function () {
		const read = readRestoreReceipt(dbPath);
		assert.deepStrictEqual(read, { kind: 'absent' });
		assert.strictEqual(receiptBlocksDiscovery(read), false);
	});

	it('blocks discovery for every state but committed', function () {
		for (const state of ['pending', 'applying', 'terminal']) {
			writeRestoreReceipt(lock, receiptFor(dbPath, { state }));
			assert.strictEqual(receiptBlocksDiscovery(readRestoreReceipt(dbPath)), true, state);
		}
		writeRestoreReceipt(lock, receiptFor(dbPath, { state: 'committed' }));
		assert.strictEqual(receiptBlocksDiscovery(readRestoreReceipt(dbPath)), false);
	});

	describe('reads a receipt it cannot trust as unreadable, which blocks discovery', function () {
		const cases = [
			['a torn write', (text) => text.slice(0, Math.floor(text.length / 2)), /not valid JSON/],
			['a JSON non-object', () => '42', /not an object/],
			[
				'a newer version',
				(text) => JSON.stringify({ ...JSON.parse(text), version: RESTORE_RECEIPT_VERSION + 1 }),
				/version 2 is not 1/,
			],
			['an unknown state', (text) => JSON.stringify({ ...JSON.parse(text), state: 'published' }), /malformed/],
			[
				'a missing operation id',
				(text) => JSON.stringify({ ...JSON.parse(text), operation_id: undefined }),
				/malformed/,
			],
		];
		for (const [label, damage, reason] of cases) {
			it(label, function () {
				writeRestoreReceipt(lock, receiptFor(dbPath));
				const path = restoreReceiptPath(dbPath);
				writeFileSync(path, damage(readFileSync(path, 'utf8')));
				const read = readRestoreReceipt(dbPath);
				assert.strictEqual(read.kind, 'unreadable');
				assert.match(read.reason, reason);
				assert.strictEqual(receiptBlocksDiscovery(read), true);
			});
		}
	});

	it('removes a receipt only for the operation that owns it', function () {
		const mine = writeRestoreReceipt(lock, receiptFor(dbPath));
		assert.throws(
			() => removeRestoreReceipt(lock, 'another-operation'),
			(error) => error.statusCode === 409 && /belongs to another operation/.test(error.message)
		);
		assert.strictEqual(readRestoreReceipt(dbPath).kind, 'valid', 'a refused removal leaves the receipt in place');
		removeRestoreReceipt(lock, mine.operation_id);
		assert.strictEqual(readRestoreReceipt(dbPath).kind, 'absent');
		// already gone is success, so a retried finalizer does not fail
		removeRestoreReceipt(lock, mine.operation_id);
	});

	it('never removes an unreadable receipt by operation id, only through the unreadable path', function () {
		writeFileSync(restoreReceiptPath(dbPath), '{"version":');
		assert.throws(
			() => removeRestoreReceipt(lock, 'any-operation'),
			(error) => error.statusCode === 409
		);
		assert.ok(existsSync(restoreReceiptPath(dbPath)));
		removeUnreadableRestoreReceipt(lock);
		assert.strictEqual(readRestoreReceipt(dbPath).kind, 'absent');
	});

	it('refuses to remove a readable receipt through the unreadable path', function () {
		writeRestoreReceipt(lock, receiptFor(dbPath));
		assert.throws(() => removeUnreadableRestoreReceipt(lock), /is readable/);
		assert.strictEqual(readRestoreReceipt(dbPath).kind, 'valid');
	});

	it('refuses to write a receipt under the lock of another database', function () {
		const otherPath = join(tempDir, 'customers');
		assert.throws(() => writeRestoreReceipt(lock, receiptFor(otherPath)), /under the lock of/);
		assert.strictEqual(readRestoreReceipt(otherPath).kind, 'absent');
	});

	it('keeps the receipts of databases sharing a metadata directory apart while both are written', async function () {
		// Two restores of different databases hold different locks, so nothing serializes their writes.
		this.timeout(60000);
		const writer = (path, database) =>
			new Worker(
				`
				const { workerData, parentPort } = require('node:worker_threads');
				const { acquireRestoreLock, releaseRestoreLock } = require(workerData.marker);
				const { newRestoreReceipt, readRestoreReceipt, writeRestoreReceipt } = require(workerData.receipt);
				const lock = acquireRestoreLock(workerData.path);
				const mismatches = [];
				try {
					for (let i = 0; i < 100; i++) {
						const receipt = newRestoreReceipt({
							route: 'online', state: 'applying', database: workerData.database,
							database_path: workerData.path, source_database: workerData.database,
							backup_dir: '/backups', backup_id: i, options: {},
						});
						try {
							writeRestoreReceipt(lock, receipt);
							const read = readRestoreReceipt(workerData.path);
							if (read.kind !== 'valid' || read.receipt.operation_id !== receipt.operation_id)
								mismatches.push(read.kind === 'valid' ? read.receipt.database : read.reason);
						} catch (error) {
							mismatches.push(error.code ?? error.message);
						}
					}
				} finally {
					releaseRestoreLock(lock);
				}
				parentPort.postMessage(mismatches);
				`,
				{
					eval: true,
					workerData: {
						path,
						database,
						marker: require.resolve('#src/dataLayer/restoreMarker'),
						receipt: require.resolve('#src/dataLayer/restoreReceipt'),
					},
				}
			);
		const run = (worker) =>
			new Promise((resolve, reject) => {
				worker.once('message', resolve);
				worker.once('error', reject);
			});
		const results = await Promise.all([
			run(writer(join(tempDir, 'alpha'), 'alpha')),
			run(writer(join(tempDir, 'beta'), 'beta')),
		]);
		assert.deepStrictEqual(results, [[], []], 'each write must read back as its own receipt');
	});
});
