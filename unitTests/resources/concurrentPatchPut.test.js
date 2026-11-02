const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#src/server/threads/manageThreads');
const { transaction } = require('#src/resources/transaction');

describe('Concurrent PATCH/PUT with a pending audit frame', function () {
	this.timeout(10000);
	let Docs, RETRY_NOW;
	let nextId = 0;

	before(function () {
		// This fixture requires RocksDB's coordinated native retry and pending audit watermark.
		if (process.env.HARPER_STORAGE_ENGINE === 'lmdb') return this.skip();
		RETRY_NOW = require('../rocksdbBindings.mts').rocksdbBindings().constants.RETRY_NOW_VALUE;
		setupTestDBPath();
		setMainIsWorker(true);
		Docs = table({
			database: 'concurrentPatchPut',
			table: 'Docs',
			audit: true,
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'title' }, { name: 'body' }, { name: 'notes' }],
		});
	});

	function entriesAt(key, readUncommitted = false) {
		return [...Docs.auditStore.getRange({ start: key, exactStart: true, log: 0, readUncommitted })].filter(
			(entry) => entry.txnLogKey === key && entry.tableId === Docs.tableId
		);
	}

	async function withPendingFrame(callback) {
		const id = `blocker-${nextId++}`;
		await Docs.put(id, { id, title: 'seed' });
		let result, failure;
		await transaction({}, async (parked) => {
			await Docs.patch(id, { title: 'parked' });
			await parked.save(parked.writes.find((write) => write.key === id));
			await transaction({}, () => Docs.patch(id, { title: 'competitor' }));
			assert.strictEqual(await parked.transaction.commit(), RETRY_NOW);
			assert.strictEqual(parked.transaction.logWritten(), true);
			try {
				result = await callback();
			} catch (error) {
				failure = error;
			}
		}).catch((error) => {
			throw failure ?? error;
		});
		if (failure) throw failure;
		assert.strictEqual((await Docs.get(id)).title, 'competitor');
		return result;
	}

	async function race({
		first = 'put',
		pending = false,
		explicitVersion = false,
		extraPatch = false,
		aborted = false,
	}) {
		const id = `doc-${nextId++}`;
		const seed = { id, title: 'original-title', body: 'original-body', notes: 'original-notes' };
		await Docs.put(id, seed);
		const version = Date.now() + 86400000 + nextId * 1000;
		if (aborted) {
			const cancelled = new Error('abandon the uncommitted patch');
			await assert.rejects(
				transaction({ timestamp: version + 500 }, async (txn) => {
					await Docs.patch(id, { title: 'aborted-title', notes: 'aborted-notes' });
					await txn.save(txn.writes.find((write) => write.key === id));
					await transaction({}, () => Docs.put(id, seed));
					assert.strictEqual(await txn.transaction.commit(), RETRY_NOW);
					assert.strictEqual(txn.transaction.logWritten(), true);
					throw cancelled;
				}),
				(error) => error === cancelled
			);
		}
		const run = async () => {
			let native, write;
			await transaction(explicitVersion ? { timestamp: version } : {}, async (txn) => {
				await Docs[first](id, first === 'put' ? { id, body: 'put-body' } : { title: 'patch-title' });
				write = txn.writes.find((write) => write.key === id);
				await txn.save(write);
				native = txn.transaction;
				await transaction(explicitVersion ? { timestamp: version + 100 } : {}, () =>
					Docs[first === 'put' ? 'patch' : 'put'](
						id,
						first === 'put' ? { title: 'patch-title' } : { id, body: 'put-body' }
					)
				);
				if (extraPatch) await transaction({}, () => Docs.patch(id, { notes: 'new-notes' }));
				const head = Docs.primaryStore.getEntry(id, { uncachedRead: true });
				const key = head.additionalAuditRefs?.[0]?.version ?? head.version;
				if (explicitVersion) assert.notStrictEqual(key, head.version);
				assert.strictEqual(entriesAt(key, true).filter((entry) => entry.recordId === id).length, 1);
				assert.strictEqual(entriesAt(key).filter((entry) => entry.recordId === id).length, pending ? 0 : 1);
			});
			assert.ok(native.retries > 0, 'the target writes must really conflict');
			const record = await transaction({}, () => Docs.get(id));
			assert.strictEqual(record.body, 'put-body');
			assert.strictEqual(record.title, first === 'put' ? 'patch-title' : undefined);
			assert.strictEqual(record.notes, extraPatch ? 'new-notes' : undefined);
			assert.strictEqual(write.skipped, first === 'patch');
		};
		if (pending) await withPendingFrame(run);
		else await run();
	}

	for (const first of ['put', 'patch']) {
		for (const pending of [false, true]) {
			it(`keeps version order when ${first} retries, with ${pending ? 'a pending' : 'no pending'} audit frame`, () =>
				race({ first, pending }));
		}
	}
	it('replaces omitted fields when the committed PATCH version differs from its log key', () =>
		race({ pending: true, explicitVersion: true }));
	it('retains both newer PATCHes behind the pending frame', () => race({ pending: true, extraPatch: true }));
	it('does not fold an aborted newer PATCH into the replacement', () =>
		race({ pending: true, explicitVersion: true, aborted: true }));
});
