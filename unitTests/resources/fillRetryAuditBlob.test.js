const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { transaction } = require('#src/resources/transaction');
const { waitFor } = require('../waitFor');
const { createBlob, getFileId, saveBlob, setDeletionDelay } = require('#src/resources/blob');

const isLMDB = process.env.HARPER_STORAGE_ENGINE === 'lmdb';

describe('Cache fill retried behind a raced write', function () {
	this.timeout(10000);
	let T, fillBlob, raceFill;
	before(function () {
		if (isLMDB) return this.skip();
		setupTestDBPath();
		setMainIsWorker(true);
		T = table({
			table: 'FillRetryAuditBlob',
			database: 'test',
			audit: true,
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'name' }, { name: 'blob', type: 'Blob' }],
		});
		T.sourcedFrom({
			get(id, context) {
				raceFill?.(id, context.transaction);
				return { id, name: 'source', blob: fillBlob };
			},
		});
	});

	it('keeps the blob its committed audit entry references when the retry skips the fill', async function () {
		const id = 'raced';
		fillBlob = createBlob(Buffer.alloc(20000, 'f'));
		let fillTxn, fillWrite, native;
		raceFill = (raceId, txn) => {
			raceFill = undefined;
			fillTxn = txn;
			const addWrite = txn.addWrite;
			txn.addWrite = function (write) {
				if (write.key !== raceId || write.nodeName !== 'source') return addWrite.call(this, write);
				fillWrite = write;
				const commit = write.commit;
				write.commit = function (...args) {
					const result = commit.apply(this, args);
					if (!native) {
						native = args[3];
						const nativeCommit = native.commit;
						native.commit = async function (...commitArgs) {
							native.commit = nativeCommit;
							await transaction({}, () => T.put(raceId, { id: raceId, name: 'raced' }));
							return nativeCommit.apply(this, commitArgs);
						};
					}
					return result;
				};
				return addWrite.call(this, write);
			};
		};
		setDeletionDelay(0);
		try {
			await T.get(id);
			assert.ok(fillWrite, 'the fill must have staged a write');
			// the fill commits after get() resolves; its writes are cleared only after skip cleanup ran
			await waitFor(() => !fillTxn.writes.includes(fillWrite));
			assert.ok(native.retries > 0, 'the raced put must cause a real native conflict');
			assert.equal(fillWrite.skipped, true, 'the retry must skip the fill behind the raced put');
			assert.equal(fillWrite.blobsAuditReferenced, true);
			assert.equal((await T.get(id)).name, 'raced');
			const audited = [...T.auditStore.getRange({ start: 1 })].find(
				(entry) =>
					entry.tableId === T.tableId &&
					entry.recordId === id &&
					getFileId(entry.getValue(T.primaryStore)?.blob) === getFileId(fillBlob)
			);
			assert.ok(audited, "the fill's audit entry must remain in the committed batch");
			assert.doesNotThrow(() => saveBlob(fillBlob), 'skip cleanup must not discard the audit-owned blob');
			const bytes = await audited.getValue(T.primaryStore).blob.bytes();
			assert.deepEqual(Buffer.from(bytes), Buffer.alloc(20000, 'f'));
		} finally {
			setDeletionDelay(undefined);
		}
	});
});
