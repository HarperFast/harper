require('../testUtils');
const assert = require('assert');
const { existsSync } = require('fs');
const { randomBytes } = require('crypto');
const { setTimeout: delay } = require('timers/promises');
const { setupTestDBPath } = require('../testUtils');
const { waitFor } = require('../waitFor.js');
const { table } = require('#src/resources/databases');
const {
	createBlob,
	getFileId,
	getFilePathForBlob,
	getBlobHoldStateForTesting,
	setDeletionDelay,
} = require('#src/resources/blob');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');

// Long enough for a zero-delay reclamation queued by a wrong eviction to have unlinked its file, unless
// entries left by earlier tests hold the shared queue's tail back.
const RECLAMATION_SETTLE_MS = 200;
const REREFERENCED = 1; // hold-state slot offset, resources/blob.ts

describe('evict() leaves a renewed record and its blobs intact', function () {
	this.timeout(10000);
	let UnauditedBlobs;

	before(function () {
		setupTestDBPath();
		setMainIsWorker(true);
		setDeletionDelay(0);
		UnauditedBlobs = table({
			table: 'EvictUnauditedBlobs',
			database: 'test',
			audit: false,
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'tag', indexed: true },
				{ name: 'blob', type: 'Blob' },
			],
		});
	});

	after(function () {
		setDeletionDelay(undefined);
	});

	async function putWithBlob(id, tag, blob) {
		blob ??= await createBlob(randomBytes(20000)); // over the file-storage threshold
		await UnauditedBlobs.put({ id, tag, blob });
		const filePath = getFilePathForBlob(blob);
		assert.ok(filePath && existsSync(filePath), 'precondition: the blob is file-backed');
		return { entry: UnauditedBlobs.primaryStore.getEntry(id), filePath };
	}

	it('skips a version renewed after the caller read it, without a source or audit log', async function () {
		const read = await putWithBlob('renewed', 'v1');
		const renewed = await putWithBlob('renewed', 'v2');
		await UnauditedBlobs.evict('renewed', read.entry.value, read.entry.version);
		await delay(RECLAMATION_SETTLE_MS);

		assert.equal(UnauditedBlobs.primaryStore.getEntry('renewed')?.value.tag, 'v2', 'the renewed record must survive');
		assert.equal(UnauditedBlobs.indices.tag.getValuesCount('v2'), 1, "the renewed record's index entry must survive");
		assert.ok(existsSync(renewed.filePath), "the renewed record's blob file must survive");

		await UnauditedBlobs.evict('renewed', renewed.entry.value, renewed.entry.version);
		assert.equal(UnauditedBlobs.primaryStore.getEntry('renewed'), undefined);
		assert.equal(UnauditedBlobs.indices.tag.getValuesCount('v2'), 0);
		await waitFor(() => !existsSync(renewed.filePath), {
			message: 'an eviction of the live version reclaims its blob',
		});
		await UnauditedBlobs.evict('renewed', renewed.entry.value, renewed.entry.version);
	});

	it('keeps the blob file when its eviction loses a commit conflict', async function () {
		if (process.env.HARPER_STORAGE_ENGINE === 'lmdb') return this.skip(); // LMDB writes have no commit conflict
		const { Transaction } = require('@harperfast/rocksdb-js');
		const originalCommit = Transaction.prototype.commit;
		const { entry, filePath } = await putWithBlob('contended', 'resident');
		// A competing write keeps the same blob. It has encoded (re-referencing the file) and is committing
		// when the eviction reads and stages; the eviction's commit then lands after it and conflicts.
		let eviction;
		let evictionCommit;
		Transaction.prototype.commit = function (...args) {
			let competingCommitted;
			const competing = new Promise((resolve) => (competingCommitted = resolve));
			Transaction.prototype.commit = function (...evictionArgs) {
				Transaction.prototype.commit = originalCommit;
				evictionCommit = competing.then(() => originalCommit.apply(this, evictionArgs));
				return evictionCommit;
			};
			eviction = UnauditedBlobs.evict('contended', entry.value, entry.version);
			const committing = originalCommit.apply(this, args);
			committing.then(competingCommitted, competingCommitted);
			return committing;
		};
		try {
			await UnauditedBlobs.put({ ...entry.value, tag: 'competing' });
			assert.ok(eviction, 'the eviction must run inside the competing commit');
			await eviction;
		} finally {
			Transaction.prototype.commit = originalCommit;
		}
		await delay(RECLAMATION_SETTLE_MS);

		// Queue-independent: queueing a reclamation clears the re-reference the competing write recorded.
		const { table: holdState, slot } = getBlobHoldStateForTesting(
			UnauditedBlobs.primaryStore.rootStore,
			getFileId(entry.value.blob)
		);
		assert.equal(
			Atomics.load(holdState, slot + REREFERENCED),
			1,
			"an abandoned eviction must not queue the competing write's blob for reclamation"
		);
		await assert.rejects(
			evictionCommit,
			{ code: 'ERR_BUSY' },
			'the eviction commit must conflict with the competing write'
		);
		assert.equal(UnauditedBlobs.primaryStore.getEntry('contended')?.value.tag, 'competing');
		assert.ok(
			existsSync(filePath),
			'an abandoned eviction must not reclaim the blob the competing write still references'
		);
	});

	it('keeps a blob file that a write committed after the eviction references again', async function () {
		if (process.env.HARPER_STORAGE_ENGINE === 'lmdb') return this.skip(); // exercises the RocksDB post-commit step
		const { Transaction } = require('@harperfast/rocksdb-js');
		const originalCommit = Transaction.prototype.commit;
		const { entry, filePath } = await putWithBlob('refilled', 'resident');
		Transaction.prototype.commit = function (...args) {
			Transaction.prototype.commit = originalCommit;
			// lands between the eviction's commit and its blob cleanup
			return originalCommit
				.apply(this, args)
				.then((result) => UnauditedBlobs.put({ ...entry.value, tag: 'refilled' }).then(() => result));
		};
		try {
			await UnauditedBlobs.evict('refilled', entry.value, entry.version);
		} finally {
			Transaction.prototype.commit = originalCommit;
		}
		await delay(RECLAMATION_SETTLE_MS);

		const { table: holdState, slot } = getBlobHoldStateForTesting(
			UnauditedBlobs.primaryStore.rootStore,
			getFileId(entry.value.blob)
		);
		assert.equal(UnauditedBlobs.primaryStore.getEntry('refilled')?.value.tag, 'refilled');
		assert.equal(Atomics.load(holdState, slot + REREFERENCED), 1, 'the refilled record keeps its blob file');
		assert.ok(existsSync(filePath));
	});
});
