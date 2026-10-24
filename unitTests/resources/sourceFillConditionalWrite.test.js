require('../testUtils');
const assert = require('assert');
const { PassThrough } = require('node:stream');
const { existsSync } = require('node:fs');
const { setTimeout: delay } = require('node:timers/promises');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { INVALIDATED } = require('#src/resources/Table');
const { transaction } = require('#src/resources/transaction');
const { createBlob, getFilePathForBlob, setDeletionDelay } = require('#src/resources/blob');
const { waitFor } = require('../waitFor.js');

// Source fills that race a local write, on both storage engines: caching.test.js still skips LMDB
// (harper#414).
describe('Source fill racing a local write', function () {
	this.timeout(20000);
	const isLMDB = process.env.HARPER_STORAGE_ENGINE === 'lmdb';
	let FillTable;
	let sourceRequest;
	before(function () {
		setupTestDBPath();
		setMainIsWorker(true);
		// reclamation runs in queue order, so one default-delay deletion would hold up every later one
		setDeletionDelay(0);
		FillTable = table({
			table: 'SourceFillRace',
			database: 'test',
			audit: true,
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'name', indexed: true }, { name: 'payload' }],
		});
		FillTable.sourcedFrom({
			get(id, context) {
				return new Promise((respond) => {
					sourceRequest = { id, context, respond };
				});
			},
		});
	});
	after(() => setDeletionDelay(undefined));
	afterEach(() => {
		// a failed test must not leave a fill holding its record lock for the next one
		sourceRequest?.respond(undefined);
		sourceRequest = null;
	});

	const indexCount = (name) => FillTable.indices.name.getValuesCount(name);
	const settles = (promise, what) =>
		Promise.race([promise, delay(5000, undefined, { ref: false }).then(() => assert.fail(`${what} never settled`))]);
	const committed = (id) =>
		waitFor(() => !FillTable.primaryStore.hasLock(id), { timeout: 5000, message: 'the fill never committed' });
	async function auditOf(id) {
		const entries = [];
		for await (const entry of FillTable.getHistory()) {
			if (entry.id === id) entries.push(`${entry.type}:${entry.value?.name}`);
		}
		return entries;
	}
	// RocksDB writes a commit attempt's log entries even when the attempt conflicts
	// (DatabaseTransaction.save), so a fill discarded on retry leaves its first attempt's entry there.
	async function assertAuditedAsLocal(id) {
		const audit = await auditOf(id);
		assert(audit.includes('put:local ' + id), `the local write was not audited: ${audit}`);
		if (isLMDB) assert.equal(audit.at(-1), 'put:local ' + id);
	}
	function assertStoredAsLocal(id, local) {
		const entry = FillTable.primaryStore.getEntry(id);
		assert.equal(entry.value.name, 'local ' + id);
		assert.equal(entry.version, local.version);
		assert(!(entry.metadataFlags & INVALIDATED));
		assert.equal(indexCount('local ' + id), 1);
		assert.equal(indexCount('source ' + id), 0);
		assert.equal(indexCount('seed ' + id), 0);
	}
	async function seedInvalidated(id) {
		await FillTable.put(id, { id, name: 'seed ' + id });
		await FillTable.invalidate(id);
		await waitFor(() => FillTable.primaryStore.getEntry(id)?.metadataFlags & INVALIDATED);
		return FillTable.primaryStore.getEntry(id);
	}
	async function startFill(id) {
		sourceRequest = null;
		const fill = FillTable.get(id);
		fill.catch(() => {});
		await waitFor(() => sourceRequest?.id === id);
		// wrapped: returning the pending read from this async function would wait for it
		return { fill: settles(fill, 'the read') };
	}
	function respond(value) {
		const request = sourceRequest;
		sourceRequest = null;
		request.respond(value);
	}
	async function localWrite(id) {
		const context = {};
		await transaction(context, () => FillTable.put(id, { id, name: 'local ' + id }, context));
		return FillTable.primaryStore.getEntry(id);
	}
	async function respondWithHeldBlob(id) {
		const body = new PassThrough();
		const payload = createBlob(body);
		respond({ id, name: 'source ' + id, payload });
		body.write(Buffer.alloc(1000, 1));
		await waitFor(() => getFilePathForBlob(payload) && existsSync(getFilePathForBlob(payload)), {
			message: 'the fill never started saving its blob',
		});
		return { blobPath: getFilePathForBlob(payload), release: () => body.end(Buffer.alloc(1000, 2)), body };
	}

	it('writes the resolved record over the invalidation in the audit log', async function () {
		const id = 'resolved-audit';
		await seedInvalidated(id);
		const { fill } = await startFill(id);
		respond({ id, name: 'source ' + id });
		assert.equal((await fill).name, 'source ' + id);
		await committed(id);
		const entry = FillTable.primaryStore.getEntry(id);
		assert.equal(entry.value.name, 'source ' + id);
		assert(!(entry.metadataFlags & INVALIDATED));
		assert.equal((await auditOf(id)).at(-1), 'put:source ' + id);
		const head = (await FillTable.getHistoryOfRecord(id)).at(-1);
		assert.equal(head.type, 'put');
		assert.equal(head.version, entry.version);
		assert.equal(head.value.name, 'source ' + id);
		assert.equal(indexCount('source ' + id), 1);
		assert.equal(indexCount('seed ' + id), 0);
	});

	it('keeps a local write that commits while the fill waits on its blob save', async function () {
		const id = 'held-in-precommit';
		await seedInvalidated(id);
		const { fill } = await startFill(id);
		const held = await respondWithHeldBlob(id);
		assert.equal((await fill).name, 'source ' + id);
		assert(FillTable.primaryStore.hasLock(id), 'the fill should still be waiting on its blob save');
		const local = await localWrite(id);
		held.release();
		await committed(id);
		assertStoredAsLocal(id, local);
		await assertAuditedAsLocal(id);
		// on RocksDB the conflicted first attempt's log entry may still name the file
		if (isLMDB)
			await waitFor(() => !existsSync(held.blobPath), { message: "the discarded fill's blob file was never deleted" });
	});

	it('releases the record when the blob save fails, so a later read fills it', async function () {
		const id = 'failed-precommit';
		await seedInvalidated(id);
		const { fill } = await startFill(id);
		const held = await respondWithHeldBlob(id);
		assert.equal((await fill).name, 'source ' + id);
		held.body.destroy(new Error('source body failed'));
		await committed(id);
		assert(FillTable.primaryStore.getEntry(id).metadataFlags & INVALIDATED);
		const retry = await startFill(id);
		respond({ id, name: 'retried ' + id });
		assert.equal((await retry.fill).name, 'retried ' + id);
		await committed(id);
		assert.equal(FillTable.primaryStore.getEntry(id).value.name, 'retried ' + id);
		assert.equal(indexCount('retried ' + id), 1);
	});

	it('removes an invalidated record its source reports missing', async function () {
		const id = 'missing';
		await seedInvalidated(id);
		const { fill } = await startFill(id);
		respond(undefined);
		assert.equal(await fill, undefined);
		await committed(id);
		assert.equal(FillTable.primaryStore.getEntry(id)?.value ?? undefined, undefined);
		assert.equal(indexCount('seed ' + id), 0);
		assert.equal((await auditOf(id)).at(-1), 'delete:undefined');
	});

	it('keeps a local write that races a source miss for an invalidated record', async function () {
		const id = 'missing-raced';
		await seedInvalidated(id);
		const { fill } = await startFill(id);
		const local = await localWrite(id);
		respond(undefined);
		assert.equal(await fill, undefined);
		await committed(id);
		assertStoredAsLocal(id, local);
		await assertAuditedAsLocal(id);
	});

	// The source's own write to the key joins the fill's transaction ahead of the fill, so no version check
	// between transactions can see it.
	for (const invalidated of [true, false]) {
		it(`keeps a write the source makes to the key it is resolving (${invalidated ? 'invalidated' : 'first fill'})`, async function () {
			const id = invalidated ? 'source-writes-invalidated' : 'source-writes-first';
			if (invalidated) await seedInvalidated(id);
			const { primaryStore } = FillTable;
			const originalIfVersion = primaryStore.ifVersion;
			let conditions = 0;
			if (isLMDB)
				primaryStore.ifVersion = function (key, ...rest) {
					if (key === id) conditions++;
					return originalIfVersion.call(this, key, ...rest);
				};
			try {
				const { fill } = await startFill(id);
				await FillTable.put(id, { id, name: 'local ' + id }, sourceRequest.context);
				respond({ id, name: 'source ' + id });
				assert.equal((await fill).name, 'source ' + id);
				await committed(id);
			} finally {
				primaryStore.ifVersion = originalIfVersion;
			}
			if (isLMDB) assert(conditions >= 2, `expected the optimistic path, saw ${conditions} conditions`);
			const entry = FillTable.primaryStore.getEntry(id);
			assert.equal(entry.value.name, 'local ' + id);
			assert.equal(indexCount('local ' + id), 1);
			assert.equal(indexCount('source ' + id), 0);
			assert.equal(indexCount('seed ' + id), 0);
			const audit = await auditOf(id);
			assert.equal(audit.at(-1), 'put:local ' + id);
			assert(!audit.includes('put:source ' + id), `the discarded fill was audited: ${audit}`);
		});
	}

	// update() defers staging to commit on RocksDB, so it has not run when the fill decides
	it('keeps an update the source makes to the key it is resolving', async function () {
		const id = 'source-updates';
		await seedInvalidated(id);
		const { fill } = await startFill(id);
		await FillTable.update(id, { name: 'local ' + id }, sourceRequest.context);
		respond({ id, name: 'source ' + id, payload: 'from source' });
		assert.equal((await fill).name, 'source ' + id);
		await committed(id);
		const entry = FillTable.primaryStore.getEntry(id);
		assert.equal(entry.value?.name, 'local ' + id);
		assert.equal(entry.value?.payload, undefined, 'the update merged onto the source record');
		assert.equal(indexCount('local ' + id), 1);
		assert.equal(indexCount('source ' + id), 0);
		const audit = await auditOf(id);
		assert(!audit.includes('put:source ' + id), `the discarded fill was audited: ${audit}`);
	});

	it('leaves the record invalidated when the source invalidates the key it is resolving', async function () {
		const id = 'source-invalidates';
		await seedInvalidated(id);
		const { fill } = await startFill(id);
		await FillTable.invalidate(id, sourceRequest.context);
		respond({ id, name: 'source ' + id });
		assert.equal((await fill).name, 'source ' + id);
		await committed(id);
		assert(FillTable.primaryStore.getEntry(id).metadataFlags & INVALIDATED);
		assert.equal(indexCount('source ' + id), 0);
		assert(!(await auditOf(id)).includes('put:source ' + id));
	});

	// a publish restamps the record without staging one
	it('keeps the version a publish the source makes to the key it is resolving', async function () {
		const id = 'source-publishes';
		const invalidated = await seedInvalidated(id);
		const { fill } = await startFill(id);
		const { context } = sourceRequest;
		await FillTable.publish(id, { note: 'published' }, context);
		context.lastModified = context.replacingVersion;
		respond({ id, name: 'source ' + id });
		assert.equal((await fill).name, 'source ' + id);
		await committed(id);
		const entry = FillTable.primaryStore.getEntry(id);
		assert(entry.version > invalidated.version, 'the fill regressed the version the publish stored');
		assert.notEqual(entry.value?.name, 'source ' + id);
		assert.equal(indexCount('source ' + id), 0);
	});

	it('fills over a write the source makes that is itself discarded as stale', async function () {
		const id = 'source-write-skipped';
		const future = Date.now() + 60_000;
		await transaction({ timestamp: future }, (txn) => FillTable.put(id, { id, name: 'seed ' + id }, txn));
		await transaction({ timestamp: future + 1 }, (txn) => FillTable.invalidate(id, txn));
		await waitFor(() => FillTable.primaryStore.getEntry(id)?.metadataFlags & INVALIDATED);
		const { fill } = await startFill(id);
		await FillTable.put(id, { id, name: 'stale ' + id }, sourceRequest.context);
		respond({ id, name: 'source ' + id });
		assert.equal((await fill).name, 'source ' + id);
		await committed(id);
		assert.equal(FillTable.primaryStore.getEntry(id).value.name, 'source ' + id);
		assert.equal(indexCount('source ' + id), 1);
		assert.equal(indexCount('stale ' + id), 0);
		assert.equal(indexCount('seed ' + id), 0);
	});

	describe('LMDB conditional batch', function () {
		before(function () {
			if (!isLMDB) this.skip();
		});

		// The fill's primary and audit puts must be staged inside the ifVersion block that conditions them on
		// the version they replace: the block is one native write transaction, so nothing commits in between.
		it('stages the primary and audit puts inside the version-conditioned block', async function () {
			const id = 'batch-boundary';
			const invalidated = await seedInvalidated(id);
			const { primaryStore } = FillTable;
			const { auditStore } = primaryStore.rootStore;
			const conditions = [];
			const puts = [];
			const originalIfVersion = primaryStore.ifVersion;
			const originalPut = primaryStore.put;
			const originalAuditPut = auditStore.put;
			primaryStore.ifVersion = function (key, version, callback, options) {
				if (key !== id) return originalIfVersion.call(this, key, version, callback, options);
				const condition = { version, open: true };
				conditions.push(condition);
				return originalIfVersion.call(
					this,
					key,
					version,
					function () {
						try {
							return callback.apply(this, arguments);
						} finally {
							condition.open = false;
						}
					},
					options
				);
			};
			const recordPut = (store) =>
				function (key, value, options) {
					puts.push({ store, key, value, inBlock: conditions.some((condition) => condition.open), options });
					return (store === 'audit' ? originalAuditPut : originalPut).apply(this, arguments);
				};
			primaryStore.put = recordPut('primary');
			auditStore.put = recordPut('audit');
			try {
				const { fill } = await startFill(id);
				respond({ id, name: 'source ' + id });
				await fill;
				await committed(id);
			} finally {
				primaryStore.ifVersion = originalIfVersion;
				primaryStore.put = originalPut;
				auditStore.put = originalAuditPut;
			}
			assert.deepEqual(
				conditions.map((condition) => condition.version),
				[invalidated.version]
			);
			const primaryPut = puts.find((put) => put.store === 'primary' && put.key === id);
			assert(primaryPut?.inBlock, 'the primary put ran outside the conditional block');
			const auditPut = puts.find((put) => put.store === 'audit' && put.value?.recordId === id);
			assert(auditPut?.inBlock, 'the audit put ran outside the conditional block');
			assert.equal(FillTable.primaryStore.getEntry(id).value.name, 'source ' + id);
		});

		// With the invalidation's audit entry pruned, the fill appends one under a newly assigned local time; the
		// last assigned time it would otherwise be keyed by belongs to the other record's write.
		it('appends the resolved audit entry under its own key when the invalidation entry is gone', async function () {
			const id = 'append-audit';
			const otherId = 'append-audit-other';
			const invalidated = await seedInvalidated(id);
			const { auditStore } = FillTable.primaryStore.rootStore;
			await auditStore.remove(invalidated.localTime);
			await FillTable.put(otherId, { id: otherId, name: 'other ' + otherId });
			const { fill } = await startFill(id);
			respond({ id, name: 'source ' + id });
			await fill;
			await committed(id);
			assert.deepEqual(await auditOf(otherId), ['put:other ' + otherId]);
			assert.equal((await FillTable.getHistoryOfRecord(otherId)).at(-1).value.name, 'other ' + otherId);
			const entry = FillTable.primaryStore.getEntry(id);
			assert.notEqual(entry.localTime, invalidated.localTime);
			const head = (await FillTable.getHistoryOfRecord(id)).at(-1);
			assert.equal(head.type, 'put');
			assert.equal(head.version, entry.version);
			assert.equal(head.value.name, 'source ' + id);
		});

		it('discards a fill whose condition read is overtaken by a committed write', async function () {
			const id = 'stale-condition';
			const invalidated = await seedInvalidated(id);
			const { fill } = await startFill(id);
			const held = await respondWithHeldBlob(id);
			await fill;
			const local = await localWrite(id);
			const { primaryStore } = FillTable;
			const originalGetEntry = primaryStore.getEntry;
			let staleReads = 0;
			// the condition read takes no options; hand it the invalidated entry the write already replaced
			primaryStore.getEntry = function (key, options) {
				if (key === id && options === undefined && staleReads === 0) {
					staleReads++;
					return invalidated;
				}
				return originalGetEntry.call(this, key, options);
			};
			try {
				held.release();
				await committed(id);
			} finally {
				primaryStore.getEntry = originalGetEntry;
			}
			assert.equal(staleReads, 1, 'the condition read was not intercepted');
			assertStoredAsLocal(id, local);
			await assertAuditedAsLocal(id);
			await waitFor(() => !existsSync(held.blobPath), { message: "the discarded fill's blob file was never deleted" });
		});
	});

	describe('RocksDB transaction conflict', function () {
		before(function () {
			if (isLMDB) this.skip();
		});

		it('discards a fill whose transaction is overtaken by a committed write', async function () {
			const id = 'rocks-conflict';
			await seedInvalidated(id);
			const { Transaction } = require('@harperfast/rocksdb-js');
			const originalCommit = Transaction.prototype.commit;
			const { primaryStore } = FillTable;
			const originalGetEntry = primaryStore.getEntry;
			let fillTransaction;
			let local;
			let intercepted = false;
			primaryStore.getEntry = function (key, options) {
				if (!intercepted && key === id && options?.transaction) fillTransaction = options.transaction;
				return originalGetEntry.call(this, key, options);
			};
			Transaction.prototype.commit = function (...args) {
				if (!intercepted && this === fillTransaction) {
					intercepted = true;
					return localWrite(id).then((entry) => {
						local = entry;
						return originalCommit.apply(this, args);
					});
				}
				return originalCommit.apply(this, args);
			};
			try {
				const { fill } = await startFill(id);
				respond({ id, name: 'source ' + id });
				assert.equal((await fill).name, 'source ' + id);
				await waitFor(() => intercepted && !FillTable.primaryStore.hasLock(id), {
					message: 'the fill never committed',
				});
			} finally {
				Transaction.prototype.commit = originalCommit;
				primaryStore.getEntry = originalGetEntry;
			}
			assertStoredAsLocal(id, local);
			await assertAuditedAsLocal(id);
		});
	});
});
