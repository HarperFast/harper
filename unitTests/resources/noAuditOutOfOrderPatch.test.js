require('../testUtils');
const assert = require('node:assert');
const { existsSync } = require('node:fs');
const { randomBytes } = require('node:crypto');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { transaction } = require('#src/resources/transaction');
const { getIdOfRemoteNode } = require('#src/resources/nodeIdMapping');
const { createBlob, getFilePathForBlob, setDeletionDelay } = require('#src/resources/blob');
const { waitFor } = require('../waitFor');

// LMDB stores a merged record at the merging write's older version (harper#3388), so a later write older than the
// original head compares as in-order there.
const itUnlessVersionRewinds = process.env.HARPER_STORAGE_ENGINE === 'lmdb' ? it.skip : it;
// On LMDB a patch before a same-transaction publish ties the publish's restamp and is dropped, as on main.
const itUnlessLmdb = process.env.HARPER_STORAGE_ENGINE === 'lmdb' ? it.skip : it;
// RocksDB reloads a write's commit base; LMDB commits against the entry the resource holds.
const itOnLmdb = process.env.HARPER_STORAGE_ENGINE === 'lmdb' ? it : it.skip;

describe('out-of-order patch on an audit:false table', () => {
	let NoAudit;
	let NoAuditTrackDeletes;
	let NoAuditSourced;
	let revalidatedExpiresAt;
	let sourceGate;
	let sourceCalled;
	let nextId = 1;

	before(async () => {
		setupTestDBPath();
		setMainIsWorker(true);
		setDeletionDelay(0);
		const attributes = [
			{ name: 'id', isPrimaryKey: true },
			{ name: 'tag', indexed: true },
			{ name: 'data' },
			{ name: 'extra' },
			{ name: 'count' },
		];
		NoAudit = table({ table: 'NoAuditOutOfOrderPatch', database: 'test', attributes, audit: false });
		NoAuditTrackDeletes = table({
			table: 'NoAuditOutOfOrderPatchTrackDeletes',
			database: 'test',
			attributes,
			audit: false,
			trackDeletes: true,
		});
		NoAuditSourced = table({ table: 'NoAuditOutOfOrderPatchSourced', database: 'test', attributes, audit: false });
		NoAuditSourced.sourcedFrom({
			async get(id, context) {
				context.expiresAt = revalidatedExpiresAt;
				sourceCalled?.();
				await sourceGate;
				return { status: 304, headers: {} };
			},
		});
		if (NoAudit.indexingOperation) await NoAudit.indexingOperation;
		if (NoAuditTrackDeletes.indexingOperation) await NoAuditTrackDeletes.indexingOperation;
	});

	after(() => setDeletionDelay(undefined));

	async function seedNewerRecord() {
		const id = `noaudit-${nextId++}`;
		await NoAudit.put(id, { tag: 'base', count: 10 });
		const now = Date.now();
		const newerBytes = randomBytes(25000);
		const newerBlob = await createBlob(newerBytes);
		await NoAudit.patch(
			id,
			{ tag: 'newer', data: newerBlob, count: { __op__: 'add', value: 2 } },
			{ timestamp: now + 100 }
		);
		return { id, now, newerBytes, newerBlob };
	}

	it('a patch whose keys all exist in the newer record leaves it untouched and reclaims its blob', async () => {
		const { id, now, newerBytes, newerBlob } = await seedNewerRecord();
		const staleBlob = await createBlob(randomBytes(25000));
		await NoAudit.patch(id, { tag: 'stale', data: staleBlob }, { timestamp: now + 50 });

		const record = await NoAudit.get(id);
		assert.strictEqual(record.tag, 'newer', 'the stale patch overwrote a newer scalar');
		assert.ok(Buffer.from(await record.data.bytes()).equals(newerBytes), 'the stale patch replaced the newer blob');
		await waitFor(() => !existsSync(getFilePathForBlob(staleBlob)), {
			timeout: 5000,
			message: 'the stale patch blob was never cleaned up',
		});
		assert.ok(existsSync(getFilePathForBlob(newerBlob)), 'the newer record blob file was unlinked');
	});

	it('a partially superseded patch adds only the new key and reclaims the blob of the dropped key', async () => {
		const { id, now, newerBytes, newerBlob } = await seedNewerRecord();
		const staleBlob = await createBlob(randomBytes(25000));
		await NoAudit.patch(id, { tag: 'stale', data: staleBlob, extra: 'added' }, { timestamp: now + 50 });

		const record = await NoAudit.get(id);
		assert.strictEqual(record.tag, 'newer');
		assert.strictEqual(record.extra, 'added', 'the key the newer record lacked must still merge');
		assert.ok(Buffer.from(await record.data.bytes()).equals(newerBytes));
		await waitFor(() => !existsSync(getFilePathForBlob(staleBlob)), {
			timeout: 5000,
			message: 'the dropped key blob was never cleaned up',
		});
		assert.ok(existsSync(getFilePathForBlob(newerBlob)), 'the newer record blob file was unlinked');
	});

	it('a blob the merged record keeps survives the cleanup', async () => {
		const { id, now, newerBytes } = await seedNewerRecord();
		const keptBytes = randomBytes(25000);
		const keptBlob = await createBlob(keptBytes);
		const staleBlob = await createBlob(randomBytes(25000));
		await NoAudit.patch(id, { data: staleBlob, extra: keptBlob }, { timestamp: now + 50 });

		await waitFor(() => !existsSync(getFilePathForBlob(staleBlob)), {
			timeout: 5000,
			message: 'the dropped key blob was never cleaned up',
		});
		const record = await NoAudit.get(id);
		assert.ok(Buffer.from(await record.extra.bytes()).equals(keptBytes), 'the retained blob must stay readable');
		assert.ok(Buffer.from(await record.data.bytes()).equals(newerBytes), 'the newer blob must stay readable');
	});

	it('an increment is applied even though every key it touches exists in the newer record', async () => {
		const { id, now } = await seedNewerRecord();
		await NoAudit.patch(id, { count: { __op__: 'add', value: 1 } }, { timestamp: now + 50 });
		assert.strictEqual((await NoAudit.get(id)).count, 13);
	});

	it('an increment survives beside a stale plain assignment that is dropped', async () => {
		const { id, now } = await seedNewerRecord();
		await NoAudit.patch(id, { count: { __op__: 'add', value: 1 }, tag: 'stale' }, { timestamp: now + 50 });
		const record = await NoAudit.get(id);
		assert.strictEqual(record.count, 13);
		assert.strictEqual(record.tag, 'newer');
	});

	it('an increment survives beside a plain key the newer record lacks', async () => {
		const { id, now } = await seedNewerRecord();
		await NoAudit.patch(id, { count: { __op__: 'add', value: 1 }, extra: 'added' }, { timestamp: now + 50 });
		const record = await NoAudit.get(id);
		assert.strictEqual(record.count, 13);
		assert.strictEqual(record.extra, 'added');
	});

	// the context and options the source-apply handler passes for a replicated patch
	function applyFrom(nodeName, id, update, version, logKey = version) {
		const context = { source: {}, sourceApply: true, timestamp: logKey };
		return transaction(context, async () => {
			const resource = await NoAudit.getResource(id, context);
			await resource._writeUpdate(id, update, false, {
				isNotification: true,
				nodeId: getIdOfRemoteNode(nodeName, NoAudit.auditStore),
				version,
			});
		});
	}

	async function idsTagged(Table, tag) {
		const ids = [];
		for await (const record of Table.search({ conditions: [{ attribute: 'tag', value: tag }] })) ids.push(record.id);
		return ids;
	}

	it('an older patch does not resurrect a record a newer delete removed', async () => {
		const id = `noaudit-${nextId++}`;
		await NoAuditTrackDeletes.put(id, { tag: 'base', count: 10 });
		const now = Date.now();
		await NoAuditTrackDeletes.delete(id, { timestamp: now + 100 });
		const staleBlob = await createBlob(randomBytes(25000));
		await NoAuditTrackDeletes.patch(
			id,
			{ tag: 'resurrected', data: staleBlob, count: { __op__: 'add', value: 5 } },
			{ timestamp: now + 50 }
		);

		assert.equal(await NoAuditTrackDeletes.get(id), undefined, 'the stale patch resurrected the deleted record');
		assert.deepStrictEqual(await idsTagged(NoAuditTrackDeletes, 'resurrected'), [], 'the stale patch was indexed');
		await waitFor(() => !existsSync(getFilePathForBlob(staleBlob)), {
			timeout: 5000,
			message: 'the stale patch blob was never cleaned up',
		});
	});

	it('an older patch does not materialize a record over a newer publish', async () => {
		const id = `noaudit-${nextId++}`;
		const now = Date.now();
		await NoAudit.publish(id, { message: 'hello' }, { timestamp: now + 100 });
		await NoAudit.patch(id, { tag: 'materialized', count: { __op__: 'add', value: 5 } }, { timestamp: now + 50 });

		assert.equal(await NoAudit.get(id), undefined, 'the stale patch materialized a record');
		assert.deepStrictEqual(await idsTagged(NoAudit, 'materialized'), [], 'the stale patch was indexed');
	});

	it('a newer patch after a delete still recreates the record', async () => {
		const id = `noaudit-${nextId++}`;
		await NoAuditTrackDeletes.put(id, { tag: 'base', count: 10 });
		const now = Date.now();
		await NoAuditTrackDeletes.delete(id, { timestamp: now + 100 });
		await NoAuditTrackDeletes.patch(id, { tag: 'recreated' }, { timestamp: now + 150 });
		assert.strictEqual((await NoAuditTrackDeletes.get(id))?.tag, 'recreated');
	});

	it('a patch after a publish to the record in the same transaction still applies', async () => {
		const id = `noaudit-${nextId++}`;
		await NoAudit.put(id, { tag: 'base', count: 10 });
		const context = {};
		await transaction(context, async () => {
			await NoAudit.publish(id, { message: 'hello' }, context);
			await NoAudit.patch(id, { tag: 'after-publish', count: { __op__: 'add', value: 1 } }, context);
		});
		const record = await NoAudit.get(id);
		assert.strictEqual(record.tag, 'after-publish');
		assert.strictEqual(record.count, 11);
	});

	itUnlessLmdb('a patch before a publish to the record in the same transaction still applies', async () => {
		const id = `noaudit-${nextId++}`;
		await NoAudit.put(id, { tag: 'base', count: 10 });
		const context = {};
		await transaction(context, async () => {
			await NoAudit.patch(id, { tag: 'before-publish', count: { __op__: 'add', value: 4 } }, context);
			await NoAudit.publish(id, { message: 'hello' }, context);
		});
		const record = await NoAudit.get(id);
		assert.strictEqual(record.tag, 'before-publish');
		assert.strictEqual(record.count, 14);
	});

	// A replicated patch is deferred to commit, while a publish saves when added and restamps the head at the
	// source transaction's identity, so in either order the patch meets a head tied by its own transaction.
	const applySource = async (id, nodeId, version, publishFirst) => {
		const context = { source: {}, sourceApply: true, timestamp: version };
		await transaction(context, async () => {
			const resource = await NoAudit.getResource(id, context);
			const options = { isNotification: true, nodeId, version };
			if (publishFirst) resource._writePublish(id, { message: 'hello' }, options);
			await resource._writeUpdate(id, { tag: 'patched', count: { __op__: 'add', value: 4 } }, false, options);
			if (!publishFirst) resource._writePublish(id, { message: 'hello' }, options);
		});
	};

	for (const [order, publishFirst] of [
		['patch-then-publish', false],
		['publish-then-patch', true],
	]) {
		const itForOrder = publishFirst ? it : itUnlessLmdb;
		itForOrder(`a replicated ${order} source transaction applies over an older head`, async () => {
			const id = `noaudit-${nextId++}`;
			await NoAudit.put(id, { tag: 'base', count: 10 });
			await applySource(id, getIdOfRemoteNode(`origin-${order}`, NoAudit.auditStore), Date.now() + 1000, publishFirst);
			const record = await NoAudit.get(id);
			assert.strictEqual(record.tag, 'patched');
			assert.strictEqual(record.count, 14);
		});

		itForOrder(`a re-delivered ${order} source transaction applies its increment once`, async () => {
			const id = `noaudit-${nextId++}`;
			await NoAudit.put(id, { tag: 'base', count: 10 });
			const nodeId = getIdOfRemoteNode(`origin-${order}-again`, NoAudit.auditStore);
			const version = Date.now() + 1000;
			await applySource(id, nodeId, version, publishFirst);
			await applySource(id, nodeId, version, publishFirst);
			assert.strictEqual((await NoAudit.get(id)).count, 14);
		});

		itForOrder(
			`a ${order} source transaction re-delivered after a newer patch applies its increment once`,
			async () => {
				const id = `noaudit-${nextId++}`;
				await NoAudit.put(id, { tag: 'base', count: 10 });
				const nodeId = getIdOfRemoteNode(`origin-${order}-before-newer`, NoAudit.auditStore);
				const version = Date.now() + 1000;
				await applySource(id, nodeId, version, publishFirst);
				await NoAudit.patch(id, { tag: 'latest' }, { timestamp: version + 500 });
				await applySource(id, nodeId, version, publishFirst);
				assert.strictEqual((await NoAudit.get(id)).count, 14);
			}
		);

		itForOrder(`a replicated ${order} source transaction older than the head merges only its ops`, async () => {
			const id = `noaudit-${nextId++}`;
			const newer = Date.now() + 2000;
			const context = { source: {}, sourceApply: true, timestamp: newer };
			await transaction(context, async () => {
				const resource = await NoAudit.getResource(id, context);
				await resource._writeUpdate(id, { id, tag: 'newer', count: 10 }, true, {
					isNotification: true,
					nodeId: getIdOfRemoteNode(`origin-newer-than-${order}`, NoAudit.auditStore),
					version: newer,
				});
			});
			await applySource(id, getIdOfRemoteNode(`origin-older-${order}`, NoAudit.auditStore), newer - 1000, publishFirst);
			const record = await NoAudit.get(id);
			assert.strictEqual(record.tag, 'newer');
			assert.strictEqual(record.count, 14);
		});
	}

	it('a put after a publish to the record in the same transaction replaces it', async () => {
		const id = `noaudit-${nextId++}`;
		await NoAudit.put(id, { tag: 'base', count: 10 });
		const context = {};
		await transaction(context, async () => {
			await NoAudit.publish(id, { message: 'hello' }, context);
			await NoAudit.put(id, { tag: 'replaced' }, context);
		});
		const record = await NoAudit.get(id);
		assert.strictEqual(record.tag, 'replaced');
		assert.strictEqual(record.count, undefined);
	});

	it('a patch after a publish to an absent record in the same transaction creates it', async () => {
		const id = `noaudit-${nextId++}`;
		const context = {};
		await transaction(context, async () => {
			await NoAudit.publish(id, { message: 'hello' }, context);
			await NoAudit.patch(id, { tag: 'after-publish' }, context);
		});
		assert.strictEqual((await NoAudit.get(id))?.tag, 'after-publish');
	});

	it('a patch after a delete in the same transaction still applies', async () => {
		const id = `noaudit-${nextId++}`;
		await NoAuditTrackDeletes.put(id, { tag: 'base', count: 10 });
		const context = {};
		await transaction(context, async () => {
			await NoAuditTrackDeletes.delete(id, context);
			await NoAuditTrackDeletes.patch(id, { tag: 'same-transaction' }, context);
		});
		assert.strictEqual((await NoAuditTrackDeletes.get(id))?.tag, 'same-transaction');
	});

	it('a re-delivered patch at the head version applies its increment once', async () => {
		const { id, now } = await seedNewerRecord();
		await NoAudit.patch(id, { count: { __op__: 'add', value: 5 } }, { timestamp: now + 200 });
		await NoAudit.patch(id, { count: { __op__: 'add', value: 5 } }, { timestamp: now + 200 });
		assert.strictEqual((await NoAudit.get(id)).count, 17);
	});

	it('a re-delivered out-of-order patch applies its increment once', async () => {
		const { id, now } = await seedNewerRecord();
		await NoAudit.patch(id, { count: { __op__: 'add', value: 3 } }, { timestamp: now + 50 });
		await NoAudit.patch(id, { count: { __op__: 'add', value: 3 } }, { timestamp: now + 50 });
		assert.strictEqual((await NoAudit.get(id)).count, 15);
	});

	it('every out-of-order patch merged into the head is recognized when re-delivered', async () => {
		const { id, now } = await seedNewerRecord();
		await NoAudit.patch(id, { count: { __op__: 'add', value: 3 } }, { timestamp: now + 40 });
		await NoAudit.patch(id, { count: { __op__: 'add', value: 4 } }, { timestamp: now + 60 });
		await NoAudit.patch(id, { count: { __op__: 'add', value: 3 } }, { timestamp: now + 40 });
		await NoAudit.patch(id, { count: { __op__: 'add', value: 4 } }, { timestamp: now + 60 });
		assert.strictEqual((await NoAudit.get(id)).count, 19);
	});

	it('distinct out-of-order patches at one timestamp from different nodes both merge', async () => {
		const { id, now } = await seedNewerRecord();
		await applyFrom('origin-a', id, { count: { __op__: 'add', value: 3 } }, now + 50);
		await applyFrom('origin-b', id, { count: { __op__: 'add', value: 4 } }, now + 50);
		await applyFrom('origin-a', id, { count: { __op__: 'add', value: 3 } }, now + 50);
		assert.strictEqual((await NoAudit.get(id)).count, 19);
	});

	itUnlessVersionRewinds(
		'an out-of-order merge keeps the head version, so an older write still loses to the head',
		async () => {
			const { id, now } = await seedNewerRecord();
			await NoAudit.patch(id, { extra: 'added' }, { timestamp: now + 50 });
			assert.strictEqual(NoAudit.primaryStore.getEntry(id).version, now + 100, 'the merge rewound the head version');

			await NoAudit.patch(id, { tag: 'between' }, { timestamp: now + 75 });
			assert.strictEqual((await NoAudit.get(id)).tag, 'newer', 'a write older than the head overwrote it');
			await NoAudit.delete(id, { timestamp: now + 75 });
			assert.strictEqual((await NoAudit.get(id))?.tag, 'newer', 'a delete older than the head removed it');

			await NoAudit.patch(id, { tag: 'latest' }, { timestamp: now + 150 });
			const record = await NoAudit.get(id);
			assert.strictEqual(record.tag, 'latest');
			assert.strictEqual(record.extra, 'added');
			assert.strictEqual(NoAudit.primaryStore.getEntry(id).version, now + 150);
		}
	);

	it('a re-delivered transaction of two out-of-order patches to one record applies each once', async () => {
		const { id, now } = await seedNewerRecord();
		const deliver = () => {
			const context = { timestamp: now + 50 };
			return transaction(context, async () => {
				await NoAudit.patch(id, { count: { __op__: 'add', value: 3 } }, context);
				await NoAudit.patch(id, { count: { __op__: 'add', value: 4 } }, context);
			});
		};
		await deliver();
		assert.strictEqual((await NoAudit.get(id)).count, 19);
		await deliver();
		assert.strictEqual((await NoAudit.get(id)).count, 19);
	});

	it('the merged write identity is stored with the record', async () => {
		const { id, now } = await seedNewerRecord();
		await NoAudit.patch(id, { count: { __op__: 'add', value: 3 } }, { timestamp: now + 50 });
		await NoAudit.patch(id, { extra: 'added' }, { timestamp: now + 55 });
		await applyFrom('origin-a', id, { count: { __op__: 'add', value: 4 } }, now + 60, now + 70);
		const refs = NoAudit.primaryStore.getEntry(id).receivedIdentityRefs.map(({ version, nodeId }) => [version, nodeId]);
		assert.deepStrictEqual(refs, [
			[now + 100, 0],
			[now + 50, 0],
			[now + 70, getIdOfRemoteNode('origin-a', NoAudit.auditStore)],
		]);
	});

	it('applied writes are identified by the log key a re-delivery carries', async () => {
		const { id, now } = await seedNewerRecord();
		await applyFrom('origin-a', id, { count: { __op__: 'add', value: 3 } }, now + 50, now + 70);
		await applyFrom('origin-a', id, { count: { __op__: 'add', value: 4 } }, now + 50, now + 80);
		await applyFrom('origin-a', id, { count: { __op__: 'add', value: 3 } }, now + 50, now + 70);
		assert.strictEqual((await NoAudit.get(id)).count, 19);
	});

	it('a merged increment re-delivered after a newer in-order patch applies once', async () => {
		const { id, now } = await seedNewerRecord();
		await NoAudit.patch(id, { count: { __op__: 'add', value: 3 } }, { timestamp: now + 50 });
		await NoAudit.patch(id, { tag: 'latest' }, { timestamp: now + 150 });
		const refs = NoAudit.primaryStore.getEntry(id).receivedIdentityRefs?.map(({ version }) => version);
		assert.deepStrictEqual(refs, [now + 100, now + 50], 'a patch without commutative ops is not listed');
		await NoAudit.patch(id, { count: { __op__: 'add', value: 3 } }, { timestamp: now + 50 });
		const record = await NoAudit.get(id);
		assert.strictEqual(record.tag, 'latest');
		assert.strictEqual(record.count, 15);
	});

	it('a replicated merged increment re-delivered after a newer in-order patch applies once', async () => {
		const { id, now } = await seedNewerRecord();
		await applyFrom('origin-a', id, { count: { __op__: 'add', value: 3 } }, now + 50, now + 70);
		await NoAudit.patch(id, { tag: 'latest' }, { timestamp: now + 150 });
		await applyFrom('origin-a', id, { count: { __op__: 'add', value: 3 } }, now + 50, now + 70);
		assert.strictEqual((await NoAudit.get(id)).count, 15);
	});

	it('a merged increment re-delivered after a newer relocate applies once', async () => {
		const { id, now } = await seedNewerRecord();
		await NoAudit.patch(id, { count: { __op__: 'add', value: 3 } }, { timestamp: now + 50 });
		const context = { timestamp: now + 150 };
		await transaction(context, async () => {
			const resource = await NoAudit.getResource(id, context);
			resource._writeRelocate(id, {});
		});
		assert.strictEqual(
			NoAudit.primaryStore.getEntry(id).version,
			now + 150,
			'premise: the relocate restamped the head'
		);
		await NoAudit.patch(id, { count: { __op__: 'add', value: 3 } }, { timestamp: now + 50 });
		assert.strictEqual((await NoAudit.get(id)).count, 15);
	});

	it('a merged increment re-delivered after a 304 revalidation applies once', async () => {
		const id = `noaudit-${nextId++}`;
		await NoAuditSourced.put(id, { tag: 'base', count: 10 });
		const now = Date.now();
		await NoAuditSourced.patch(id, { count: { __op__: 'add', value: 3 } }, { timestamp: now + 100 });
		await NoAuditSourced.patch(id, { count: { __op__: 'add', value: 2 } }, { timestamp: now + 50 });
		await NoAuditSourced.patch(id, { tag: 'expired' }, { timestamp: now + 150, expiresAt: 0 });
		revalidatedExpiresAt = Date.now() + 60000;
		assert.strictEqual((await NoAuditSourced.get(id)).count, 15);
		await waitFor(() => NoAuditSourced.primaryStore.getEntry(id)?.expiresAt === revalidatedExpiresAt, {
			timeout: 5000,
			message: 'the revalidation never stored the record',
		});
		await NoAuditSourced.patch(id, { count: { __op__: 'add', value: 2 } }, { timestamp: now + 50 });
		assert.strictEqual((await NoAuditSourced.get(id)).count, 15);
	});

	it('a 304 revalidation that raced a merge keeps the list of the body it stored', async function () {
		this.timeout(10000);
		const id = `noaudit-${nextId++}`;
		await NoAuditSourced.put(id, { tag: 'base', count: 10 });
		const now = Date.now();
		await NoAuditSourced.patch(id, { tag: 'expired' }, { timestamp: now + 100, expiresAt: 0 });
		revalidatedExpiresAt = Date.now() + 60000;
		let release;
		let called = false;
		sourceGate = new Promise((resolve) => (release = resolve));
		sourceCalled = () => (called = true);
		const read = NoAuditSourced.get(id);
		try {
			await waitFor(() => called, { timeout: 5000, message: 'the expired read never called the source' });
			await NoAuditSourced.patch(id, { count: { __op__: 'add', value: 3 } }, { timestamp: now + 50 });
		} finally {
			release();
			sourceGate = sourceCalled = undefined;
			await read.catch(() => {});
		}
		await read;
		await waitFor(() => !NoAuditSourced.primaryStore.hasLock(id), { message: 'the revalidation never settled' });
		// whichever wins (RocksDB's merge keeps the version, so the 304's stale body can replace it), the stored
		// list must describe the stored body, or this re-delivery is skipped against a body that lacks it
		await NoAuditSourced.patch(id, { count: { __op__: 'add', value: 3 } }, { timestamp: now + 50 });
		assert.strictEqual((await NoAuditSourced.get(id)).count, 13);
	});

	itOnLmdb('a patch through a resource a 304 revalidation loaded keeps the identity list', async function () {
		this.timeout(10000);
		const id = `noaudit-${nextId++}`;
		await NoAuditSourced.put(id, { tag: 'base', count: 10 });
		const now = Date.now();
		await NoAuditSourced.patch(id, { count: { __op__: 'add', value: 3 } }, { timestamp: now + 50 });
		await NoAuditSourced.patch(id, { tag: 'expired' }, { timestamp: now + 100, expiresAt: 0 });
		revalidatedExpiresAt = Date.now() + 60000;
		const context = { timestamp: now + 150 };
		await transaction(context, async () => {
			const resource = await NoAuditSourced.getResource(id, context);
			await resource.ensureLoaded();
			await resource._writeUpdate(id, { tag: 'latest' }, false, {});
		});
		await NoAuditSourced.patch(id, { count: { __op__: 'add', value: 3 } }, { timestamp: now + 50 });
		const record = await NoAuditSourced.get(id);
		assert.strictEqual(record.tag, 'latest');
		assert.strictEqual(record.count, 13);
	});

	it('a merged increment re-delivered after a newer publish applies once', async () => {
		const { id, now } = await seedNewerRecord();
		await NoAudit.patch(id, { count: { __op__: 'add', value: 3 } }, { timestamp: now + 50 });
		await NoAudit.publish(id, { message: 'hello' }, { timestamp: now + 150 });
		await NoAudit.patch(id, { count: { __op__: 'add', value: 3 } }, { timestamp: now + 50 });
		assert.strictEqual((await NoAudit.get(id)).count, 15);
	});

	it('an in-order increment re-delivered after a newer patch applies once', async () => {
		const id = `noaudit-${nextId++}`;
		await NoAudit.put(id, { tag: 'base', count: 10 });
		const now = Date.now();
		await NoAudit.patch(id, { tag: 'newer', count: { __op__: 'add', value: 5 } }, { timestamp: now + 100 });
		await NoAudit.patch(id, { tag: 'latest', extra: 'v2' }, { timestamp: now + 150 });
		await NoAudit.patch(id, { tag: 'newer', count: { __op__: 'add', value: 5 } }, { timestamp: now + 100 });
		const record = await NoAudit.get(id);
		assert.strictEqual(record.tag, 'latest');
		assert.strictEqual(record.count, 15);
	});

	it('a replicated in-order increment re-delivered after a newer patch applies once', async () => {
		const id = `noaudit-${nextId++}`;
		await NoAudit.put(id, { tag: 'base', count: 10 });
		const now = Date.now();
		await applyFrom('origin-a', id, { count: { __op__: 'add', value: 5 } }, now + 100);
		await NoAudit.patch(id, { tag: 'latest' }, { timestamp: now + 150 });
		await applyFrom('origin-a', id, { count: { __op__: 'add', value: 5 } }, now + 100);
		assert.strictEqual((await NoAudit.get(id)).count, 15);
	});

	it("the seed's in-order increment re-delivered after an older merge applies once", async () => {
		const { id, now } = await seedNewerRecord();
		await NoAudit.patch(id, { count: { __op__: 'add', value: 3 } }, { timestamp: now + 50 });
		await NoAudit.patch(id, { count: { __op__: 'add', value: 2 } }, { timestamp: now + 100 });
		assert.strictEqual((await NoAudit.get(id)).count, 15);
	});

	it('a re-delivered in-order transaction of two increments to one record applies neither', async () => {
		const id = `noaudit-${nextId++}`;
		await NoAudit.put(id, { tag: 'base', count: 10 });
		const now = Date.now();
		const deliver = () => {
			const context = { timestamp: now + 100 };
			return transaction(context, async () => {
				await NoAudit.patch(id, { count: { __op__: 'add', value: 3 } }, context);
				await NoAudit.patch(id, { count: { __op__: 'add', value: 4 } }, context);
			});
		};
		await deliver();
		assert.strictEqual((await NoAudit.get(id)).count, 17);
		await NoAudit.patch(id, { tag: 'latest' }, { timestamp: now + 150 });
		await deliver();
		assert.strictEqual((await NoAudit.get(id)).count, 17);
	});

	it('a re-delivered transaction that replaces the record applies every increment on the new body', async () => {
		const id = `noaudit-${nextId++}`;
		await NoAudit.put(id, { tag: 'base', count: 0 });
		const now = Date.now();
		const deliver = () => {
			const context = { timestamp: now + 100 };
			return transaction(context, async () => {
				await NoAudit.put(id, { tag: 'replaced', count: 10 }, context);
				await NoAudit.patch(id, { count: { __op__: 'add', value: 2 } }, context);
				await NoAudit.patch(id, { count: { __op__: 'add', value: 3 } }, context);
			});
		};
		await deliver();
		await NoAudit.patch(id, { count: { __op__: 'add', value: 1 } }, { timestamp: now + 50 });
		assert.strictEqual((await NoAudit.get(id)).count, 16);
		await deliver();
		// RocksDB keeps the head version, so the put ties and the transaction is skipped whole
		if (process.env.HARPER_STORAGE_ENGINE !== 'lmdb') return assert.strictEqual((await NoAudit.get(id)).count, 16);
		assert.strictEqual(
			(await NoAudit.get(id)).count,
			15,
			'both increments re-apply on the re-applied put; it erases the merged +1 only because LMDB stored the merge at its older version (harper#3388)'
		);
	});

	it('a full write starts a new identity list', async () => {
		const { id, now } = await seedNewerRecord();
		await NoAudit.patch(id, { count: { __op__: 'add', value: 3 } }, { timestamp: now + 50 });
		await NoAudit.put(id, { tag: 'replaced', count: 1 }, { timestamp: now + 150 });
		assert.strictEqual(NoAudit.primaryStore.getEntry(id).receivedIdentityRefs, undefined);
	});

	it('over the encoder budget, the newest listed increment is still recognized', async () => {
		const id = `noaudit-${nextId++}`;
		await NoAudit.put(id, { tag: 'base', count: 0 });
		const now = Date.now();
		for (let i = 1; i <= 30; i++)
			await NoAudit.patch(id, { count: { __op__: 'add', value: 1 } }, { timestamp: now + i });
		await NoAudit.patch(id, { tag: 'latest' }, { timestamp: now + 100 });
		const refs = NoAudit.primaryStore.getEntry(id).receivedIdentityRefs.map(({ version }) => version);
		assert.ok(refs.length < 30, `the list is bounded, got ${refs.length}`);
		assert.strictEqual(refs.at(-1), now + 30);
		await NoAudit.patch(id, { count: { __op__: 'add', value: 1 } }, { timestamp: now + 30 });
		const record = await NoAudit.get(id);
		assert.strictEqual(record.tag, 'latest');
		assert.strictEqual(record.count, 30);
	});

	it('a later write in the transaction keeps the identity an earlier merge listed', async () => {
		const { id, now } = await seedNewerRecord();
		const context = { timestamp: now + 50 };
		await transaction(context, async () => {
			await NoAudit.patch(id, { count: { __op__: 'add', value: 3 } }, context);
			await NoAudit.patch(id, { extra: 'added' }, context);
		});
		const refs = NoAudit.primaryStore.getEntry(id).receivedIdentityRefs?.map(({ version }) => version);
		assert.deepStrictEqual(refs, [now + 100, now + 50]);
		// above the version LMDB's merge stored (harper#3388), below the head RocksDB kept
		await NoAudit.patch(id, { tag: 'intervening' }, { timestamp: now + 80 });
		await NoAudit.patch(id, { count: { __op__: 'add', value: 3 } }, { timestamp: now + 50 });
		const record = await NoAudit.get(id);
		assert.strictEqual(record.extra, 'added');
		assert.strictEqual(record.count, 15);
	});

	it('a write staged against the head before an out-of-order merge commits does not overwrite the merge', async () => {
		const { id, now } = await seedNewerRecord();
		let releaseNewer;
		const newerMayCommit = new Promise((resolve) => (releaseNewer = resolve));
		const context = { timestamp: now + 150 };
		const newerWrite = transaction(context, async () => {
			await NoAudit.get(id, context);
			NoAudit.patch(id, { tag: 'latest' }, context);
			await newerMayCommit;
		});
		await NoAudit.patch(id, { count: { __op__: 'add', value: 3 } }, { timestamp: now + 50 });
		releaseNewer();
		await newerWrite;
		const record = await NoAudit.get(id);
		assert.strictEqual(record.tag, 'latest');
		assert.strictEqual(record.count, 15, 'the newer write overwrote the merged increment');
		await NoAudit.patch(id, { count: { __op__: 'add', value: 3 } }, { timestamp: now + 50 });
		assert.strictEqual((await NoAudit.get(id)).count, 15, 'the retried write dropped the merged identity');
	});
});
