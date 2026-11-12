require('../testUtils');
const assert = require('assert');
const { PassThrough, Readable } = require('node:stream');
const { randomBytes } = require('node:crypto');
const { openSync, writeSync, ftruncateSync, closeSync } = require('node:fs');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#src/server/threads/manageThreads');
const { transaction } = require('#src/resources/transaction');
const { getFilePathForBlob, isBlobComplete, findIncompleteBlobRefs } = require('#src/resources/blob');
const { setAbortMarkersForTests } = require('#src/resources/transactionLogAbortMarkers');
const { waitFor } = require('../waitFor.js');

const isLMDB = process.env.HARPER_STORAGE_ENGINE === 'lmdb';
const HEADER_SIZE = 8;

// The header and body of a file cut short to `newSize` while staying internally consistent, so only
// the record descriptor's size can tell it from a whole file (#1424).
function truncateConsistently(filePath, newSize) {
	const header = Buffer.alloc(HEADER_SIZE);
	new DataView(header.buffer).setBigInt64(0, BigInt(newSize));
	const fd = openSync(filePath, 'r+');
	try {
		writeSync(fd, header, 0, HEADER_SIZE, 0);
		ftruncateSync(fd, HEADER_SIZE + newSize);
	} finally {
		closeSync(fd);
	}
}

// mocha's timeout is 0 here, so a wait that a regression could leave pending fails on its own
function within(promise, what, ms = 10_000) {
	let timer;
	return Promise.race([
		promise,
		new Promise((_, reject) => {
			timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), ms);
		}),
	]).finally(() => clearTimeout(timer));
}

function pendingBlob(payload) {
	const stream = new PassThrough();
	const blob = createBlob(stream);
	return {
		blob,
		finish() {
			stream.write(payload.subarray(0, payload.length >> 1));
			stream.end(payload.subarray(payload.length >> 1));
		},
	};
}

describe('A blob streamed into a record stores its final size', () => {
	let StreamedBlobs;
	before(() => {
		setupTestDBPath();
		setMainIsWorker(true);
		StreamedBlobs = table({
			table: 'StreamedBlobDescriptorSize',
			database: 'test',
			audit: true,
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'blob', type: 'Blob' }, { name: 'x' }],
		});
	});

	// Decoded from the stored bytes, not the cached instance the write used.
	function storedBlob(id) {
		const blob = StreamedBlobs.primaryStore.getEntry(id, { uncachedRead: true })?.value?.blob;
		assert(blob, `record ${id} has no stored blob`);
		return blob;
	}
	async function auditedBlobSizes(id) {
		const history = await StreamedBlobs.getHistoryOfRecord(id);
		return history.filter((entry) => entry.value?.blob).map((entry) => entry.value.blob.size);
	}

	it('in the record and its audit entry, as soon as the write resolves', async () => {
		const payload = randomBytes(30000);
		const { blob, finish } = pendingBlob(payload);
		const putting = StreamedBlobs.put({ id: 'single', blob });
		finish();
		await putting;
		assert.strictEqual(blob.size, payload.length);
		assert.strictEqual(storedBlob('single').size, payload.length);
		assert.deepStrictEqual(await auditedBlobSizes('single'), [payload.length]);
		assert(Buffer.from(await storedBlob('single').bytes()).equals(payload));
	});

	it('of zero for an empty stream', async () => {
		const { blob, finish } = pendingBlob(Buffer.alloc(0));
		const putting = StreamedBlobs.put({ id: 'empty', blob });
		finish();
		await putting;
		assert.strictEqual(storedBlob('empty').size, 0);
		assert.deepStrictEqual(await auditedBlobSizes('empty'), [0]);
	});

	it('across a transaction that reads the record back and writes it again', async () => {
		const payload = randomBytes(20000);
		const { blob, finish } = pendingBlob(payload);
		const context = {};
		await transaction(context, async () => {
			StreamedBlobs.put({ id: 'txn', x: 1, blob }, context);
			StreamedBlobs.put({ id: 'txn-sibling', x: 1 }, context);
			// LMDB reads do not see a transaction's staged writes, and its same-key chains are not under test
			if (!isLMDB) {
				const readBack = await StreamedBlobs.get('txn', context);
				assert.strictEqual(readBack.x, 1, 'the transaction reads its own staged write');
				// a separate instance decoded from the staged record, which the stream's completion never sizes
				StreamedBlobs.put({ id: 'txn', x: 2, blob: readBack.blob }, context);
				StreamedBlobs.patch('txn', { x: 3 }, context);
			}
			finish();
		});
		const stored = storedBlob('txn');
		assert.strictEqual(stored.size, payload.length);
		assert.strictEqual((await StreamedBlobs.get('txn')).x, isLMDB ? 1 : 3);
		assert.strictEqual((await StreamedBlobs.get('txn-sibling')).x, 1);
		for (const size of await auditedBlobSizes('txn')) assert.strictEqual(size, payload.length);
		assert(Buffer.from(await stored.bytes()).equals(payload));
	});

	it('when the re-staged commit hits a conflict and retries', async function () {
		if (isLMDB) this.skip(); // the conflict is forced on a RocksDB handle
		const { Transaction } = require('@harperfast/rocksdb-js');
		const originalCommit = Transaction.prototype.commit;
		const targetDb = StreamedBlobs.primaryStore.store.db;
		// markers off: the failed attempt keeps its log batch and the retry re-stages only the records
		const priorAbortMarkers = setAbortMarkersForTests(false);
		let armed = false;
		let conflicts = 0;
		Transaction.prototype.commit = function (...args) {
			if (armed && this.store?.db === targetDb) {
				armed = false;
				conflicts++;
				return Promise.reject(Object.assign(new Error('forced conflict'), { code: 'ERR_BUSY' }));
			}
			return originalCommit.apply(this, args);
		};
		try {
			const payload = randomBytes(20000);
			const { blob, finish } = pendingBlob(payload);
			const context = {};
			await within(
				transaction(context, async () => {
					StreamedBlobs.put({ id: 'retried', x: 1, blob }, context);
					const readBack = await StreamedBlobs.get('retried', context);
					StreamedBlobs.put({ id: 'retried', x: 2, blob: readBack.blob }, context);
					armed = true;
					finish();
				}),
				'the retried commit'
			);
			assert.strictEqual(conflicts, 1, 'test setup: the commit retried once');
			assert.strictEqual((await StreamedBlobs.get('retried')).x, 2);
			assert.strictEqual(storedBlob('retried').size, payload.length);
			for (const size of await auditedBlobSizes('retried')) assert.strictEqual(size, payload.length);
		} finally {
			Transaction.prototype.commit = originalCommit;
			setAbortMarkersForTests(priorAbortMarkers ?? true);
		}
	});

	it('for a write that joins while the commit waits for the blob', async function () {
		if (isLMDB) this.skip(); // exercises RocksDB's commit continuation
		const first = randomBytes(20000);
		const second = randomBytes(12000);
		const pendingFirst = pendingBlob(first);
		const pendingSecond = pendingBlob(second);
		const context = {};
		const committing = transaction(context, async () => {
			StreamedBlobs.put({ id: 'joined-first', blob: pendingFirst.blob }, context);
		});
		let joining;
		try {
			await waitFor(() => context.transaction?.committing, 5000);
			joining = StreamedBlobs.put({ id: 'joined-second', blob: pendingSecond.blob }, context);
		} finally {
			pendingFirst.finish();
			pendingSecond.finish();
		}
		await within(Promise.all([committing, joining]), 'both writes to commit');
		assert.strictEqual(storedBlob('joined-first').size, first.length);
		assert.strictEqual(storedBlob('joined-second').size, second.length);
		assert.deepStrictEqual(await auditedBlobSizes('joined-second'), [second.length]);
	});

	it('when the commit replays its writes past an open read iterator', async () => {
		await StreamedBlobs.put({ id: 'iterator-seed-1', x: 0 });
		await StreamedBlobs.put({ id: 'iterator-seed-2', x: 0 });
		const payload = randomBytes(20000);
		const { blob, finish } = pendingBlob(payload);
		const context = {};
		let iterator;
		try {
			await within(
				transaction(context, async () => {
					iterator = StreamedBlobs.search([], context)[Symbol.asyncIterator]();
					assert(!(await iterator.next()).done, 'the iterator is outstanding at commit');
					StreamedBlobs.put({ id: 'iterator', x: 1, blob }, context);
					if (!isLMDB) {
						const readBack = await StreamedBlobs.get('iterator', context);
						StreamedBlobs.put({ id: 'iterator', x: 2, blob: readBack.blob }, context);
					}
					finish();
				}),
				'the commit past the iterator'
			);
			await within(
				(async () => {
					while (!(await iterator.next()).done);
				})(),
				'the iterator to drain'
			);
		} finally {
			await iterator?.return?.();
		}
		assert.strictEqual(storedBlob('iterator').size, payload.length);
		for (const size of await auditedBlobSizes('iterator')) assert.strictEqual(size, payload.length);
	});

	it('when the write commits on its own after its transaction closed', async function () {
		if (isLMDB) this.skip(); // LMDB has no per-write immediate handle
		const { Transaction } = require('@harperfast/rocksdb-js');
		const originalCommit = Transaction.prototype.commit;
		const targetDb = StreamedBlobs.primaryStore.store.db;
		let releaseScopeCommit;
		const scopeCommitGate = new Promise((resolve) => (releaseScopeCommit = resolve));
		let scopeCommitEntered;
		const enteredScopeCommit = new Promise((resolve) => (scopeCommitEntered = resolve));
		let gating = false;
		const immediateCommits = [];
		Transaction.prototype.commit = function (...args) {
			if (this.store?.db === targetDb) {
				if (this.immediateCommit) immediateCommits.push(this);
				else if (gating) {
					gating = false;
					scopeCommitEntered();
					return scopeCommitGate.then(() => originalCommit.apply(this, args));
				}
			}
			return originalCommit.apply(this, args);
		};
		let holder;
		try {
			await StreamedBlobs.put({ id: 'late', x: 0 });
			const payload = randomBytes(20000);
			const { blob, finish } = pendingBlob(payload);
			const context = {};
			const scope = transaction(context, async () => {
				holder = await StreamedBlobs.lock('late', { hold: true, lease: 15_000 }, context);
				await StreamedBlobs.put({ id: 'closed-scope', x: 1 }, context);
				gating = true;
			});
			await within(enteredScopeCommit, 'the scope commit to reach the gate');
			// the holder outlives the scope, so its save commits on its own handle
			holder.set('blob', blob);
			const late = holder.save();
			finish();
			await within(late, 'the late save');
			releaseScopeCommit();
			await within(scope, 'the scope commit');
			assert(immediateCommits.length > 0, 'test setup: the late write commits on an immediate handle');
			assert.strictEqual(storedBlob('late').size, payload.length);
			for (const size of await auditedBlobSizes('late')) assert.strictEqual(size, payload.length);
		} finally {
			Transaction.prototype.commit = originalCommit;
			releaseScopeCommit();
			await holder?.unlock?.();
		}
	});

	it('so a read of a self-consistently truncated file fails instead of returning it short', async () => {
		const payload = randomBytes(30000);
		const { blob, finish } = pendingBlob(payload);
		const putting = StreamedBlobs.put({ id: 'truncated', blob });
		finish();
		await putting;
		truncateConsistently(getFilePathForBlob(blob), 256);
		await assert.rejects(storedBlob('truncated').bytes(), (error) => {
			assert.strictEqual(error.statusCode, 500);
			assert.match(error.message, /size mismatch/);
			return true;
		});
	});
});

describe('Blob completeness checks compare the file with the descriptor size', () => {
	let CompletenessBlobs;
	before(() => {
		setupTestDBPath();
		setMainIsWorker(true);
		CompletenessBlobs = table({
			table: 'BlobDescriptorCompleteness',
			database: 'test',
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'blob', type: 'Blob' },
			],
		});
	});

	async function savedWithKnownSize(id, payload) {
		const blob = createBlob(Readable.from([payload]), { size: payload.length });
		await CompletenessBlobs.put({ id, blob });
		return CompletenessBlobs.primaryStore.getEntry(id, { uncachedRead: true }).value.blob;
	}

	it('isBlobComplete reports a file shorter than its descriptor as incomplete', async () => {
		const blob = await savedWithKnownSize('short', randomBytes(20000));
		assert.strictEqual(await isBlobComplete(blob), true);
		truncateConsistently(getFilePathForBlob(blob), 100);
		assert.strictEqual(await isBlobComplete(blob), false);
	});

	it('isBlobComplete still accepts a slice of a whole file', async () => {
		const blob = await savedWithKnownSize('sliced', randomBytes(20000));
		assert.strictEqual(await isBlobComplete(blob.slice(0, 10)), true);
		assert.strictEqual(await isBlobComplete(blob.slice(0, 0)), true);
	});

	it('findIncompleteBlobRefs yields a record whose file is shorter than its descriptor', async () => {
		await savedWithKnownSize('scan-whole', randomBytes(20000));
		const cut = await savedWithKnownSize('scan-cut', randomBytes(20000));
		truncateConsistently(getFilePathForBlob(cut), 100);
		const found = new Set();
		for await (const ref of findIncompleteBlobRefs({ BlobDescriptorCompleteness: CompletenessBlobs })) {
			found.add(ref.recordId);
		}
		assert(found.has('scan-cut'), 'the truncated record is reported');
		assert(!found.has('scan-whole'), 'the whole record is not');
	});
});
