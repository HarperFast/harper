require('../testUtils');
const assert = require('node:assert');
const { existsSync } = require('node:fs');
const { randomBytes } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
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
const REFERENCE_GENERATION = 1;

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
		const { table: holdState, slot } = getBlobHoldStateForTesting(
			UnauditedBlobs.primaryStore.rootStore,
			getFileId(entry.value.blob)
		);
		const beforeGeneration = Atomics.load(holdState, slot + REFERENCE_GENERATION);
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
			assert.equal(
				getBlobHoldStateForTesting(UnauditedBlobs.primaryStore.rootStore, getFileId(entry.value.blob))
					.pendingReclamation,
				false,
				'an abandoned eviction must not queue its blob for reclamation'
			);
		} finally {
			Transaction.prototype.commit = originalCommit;
		}
		await delay(RECLAMATION_SETTLE_MS);

		assert.ok(
			Atomics.load(holdState, slot + REFERENCE_GENERATION) > beforeGeneration,
			'competing write records its reference'
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
		const { table: holdState, slot } = getBlobHoldStateForTesting(
			UnauditedBlobs.primaryStore.rootStore,
			getFileId(entry.value.blob)
		);
		const beforeGeneration = Atomics.load(holdState, slot + REFERENCE_GENERATION);
		Transaction.prototype.commit = function (...args) {
			Transaction.prototype.commit = originalCommit;
			// lands between the eviction's commit and its blob cleanup
			return originalCommit
				.apply(this, args)
				.then((result) => UnauditedBlobs.put({ ...entry.value, tag: 'refilled' }).then(() => result));
		};
		try {
			await UnauditedBlobs.evict('refilled', entry.value, entry.version);
			assert.equal(
				getBlobHoldStateForTesting(UnauditedBlobs.primaryStore.rootStore, getFileId(entry.value.blob))
					.pendingReclamation,
				false,
				'an eviction must not queue a blob referenced by a subsequent write'
			);
		} finally {
			Transaction.prototype.commit = originalCommit;
		}
		await delay(RECLAMATION_SETTLE_MS);

		assert.equal(UnauditedBlobs.primaryStore.getEntry('refilled')?.value.tag, 'refilled');
		assert.ok(Atomics.load(holdState, slot + REFERENCE_GENERATION) > beforeGeneration, 'refill records its reference');
		assert.ok(existsSync(filePath));
	});

	it('removes the index keys of the record it removes when a resequenced write reused the version', async function () {
		if (process.env.HARPER_STORAGE_ENGINE === 'lmdb') return this.skip(); // only RocksDB resequences under a reused version
		// seeded without tag: remainingAgainstRecord drops an older plain assignment to a key the record holds
		await UnauditedBlobs.put({ id: 'resequenced' });
		const { version: baseVersion } = UnauditedBlobs.primaryStore.getEntry('resequenced');
		await UnauditedBlobs.patch('resequenced', { blob: null }, { timestamp: baseVersion + 100 });
		const read = UnauditedBlobs.primaryStore.getEntry('resequenced');
		await UnauditedBlobs.patch('resequenced', { tag: 'merged' }, { timestamp: baseVersion + 50 });
		const merged = UnauditedBlobs.primaryStore.getEntry('resequenced');
		const { VERSION_REUSED } = require('#src/resources/RecordEncoder');
		assert.ok(merged.metadataFlags & VERSION_REUSED, 'precondition: a real resequence marked the version reused');
		assert.equal(merged.version, read.version, 'precondition: the resequenced write kept the version the caller read');
		assert.equal(merged.value.tag, 'merged');
		assert.equal(read.value.tag, undefined, "precondition: the caller's copy lacks the merged index key");
		assert.equal(UnauditedBlobs.indices.tag.getValuesCount('merged'), 1, 'precondition: the merge indexed its tag');

		await UnauditedBlobs.evict('resequenced', read.value, read.version);
		const present = UnauditedBlobs.primaryStore.getEntry('resequenced') ? 1 : 0;
		assert.equal(
			UnauditedBlobs.indices.tag.getValuesCount('merged'),
			present,
			'the index must match the stored record'
		);
	});
});

describe('eviction keeps a record a same-version write changed after the eviction read it', function () {
	if (process.env.HARPER_STORAGE_ENGINE === 'lmdb') return; // only RocksDB rewrites a record under a reused version
	this.timeout(10000);
	const { VERSION_REUSED } = require('#src/resources/RecordEncoder');
	const { HAS_BLOBS } = require('#src/resources/auditStore');
	const LIVE = () => Date.now() + 60_000;
	const EXPIRED = () => Date.now() - 60_000;
	let tableCount = 0;

	before(function () {
		setupTestDBPath();
		setMainIsWorker(true);
		setDeletionDelay(0);
	});

	after(function () {
		setDeletionDelay(undefined);
	});

	function newTable() {
		return table({
			table: `EvictReusedVersion${tableCount++}`,
			database: 'test',
			audit: false,
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'tag', indexed: true },
				{ name: 'blob', type: 'Blob' },
			],
		});
	}

	// An older write that adds a key the record lacks merges under the record's version.
	async function resequence(Table, id, patch, expiresAt) {
		const read = Table.primaryStore.getEntry(id);
		await Table.patch(id, patch, { timestamp: read.version - 50, expiresAt });
		const merged = Table.primaryStore.getEntry(id);
		assert.equal(merged.version, read.version, 'precondition: the resequenced write kept the version');
		assert.ok(merged.metadataFlags & VERSION_REUSED, 'precondition: the version is marked reused');
		return { read, merged };
	}

	// The table's next internal evict() runs only once `write` has committed, so the write lands between the
	// caller's read and evict()'s own.
	function deferNextEvict(Table, write) {
		const evict = Table.evict;
		let deferred;
		Table.evict = function (...args) {
			Table.evict = evict;
			deferred = write().then(() => evict.apply(this, args));
			return deferred;
		};
		return {
			settled: () =>
				waitFor(() => deferred !== undefined, { message: 'the caller must call evict()' }).then(() => deferred),
			restore: () => (Table.evict = evict),
		};
	}

	// The cleanup scan's next pass reads `entries` as they were before a later write committed.
	function scanReadsBefore(Table, entries) {
		const getRange = Table.primaryStore.getRange;
		let served = false;
		Table.primaryStore.getRange = function (options) {
			if (!options?.lazy) return getRange.apply(this, arguments);
			if (served) return [];
			served = true;
			return entries.map(({ key, value, version, expiresAt, metadataFlags }) => ({
				key,
				value,
				version,
				expiresAt,
				metadataFlags,
			}));
		};
		Table.setTTLExpiration({ expiration: 0.005, eviction: 0.005 });
		return () => {
			Table.setTTLExpiration({ expiration: 3600 });
			Table.primaryStore.getRange = getRange;
		};
	}

	function rereferenced(Table, blob) {
		const { table: holdState, slot } = getBlobHoldStateForTesting(Table.primaryStore.rootStore, getFileId(blob));
		return Atomics.load(holdState, slot + REREFERENCED);
	}

	it('evict() keeps a record whose expiry a resequenced write renewed from the table expiration', async function () {
		const Table = newTable();
		Table.setTTLExpiration({ expiration: 60, eviction: 3600 }); // nothing becomes evictable to the scan here
		const blob = await createBlob(randomBytes(20000));
		await Table.put('renewed', { id: 'renewed', blob }, { expiresAt: EXPIRED() });
		const filePath = getFilePathForBlob(blob);
		const { read, merged } = await resequence(Table, 'renewed', { tag: 'merged' });
		assert.ok(merged.expiresAt > Date.now() + 50_000, 'precondition: the merge took a fresh table expiration');

		await Table.evict('renewed', read.value, read.version, undefined, read.expiresAt);
		await delay(RECLAMATION_SETTLE_MS);
		assert.equal(Table.primaryStore.getEntry('renewed')?.value.tag, 'merged', 'the renewed record must survive');
		assert.equal(Table.indices.tag.getValuesCount('merged'), 1, "the renewed record's index entry must survive");
		assert.ok(existsSync(filePath), "the renewed record's blob file must survive");

		await Table.evict('renewed', merged.value, merged.version, undefined, merged.expiresAt);
		assert.equal(Table.primaryStore.getEntry('renewed'), undefined, 'a reused version with its read expiry evicts');
		assert.equal(Table.indices.tag.getValuesCount('merged'), 0);
		await waitFor(() => !existsSync(filePath), { message: 'the eviction reclaims the blob of the record it removed' });
	});

	it('evict() tells an observed absence of expiry from an omitted one', async function () {
		const Table = newTable();
		await Table.put('gained-expiry', { id: 'gained-expiry' });
		const { read } = await resequence(Table, 'gained-expiry', { tag: 'merged' }, LIVE());
		assert.equal(read.expiresAt, undefined, 'precondition: the read record had no expiry');

		await Table.evict('gained-expiry', read.value, read.version, undefined, null);
		assert.equal(Table.primaryStore.getEntry('gained-expiry')?.value.tag, 'merged', 'a gained expiry is a change');
		await Table.evict('gained-expiry', read.value, read.version);
		assert.equal(Table.primaryStore.getEntry('gained-expiry'), undefined, 'omitted, only the version is checked');
	});

	it('evict() keeps a cached record a revalidation renewed under an unchanged source version', async function () {
		const Table = newTable();
		const sourceVersion = Date.now() - 10_000;
		let sourceExpiresAt = EXPIRED();
		Table.sourcedFrom({
			get(id, context) {
				context.lastModified = sourceVersion;
				context.expiresAt = sourceExpiresAt;
				return { id, tag: 'cached' };
			},
		});
		await Table.get('revalidated');
		await waitFor(() => Table.primaryStore.getEntry('revalidated') && !Table.primaryStore.hasLock('revalidated'), {
			message: 'the first fill must commit',
		});
		const read = Table.primaryStore.getEntry('revalidated');
		sourceExpiresAt = LIVE();
		await Table.get('revalidated');
		await waitFor(
			() =>
				Table.primaryStore.getEntry('revalidated')?.expiresAt === sourceExpiresAt &&
				!Table.primaryStore.hasLock('revalidated'),
			{ message: 'the revalidation must commit' }
		);
		const revalidated = Table.primaryStore.getEntry('revalidated');
		assert.equal(revalidated.version, read.version, 'precondition: the revalidation kept the source version');
		assert.ok(revalidated.metadataFlags & VERSION_REUSED, 'precondition: the version is marked reused');

		await Table.evict('revalidated', read.value, read.version, undefined, read.expiresAt);
		assert.ok(Table.primaryStore.getEntry('revalidated'), 'the revalidated record must survive');
		assert.equal(Table.indices.tag.getValuesCount('cached'), 1);
		await Table.evict('revalidated', revalidated.value, revalidated.version, undefined, revalidated.expiresAt);
		assert.equal(
			Table.primaryStore.getEntry('revalidated'),
			undefined,
			'an eviction of what is stored still removes it'
		);
	});

	it('the read-path expiry check hands evict() the expiry it read', async function () {
		const Table = newTable();
		await Table.put('read', { id: 'read' }, { expiresAt: EXPIRED() });
		const deferred = deferNextEvict(Table, () => resequence(Table, 'read', { tag: 'merged' }, LIVE()));
		try {
			assert.equal(await Table.get('read'), null, 'precondition: the read saw the expired record');
			await deferred.settled();
		} finally {
			deferred.restore();
		}
		assert.equal(Table.primaryStore.getEntry('read')?.value.tag, 'merged', 'the renewed record must survive');
	});

	it("the cleanup scan's per-record path hands evict() the expiry it read", async function () {
		const Table = newTable();
		const blob = await createBlob(randomBytes(20000));
		await Table.put('scanned', { id: 'scanned', blob }, { expiresAt: EXPIRED() }); // a blob routes it per record
		const filePath = getFilePathForBlob(blob);
		const deferred = deferNextEvict(Table, () => resequence(Table, 'scanned', { tag: 'merged' }, LIVE()));
		Table.setTTLExpiration({ expiration: 0.005, eviction: 0.005 });
		try {
			await deferred.settled();
		} finally {
			Table.setTTLExpiration({ expiration: 3600 });
			deferred.restore();
		}
		await delay(RECLAMATION_SETTLE_MS);
		assert.equal(Table.primaryStore.getEntry('scanned')?.value.tag, 'merged', 'the renewed record must survive');
		assert.ok(existsSync(filePath), "the renewed record's blob file must survive");
	});

	it('the cleanup scan batch keeps a record renewed before staging and evicts one whose expiry held', async function () {
		const Table = newTable();
		const expiresAt = EXPIRED();
		await Table.put('renewed', { id: 'renewed' }, { expiresAt });
		await Table.put('held', { id: 'held' }, { expiresAt });
		await Table.put('unchanged', { id: 'unchanged' }, { expiresAt });
		const { read: renewedRead } = await resequence(Table, 'renewed', { tag: 'merged' }, LIVE());
		const { read: heldRead, merged: heldMerged } = await resequence(Table, 'held', { tag: 'held' }, expiresAt);
		assert.equal(heldMerged.expiresAt, heldRead.expiresAt, 'precondition: the expiry held');
		const restore = scanReadsBefore(Table, [renewedRead, heldRead, Table.primaryStore.getEntry('unchanged')]);
		try {
			await waitFor(() => !Table.primaryStore.getEntry('unchanged'), {
				message: 'the scan must evict the unchanged record batched with the others',
			});
		} finally {
			restore();
		}
		assert.equal(Table.primaryStore.getEntry('renewed')?.value.tag, 'merged', 'the renewed record must survive');
		assert.equal(Table.indices.tag.getValuesCount('merged'), 1, "the renewed record's index entry must survive");
		assert.equal(Table.primaryStore.getEntry('held'), undefined, 'a reused version whose expiry held is evicted');
		assert.equal(Table.indices.tag.getValuesCount('held'), 0);
	});

	it('the cleanup scan batch keeps a record renewed between staging and commit', async function () {
		const { Transaction } = require('@harperfast/rocksdb-js');
		const originalCommit = Transaction.prototype.commit;
		const Table = newTable();
		await Table.put('renewed', { id: 'renewed' }, { expiresAt: EXPIRED() });
		await Table.put('unchanged', { id: 'unchanged' }, { expiresAt: EXPIRED() });
		let conflicted;
		Transaction.prototype.commit = function (...args) {
			if (this.store !== Table.primaryStore.store || Table.primaryStore.getEntry('renewed', { transaction: this }))
				return originalCommit.apply(this, args);
			Transaction.prototype.commit = originalCommit;
			return resequence(Table, 'renewed', { tag: 'merged' }, LIVE()).then(() =>
				originalCommit.apply(this, args).catch((error) => {
					conflicted = error.code;
					throw error;
				})
			);
		};
		const restore = scanReadsBefore(Table, [
			Table.primaryStore.getEntry('renewed'),
			Table.primaryStore.getEntry('unchanged'),
		]);
		try {
			await waitFor(() => !Table.primaryStore.getEntry('unchanged'), {
				message: 'the retried batch must evict the unchanged record',
			});
		} finally {
			Transaction.prototype.commit = originalCommit;
			restore();
		}
		assert.equal(conflicted, 'ERR_BUSY', 'precondition: the write between staging and commit conflicted');
		assert.equal(Table.primaryStore.getEntry('renewed')?.value.tag, 'merged', 'the retry must keep the renewed record');
		assert.equal(Table.indices.tag.getValuesCount('merged'), 1);
	});

	it('an abandoned eviction batch keeps the blob of a record that gained one at the same expiry', async function () {
		const { Transaction } = require('@harperfast/rocksdb-js');
		const originalCommit = Transaction.prototype.commit;
		const Table = newTable();
		const expiresAt = EXPIRED();
		await Table.put('gained', { id: 'gained' }, { expiresAt });
		await Table.put('unchanged', { id: 'unchanged' }, { expiresAt });
		const unchanged = Table.primaryStore.getEntry('unchanged');
		const blob = await createBlob(randomBytes(20000));
		// the same expiry, so only the blob tells the scanned record and the stored one apart
		const { read, merged } = await resequence(Table, 'gained', { blob }, expiresAt);
		assert.ok(merged.metadataFlags & HAS_BLOBS, 'precondition: the resequenced write added a blob');
		assert.equal(merged.expiresAt, read.expiresAt, 'precondition: the expiry is unchanged');
		const filePath = getFilePathForBlob(blob);
		assert.ok(filePath && existsSync(filePath), 'precondition: the blob is file-backed');
		assert.equal(rereferenced(Table, blob), 1, 'precondition: the write that references the file marked it');

		let conflicts = 0;
		Transaction.prototype.commit = function (...args) {
			const stagesBatch =
				this.store === Table.primaryStore.store &&
				Table.primaryStore.getEntry('unchanged', { transaction: this }) === undefined &&
				Table.primaryStore.getEntry('unchanged') !== undefined;
			if (!stagesBatch) return originalCommit.apply(this, args);
			conflicts++;
			const error = new Error('injected optimistic conflict');
			error.code = 'ERR_BUSY';
			return Promise.reject(error);
		};
		const restore = scanReadsBefore(Table, [read, unchanged]);
		try {
			await waitFor(() => conflicts >= 2, { message: 'the first batch commit and its one retry must conflict' });
		} finally {
			Transaction.prototype.commit = originalCommit;
			restore();
		}
		await delay(RECLAMATION_SETTLE_MS);
		assert.ok(Table.primaryStore.getEntry('unchanged'), 'the abandoned batch removed nothing');
		assert.equal(getFileId(Table.primaryStore.getEntry('gained')?.value.blob), getFileId(blob));
		// queue-independent: queueing a reclamation clears the re-reference
		assert.equal(rereferenced(Table, blob), 1, 'the abandoned batch must not queue the blob for reclamation');
		assert.ok(existsSync(filePath), 'an abandoned batch must not reclaim the blob of a record it left in place');
	});
});
