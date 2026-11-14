require('../testUtils');
const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { table, database, databases } = require('#src/resources/databases');
const { replayLogs } = require('#src/resources/replayLogs');
const { setMainIsWorker } = require('#src/server/threads/manageThreads');
const { transaction } = require('#src/resources/transaction');
const { FULL_WRITE_HEAD, fullWriteHeadKey, INVALIDATED } = require('#src/resources/Table');
const { VERSION_REUSED, recordUpdater } = require('#src/resources/RecordEncoder');
const { raiseAuditFloor, getAuditFloor, COPIED_RECORD } = require('#src/resources/auditStore');
const { getIdOfRemoteNode } = require('#src/resources/nodeIdMapping');
const { server } = require('#src/server/Server');
const { createBlob, getFilePathForBlob, setDeletionDelay } = require('#src/resources/blob');
const { existsSync } = require('node:fs');
const { randomBytes } = require('node:crypto');
const { waitFor } = require('../waitFor');

const isLMDB = process.env.HARPER_STORAGE_ENGINE === 'lmdb';
const DAY = 86400 * 1000;
const AUDIT_FLOOR_KEY = Symbol.for('audit-floor');
const RESIDENT_HERE = 7;

describe('A record bit for a full-write head (harper#3532)', () => {
	let tables = 0;
	let ids = 0;
	let T, headOrigin, lateOrigin;

	// The floor is database-scoped, so a test that moves it gets its own database.
	function auditedTable(audit = true) {
		const name = `FullWriteHead${++tables}`;
		const created = table({
			table: name,
			database: `fullWriteHead_${name}`,
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'name' }, { name: 'count' }, { name: 'extra' }],
			audit,
		});
		created.dbisDB.putSync([Symbol.for('residency_by_id'), RESIDENT_HERE], [server.hostname]);
		return created;
	}

	before(() => {
		setupTestDBPath();
		setMainIsWorker(true);
		T = auditedTable();
		headOrigin = getIdOfRemoteNode('full-write-head-a', T.auditStore);
		lateOrigin = getIdOfRemoteNode('full-write-head-b', T.auditStore);
	});

	const newId = () => `key-${++ids}`;
	const flagged = (Table, id) => Boolean(Table.primaryStore.getEntry(id)?.metadataFlags & FULL_WRITE_HEAD);

	function fromOrigin(Table, id, write, { version, logKey = version }) {
		const context = { source: {}, sourceApply: true, timestamp: logKey };
		return transaction(context, async () => write(await Table.getResource(id, context, { ensureLoaded: false })));
	}
	const apply = (Table, id, record, { version, nodeId = headOrigin, fullUpdate = false, logKey = version }) =>
		fromOrigin(
			Table,
			id,
			(resource) => resource._writeUpdate(id, record, fullUpdate, { isNotification: true, nodeId, version }),
			{ version, logKey }
		);
	const remove = (Table, id, { version, nodeId = headOrigin }) =>
		fromOrigin(Table, id, (resource) => resource._writeDelete(id, { version, nodeId }), { version });

	// Audit lookups are entry reads on the audit store; the floor is a metadata key, read with getBinary.
	async function lookupsDuring(Table, run) {
		const counts = { lookups: 0, metadataReads: 0 };
		const auditStore = Table.auditStore;
		const originals = {};
		for (const method of ['get', 'getSync', 'getRange', 'getBinary']) {
			originals[method] = auditStore[method];
			auditStore[method] = function (...args) {
				if (method === 'getBinary') counts.metadataReads++;
				else counts.lookups++;
				return originals[method].apply(this, args);
			};
		}
		try {
			await run();
		} finally {
			Object.assign(auditStore, originals);
		}
		return counts;
	}

	it('is set only by an in-order put or delete, on RocksDB', async () => {
		const id = newId();
		const version = Date.now() + DAY;
		await apply(T, id, { id, name: 'put' }, { version, fullUpdate: true });
		assert.equal(flagged(T, id), !isLMDB, 'an in-order put');
		if (isLMDB) return;
		await apply(T, id, { name: 'patched' }, { version: version + 1 });
		assert.equal(flagged(T, id), false, 'an in-order patch');
		await apply(T, id, { id, name: 'put again' }, { version: version + 2, fullUpdate: true });
		assert.equal(flagged(T, id), true);
		await fromOrigin(
			T,
			id,
			(resource) => {
				resource._writeUpdate(id, { id, name: 'put' }, true, {
					isNotification: true,
					nodeId: headOrigin,
					version: version + 3,
				});
				resource._writeUpdate(id, { extra: 1 }, false, {
					isNotification: true,
					nodeId: headOrigin,
					version: version + 3,
				});
			},
			{ version: version + 3 }
		);
		assert.equal(flagged(T, id), false, 'a transaction whose last write to the key is a patch');
		await fromOrigin(
			T,
			id,
			(resource) => {
				resource._writeUpdate(id, { extra: 2 }, false, {
					isNotification: true,
					nodeId: headOrigin,
					version: version + 4,
				});
				resource._writeUpdate(id, { id, name: 'put' }, true, {
					isNotification: true,
					nodeId: headOrigin,
					version: version + 4,
				});
			},
			{ version: version + 4 }
		);
		assert.equal(flagged(T, id), true, 'a transaction whose last write to the key is a put');
		await remove(T, id, { version: version + 5 });
		assert.equal(T.primaryStore.getEntry(id).value, null);
		assert.equal(flagged(T, id), true, 'a delete leaves a flagged tombstone');
	});

	it('is cleared by an invalidation, a relocation, a published message and a copied row', async function () {
		if (isLMDB) return this.skip();
		const version = Date.now() + DAY;
		const flaggedPut = async () => {
			const id = newId();
			await apply(T, id, { id, name: 'put' }, { version, fullUpdate: true });
			assert.ok(flagged(T, id), 'premise: a flagged put');
			return id;
		};
		let id = await flaggedPut();
		await fromOrigin(
			T,
			id,
			(resource) => resource._writeInvalidate(id, { name: 'stub' }, { version: version + 1, nodeId: headOrigin }),
			{
				version: version + 1,
			}
		);
		assert.equal(flagged(T, id), false, 'invalidate');
		id = await flaggedPut();
		await fromOrigin(
			T,
			id,
			(resource) =>
				resource._writeRelocate(id, { version: version + 1, nodeId: headOrigin, residencyId: RESIDENT_HERE }),
			{ version: version + 1 }
		);
		assert.equal(T.primaryStore.getEntry(id).value.name, 'put', 'premise: the body stays');
		assert.equal(flagged(T, id), false, 'relocate moves the version without a full write');
		id = await flaggedPut();
		await T.publish(id, { message: 'hello' });
		assert.equal(T.primaryStore.getEntry(id).value.name, 'put', 'premise: the body stays');
		assert.equal(flagged(T, id), false, 'publish moves the version without a full write');
		id = newId();
		await fromOrigin(
			T,
			id,
			(resource) =>
				resource._writeUpdate(id, { id, name: 'copied' }, true, { isCopyApply: true, nodeId: headOrigin, version }),
			{ version }
		);
		assert.equal(T.primaryStore.getEntry(id).value.name, 'copied');
		assert.equal(flagged(T, id), false, 'a copied row does not carry its source’s kind');
		// a copy frame past the replay boundary applies as an audited put, still of a copied body
		id = newId();
		await fromOrigin(
			T,
			id,
			(resource) =>
				resource._writeUpdate(id, { id, name: 'copied' }, true, {
					isNotification: true,
					copyFrame: true,
					nodeId: headOrigin,
					version,
				}),
			{ version }
		);
		assert.equal(T.primaryStore.getEntry(id).value.name, 'copied');
		assert.equal(flagged(T, id), false, 'a copy frame applied as a put is not certified');
	});

	it('is not set when a full put merges because its head has no audit entry', async function () {
		if (isLMDB) return this.skip();
		const version = Date.now() + DAY;
		const id = newId();
		await fromOrigin(
			T,
			id,
			(resource) =>
				resource._writeUpdate(id, { id, name: 'copied', extra: 'kept' }, true, {
					isCopyApply: true,
					nodeId: headOrigin,
					version,
				}),
			{ version }
		);
		await apply(T, id, { id, name: 'put' }, { version, fullUpdate: true, logKey: version + 5 });
		const entry = T.primaryStore.getEntry(id);
		assert.equal(entry.value.name, 'put');
		assert.equal(entry.value.extra, 'kept', 'premise: unverifiable history merges instead of replacing');
		assert.equal(flagged(T, id), false, 'a merged body is not a full write');
	});

	it('reports the head write’s log key, never another write’s at the same version', async function () {
		if (isLMDB) return this.skip();
		const version = Date.now() + DAY;
		const headKey = (id) => {
			const entry = T.primaryStore.getEntry(id);
			return fullWriteHeadKey(entry.metadataFlags, entry);
		};
		let id = newId();
		await apply(T, id, { id, name: 'put' }, { version, fullUpdate: true });
		assert.equal(headKey(id), version, 'a log key equal to the version');
		id = newId();
		await apply(T, id, { id, name: 'put' }, { version, logKey: version - 10, fullUpdate: true });
		assert.equal(headKey(id), version - 10, 'a diverged log key');
		// the same writer and version under a later log key: this put is the head now
		await apply(T, id, { id, name: 'tied put' }, { version, logKey: version, fullUpdate: true });
		assert.equal(T.primaryStore.getEntry(id).value.name, 'tied put');
		assert.equal(headKey(id), undefined, 'a tie that inherits the earlier head’s ref is not certified');
		await apply(T, id, { name: 'patched' }, { version: version + 1 });
		assert.equal(headKey(id), undefined, 'a patch head');
	});

	describe('a copy frame past the replay boundary (harper#3703)', () => {
		// applied as an audited put of the source row's body, as a follower or a relay's next hop applies it
		const copiedPut = (Table, id, record, { version, nodeId }) =>
			fromOrigin(
				Table,
				id,
				(resource) =>
					resource._writeUpdate(id, record, true, { isNotification: true, copyFrame: true, nodeId, version }),
				{ version }
			);

		it('logs the copy, so a relay forwards it as one', async function () {
			if (isLMDB) return this.skip();
			const id = newId();
			const version = Date.now() + DAY;
			await copiedPut(T, id, { id, name: 'copied' }, { version, nodeId: headOrigin });
			assert.equal(flagged(T, id), false);
			const logged = T.auditStore.getSync(version, T.tableId, id, headOrigin);
			assert.equal(logged?.type, 'put');
			assert.ok(logged.extendedType & COPIED_RECORD, 'the entry relays carry and receivers map back to copyFrame');
		});

		it('still supersedes a later older write, which the post-copy replay re-delivers from the body', async function () {
			if (isLMDB) return this.skip();
			const id = newId();
			const version = Date.now() + DAY;
			await copiedPut(T, id, { id, name: 'copied', count: 5 }, { version, nodeId: headOrigin });
			await apply(T, id, { count: { __op__: 'add', value: 1 } }, { version: version - 1000, nodeId: lateOrigin });
			const entry = T.primaryStore.getEntry(id);
			assert.equal(entry.value.count, 5, 'an increment the copied body already holds is not applied twice');
			assert.equal(entry.version, version);
		});

		it('takes copyFrame from a replicated event', async function () {
			if (isLMDB) return this.skip();
			let release;
			const held = new Promise((resolve) => (release = resolve));
			const version = Date.now() + DAY;
			const Replicated = table({
				table: 'CopyFrameEvents',
				database: 'fullWriteHeadCopyFrameEvents',
				attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'name' }],
				audit: true,
			});
			Replicated.sourcedFrom(
				{
					subscribeOnThisThread() {
						return true;
					},
					async *subscribe() {
						yield {
							type: 'put',
							id: 'copied',
							value: { id: 'copied', name: 'copied' },
							timestamp: version,
							version,
							copyFrame: true,
						};
						yield {
							type: 'put',
							id: 'put',
							value: { id: 'put', name: 'put' },
							timestamp: version + 1,
							version: version + 1,
						};
						await held;
					},
				},
				{ intermediateSource: true }
			);
			try {
				const deadline = Date.now() + 5000;
				while (!Replicated.primaryStore.getEntry('put') && Date.now() < deadline)
					await new Promise((r) => setTimeout(r, 20));
				assert.ok(flagged(Replicated, 'put'), 'premise: a replicated put is certified');
				assert.equal(Replicated.primaryStore.getEntry('copied')?.value?.name, 'copied');
				assert.equal(flagged(Replicated, 'copied'), false);
			} finally {
				release();
			}
		});

		it('replays a copied put after a crash without certifying it', async function () {
			if (isLMDB) return this.skip();
			const Replayed = table({
				table: 'CopiedReplay',
				database: 'fullWriteHeadCopiedReplay',
				attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'name' }],
				audit: true,
			});
			const origin = getIdOfRemoteNode('full-write-head-a', Replayed.auditStore);
			const version = Date.now() + DAY;
			await copiedPut(Replayed, 'copied', { id: 'copied', name: 'copied' }, { version, nodeId: origin });
			// what a crash between the log append and the row's flush leaves: the entry, and no row
			Replayed.primaryStore.removeSync('copied');
			await replayLogs(
				database({ database: 'fullWriteHeadCopiedReplay', table: undefined }),
				databases.fullWriteHeadCopiedReplay,
				true
			);
			const entry = Replayed.primaryStore.getEntry('copied');
			assert.equal(entry?.value?.name, 'copied', 'premise: the replay re-applied the copied put');
			assert.equal(Boolean(entry.metadataFlags & FULL_WRITE_HEAD), false);
		});
	});

	it('is never set on a table without audit', async function () {
		if (isLMDB) return this.skip();
		const Unaudited = auditedTable(false);
		await Unaudited.put('plain', { name: 'put' });
		assert.equal(flagged(Unaudited, 'plain'), false);
	});

	for (const head of ['put', 'delete'])
		for (const late of ['put', 'patch', 'add'])
			it(`skips an older ${late} against a ${head} head with no audit lookup`, async function () {
				if (isLMDB) return this.skip();
				const id = newId();
				const version = Date.now() + DAY;
				await apply(T, id, { id, name: 'head', count: 5 }, { version, fullUpdate: true });
				if (head === 'delete') await remove(T, id, { version: version + 1 });
				const before = T.primaryStore.getEntry(id);
				assert.ok(before.metadataFlags & FULL_WRITE_HEAD, 'premise: a flagged head');
				const record = {
					put: { id, name: 'late', count: 1 },
					patch: { name: 'late' },
					add: { count: { __op__: 'add', value: 1 } },
				}[late];
				const counts = await lookupsDuring(T, () =>
					apply(T, id, record, { version: version - 1000, nodeId: lateOrigin, fullUpdate: late === 'put' })
				);
				assert.equal(counts.lookups, 0, 'no audit entry is read for a write the head supersedes');
				assert.ok(counts.metadataReads <= 1, `at most the floor is read; got ${counts.metadataReads}`);
				const after = T.primaryStore.getEntry(id);
				assert.deepEqual(after.value, before.value);
				assert.equal(after.version, before.version);
				assert.ok(after.metadataFlags & FULL_WRITE_HEAD);
			});

	it('keeps the walk for a write at the head’s own version, and for a patch head', async function () {
		if (isLMDB) return this.skip();
		const version = Date.now() + DAY;
		let id = newId();
		await apply(T, id, { id, name: 'head' }, { version, fullUpdate: true, logKey: version + 10 });
		// the same writer and version, an earlier log key: a distinct write ordered by key, not by version
		let counts = await lookupsDuring(T, () => apply(T, id, { name: 'same version' }, { version, logKey: version + 5 }));
		assert.ok(counts.lookups > 0, 'a tie keeps the audit path');
		assert.equal(T.primaryStore.getEntry(id).value.name, 'head');

		id = newId();
		await apply(T, id, { id, name: 'head' }, { version, fullUpdate: true });
		await apply(T, id, { count: 1 }, { version: version + 2000 });
		counts = await lookupsDuring(T, () =>
			apply(T, id, { extra: 'late' }, { version: version + 1000, nodeId: lateOrigin })
		);
		assert.ok(counts.lookups > 0, 'a patch head keeps the walk');
		assert.equal(
			T.primaryStore.getEntry(id).value.extra,
			'late',
			'and its outcome: the older field is not overwritten'
		);
	});

	it('keeps the below-floor fold, which clears the bit', async function () {
		if (isLMDB) return this.skip();
		const Floor = auditedTable();
		const origin = getIdOfRemoteNode('full-write-head-a', Floor.auditStore);
		const version = Date.now() + DAY;
		await apply(Floor, 'op', { id: 'op', name: 'head', count: 5 }, { version, nodeId: origin, fullUpdate: true });
		assert.ok(flagged(Floor, 'op'), 'premise: a flagged put');
		raiseAuditFloor(Floor.auditStore, Date.now());
		await apply(
			Floor,
			'op',
			{ count: { __op__: 'add', value: 1 } },
			{ version: Date.now() - 30 * DAY, nodeId: getIdOfRemoteNode('full-write-head-b', Floor.auditStore) }
		);
		const entry = Floor.primaryStore.getEntry('op');
		assert.equal(entry.value.count, 6, 'below the floor the commutative op still folds');
		assert.equal(entry.version, version);
		assert.equal(
			Boolean(entry.metadataFlags & FULL_WRITE_HEAD),
			false,
			'the fold changed the body at the head’s version'
		);
	});

	describe('a base-copied delete (harper-pro#1331)', () => {
		const copiedDelete = (Table, id, { version, nodeId = headOrigin, logKey = version }) =>
			fromOrigin(
				Table,
				id,
				(resource) => resource._writeDelete(id, { isNotification: true, isCopyApply: true, nodeId, version }),
				{ version, logKey }
			);
		const copiedPut = (Table, id, record, { version, nodeId = headOrigin }) =>
			fromOrigin(
				Table,
				id,
				(resource) => resource._writeUpdate(id, record, true, { isCopyApply: true, nodeId, version }),
				{ version }
			);

		it('stores a flagged tombstone at the delete’s version and origin, with no audit entry', async function () {
			if (isLMDB) return this.skip();
			const id = newId();
			const version = Date.now() + DAY;
			await copiedDelete(T, id, { version, logKey: version - 10 });
			const entry = T.primaryStore.getEntry(id);
			assert.equal(entry.value, null);
			assert.equal(entry.version, version);
			assert.equal(entry.nodeId, headOrigin);
			assert.ok(entry.metadataFlags & FULL_WRITE_HEAD, 'a delete is a full write');
			assert.equal(entry.additionalAuditRefs, undefined, 'no ref to a log entry this node does not hold');
			assert.equal(T.auditStore.getSync(version - 10, T.tableId, id, headOrigin), undefined);
			assert.equal(T.auditStore.getSync(version, T.tableId, id, headOrigin), undefined);
		});

		it('yields to a newer or equal head, and replaces an older row and its index entries', async function () {
			if (isLMDB) return this.skip();
			const Indexed = table({
				table: 'CopiedDeleteIndexed',
				database: 'fullWriteHeadCopiedDeleteIndexed',
				attributes: [
					{ name: 'id', isPrimaryKey: true },
					{ name: 'name', indexed: true },
				],
				audit: true,
			});
			const origin = getIdOfRemoteNode('full-write-head-a', Indexed.auditStore);
			const version = Date.now() + DAY;
			const byName = async (name) => {
				const ids = [];
				for await (const record of Indexed.search({ conditions: [{ attribute: 'name', value: name }] }))
					ids.push(record.id);
				return ids;
			};
			await apply(
				Indexed,
				'newer',
				{ id: 'newer', name: 'newer' },
				{ version: version + 1000, nodeId: origin, fullUpdate: true }
			);
			await apply(Indexed, 'equal', { id: 'equal', name: 'equal' }, { version, nodeId: origin, fullUpdate: true });
			await apply(
				Indexed,
				'older',
				{ id: 'older', name: 'older' },
				{ version: version - 1000, nodeId: origin, fullUpdate: true }
			);
			for (const id of ['newer', 'equal', 'older']) await copiedDelete(Indexed, id, { version, nodeId: origin });
			assert.equal(Indexed.primaryStore.getEntry('newer').value.name, 'newer');
			assert.equal(Indexed.primaryStore.getEntry('equal').value.name, 'equal');
			const older = Indexed.primaryStore.getEntry('older');
			assert.equal(older.value, null);
			assert.equal(older.version, version);
			assert.deepEqual(await byName('older'), [], 'the replaced row leaves the index');
			assert.deepEqual(await byName('newer'), ['newer']);
		});

		for (const late of ['put', 'patch', 'add'])
			it(`beats an older ${late} with no audit lookup, though no entry records the delete`, async function () {
				if (isLMDB) return this.skip();
				const id = newId();
				const version = Date.now() + DAY;
				await copiedDelete(T, id, { version });
				const record = {
					put: { id, name: 'late', count: 1 },
					patch: { name: 'late' },
					add: { count: { __op__: 'add', value: 1 } },
				}[late];
				const counts = await lookupsDuring(T, () =>
					apply(T, id, record, { version: version - 1000, nodeId: lateOrigin, fullUpdate: late === 'put' })
				);
				assert.equal(counts.lookups, 0);
				const entry = T.primaryStore.getEntry(id);
				assert.equal(entry.value, null, `the older ${late} must not recreate the row`);
				assert.equal(entry.version, version);
			});

		it('beats an older write whatever the floor', async function () {
			if (isLMDB) return this.skip();
			const Floor = auditedTable();
			const origin = getIdOfRemoteNode('full-write-head-a', Floor.auditStore);
			const late = getIdOfRemoteNode('full-write-head-b', Floor.auditStore);
			const now = Date.now();
			await copiedDelete(Floor, 'copied', { version: now + 10 * DAY, nodeId: origin });
			// its log key sits below the floor, so the floor shortcut cannot vouch for it
			await apply(
				Floor,
				'audited',
				{ id: 'audited', name: 'head' },
				{ version: now, nodeId: origin, fullUpdate: true }
			);
			await fromOrigin(
				Floor,
				'audited',
				(resource) => resource._writeDelete('audited', { version: now + 10 * DAY, nodeId: origin }),
				{ version: now + 10 * DAY, logKey: now + DAY }
			);
			raiseAuditFloor(Floor.auditStore, now + 2 * DAY);
			for (const id of ['copied', 'audited']) {
				await apply(Floor, id, { name: 'late' }, { version: now + 5 * DAY, nodeId: late });
				assert.equal(Floor.primaryStore.getEntry(id).value, null, `${id}: above the floor`);
				await apply(Floor, id, { count: { __op__: 'add', value: 1 } }, { version: now - 30 * DAY, nodeId: late });
				assert.equal(Floor.primaryStore.getEntry(id).value, null, `${id}: below the floor`);
			}
			Floor.auditStore.rootStore.removeSync(AUDIT_FLOOR_KEY);
			await Floor.auditStore.remove(AUDIT_FLOOR_KEY);
			assert.equal(getAuditFloor(Floor.auditStore), Infinity, 'premise: the floor reads as unknown');
			for (const id of ['copied', 'audited']) {
				await apply(Floor, id, { name: 'late' }, { version: now + 5 * DAY, nodeId: late });
				assert.equal(Floor.primaryStore.getEntry(id).value, null, `${id}: unknown floor`);
			}
		});

		it('leaves a publish-only head to the walk, so an older patch newer than the delete still applies', async function () {
			if (isLMDB) return this.skip();
			const id = newId();
			const version = Date.now() + DAY;
			await apply(T, id, { id, name: 'head' }, { version, fullUpdate: true });
			await remove(T, id, { version: version + 1 });
			await fromOrigin(
				T,
				id,
				(resource) =>
					resource._writePublish(
						id,
						{ message: 'hello' },
						{ isNotification: true, nodeId: headOrigin, version: version + 3 }
					),
				{ version: version + 3 }
			);
			const head = T.primaryStore.getEntry(id);
			assert.equal(head.value, null);
			assert.equal(Boolean(head.metadataFlags & FULL_WRITE_HEAD), false, 'premise: a publish clears the bit');
			await apply(T, id, { name: 'between' }, { version: version + 2, nodeId: lateOrigin });
			assert.equal(T.primaryStore.getEntry(id).value?.name, 'between');
		});

		it('reclaims the replaced row’s blob files, as a copied put does', async function () {
			if (isLMDB) return this.skip();
			const Blobs = table({
				table: 'CopiedDeleteBlobs',
				database: 'fullWriteHeadCopiedDeleteBlobs',
				attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'payload' }],
				audit: true,
			});
			const origin = getIdOfRemoteNode('full-write-head-a', Blobs.auditStore);
			const version = Date.now() + DAY;
			const blobPath = (id) => getFilePathForBlob(Blobs.primaryStore.getSync(id).payload);
			for (const id of ['copied', 'deleted'])
				await copiedPut(Blobs, id, { id, payload: createBlob(randomBytes(25000)) }, { version, nodeId: origin });
			const paths = { copied: blobPath('copied'), deleted: blobPath('deleted') };
			await waitFor(() => existsSync(paths.copied) && existsSync(paths.deleted), {
				timeout: 5000,
				message: 'premise: file-backed blobs',
			});
			setDeletionDelay(0);
			try {
				await copiedDelete(Blobs, 'copied', { version: version + 1, nodeId: origin });
				await remove(Blobs, 'deleted', { version: version + 1, nodeId: origin });
				await waitFor(() => !existsSync(paths.deleted) && !existsSync(paths.copied), {
					timeout: 5000,
					message: () =>
						`reclaimed: audited delete ${!existsSync(paths.deleted)}, copied delete ${!existsSync(paths.copied)}`,
				});
			} finally {
				setDeletionDelay(undefined);
			}
		});

		describe('after a later write onto the tombstone (F-1243, harper#4245)', () => {
			const publish = (Table, id, { version, nodeId = headOrigin }) =>
				fromOrigin(
					Table,
					id,
					(resource) => resource._writePublish(id, { message: 'hello' }, { isNotification: true, nodeId, version }),
					{ version }
				);
			const older = {
				put: (id) => ({ record: { id, extra: 'old' }, fullUpdate: true }),
				patch: () => ({ record: { extra: 'old' }, fullUpdate: false }),
				add: () => ({ record: { count: { __op__: 'add', value: 1 } }, fullUpdate: false }),
			};

			for (const late of Object.keys(older))
				it(`an older ${late} loses after a newer patch recreated the row`, async function () {
					if (isLMDB) return this.skip();
					const id = newId();
					const version = Date.now() + DAY;
					await copiedDelete(T, id, { version });
					await apply(T, id, { name: 'newer' }, { version: version + 2000 });
					assert.deepEqual(
						{ ...T.primaryStore.getEntry(id).value },
						{ id, name: 'newer' },
						'premise: patch onto nothing'
					);
					const { record, fullUpdate } = older[late](id);
					await apply(T, id, record, { version: version - 1000, nodeId: lateOrigin, fullUpdate });
					assert.deepEqual({ ...T.primaryStore.getEntry(id).value }, { id, name: 'newer' });
				});

			for (const late of Object.keys(older))
				it(`an older ${late} loses after a publish onto the tombstone`, async function () {
					if (isLMDB) return this.skip();
					const id = newId();
					const version = Date.now() + DAY;
					await copiedDelete(T, id, { version });
					await publish(T, id, { version: version + 3 });
					const { record, fullUpdate } = older[late](id);
					await apply(T, id, record, { version: version - 1000, nodeId: lateOrigin, fullUpdate });
					assert.equal(T.primaryStore.getEntry(id).value, null, `the older ${late} must not recreate the row`);
				});

			it('an older patch loses after a publish and then a newer patch', async function () {
				if (isLMDB) return this.skip();
				const id = newId();
				const version = Date.now() + DAY;
				await copiedDelete(T, id, { version });
				await publish(T, id, { version: version + 3 });
				await apply(T, id, { name: 'newer' }, { version: version + 2000 });
				await apply(T, id, { extra: 'old' }, { version: version - 1000, nodeId: lateOrigin });
				assert.deepEqual({ ...T.primaryStore.getEntry(id).value }, { id, name: 'newer' });
			});

			it('a write newer than the delete but older than the head still merges', async function () {
				if (isLMDB) return this.skip();
				const patched = newId();
				const put = newId();
				const version = Date.now() + DAY;
				for (const id of [patched, put]) {
					await copiedDelete(T, id, { version });
					await apply(T, id, { name: 'newer' }, { version: version + 2000 });
				}
				await apply(T, patched, { extra: 'between' }, { version: version + 1000, nodeId: lateOrigin });
				assert.deepEqual(
					{ ...T.primaryStore.getEntry(patched).value },
					{ id: patched, name: 'newer', extra: 'between' }
				);
				await apply(
					T,
					put,
					{ id: put, extra: 'between' },
					{ version: version + 1000, nodeId: lateOrigin, fullUpdate: true }
				);
				assert.deepEqual({ ...T.primaryStore.getEntry(put).value }, { id: put, name: 'newer', extra: 'between' });
			});

			it('keeps the boundary through patches and publishes, and drops it at an audited put', async function () {
				if (isLMDB) return this.skip();
				const id = newId();
				const version = Date.now() + DAY;
				const boundary = () => T.primaryStore.getEntry(id).copiedDeleteBoundary;
				await copiedDelete(T, id, { version });
				assert.deepEqual(boundary(), { version, nodeId: headOrigin });
				await publish(T, id, { version: version + 3 });
				assert.deepEqual(boundary(), { version, nodeId: headOrigin }, 'after a publish');
				await apply(T, id, { name: 'newer' }, { version: version + 2000 });
				assert.deepEqual(boundary(), { version, nodeId: headOrigin }, 'after a patch');
				await apply(T, id, { extra: 'between' }, { version: version + 1000, nodeId: lateOrigin });
				assert.deepEqual(boundary(), { version, nodeId: headOrigin }, 'after an out-of-order merge');
				await apply(T, id, { id, name: 'put' }, { version: version + 3000, fullUpdate: true });
				assert.equal(boundary(), undefined, 'an audited put records its own entry');
			});

			it('loses below the audit floor too', async function () {
				if (isLMDB) return this.skip();
				const Floor = auditedTable();
				const origin = getIdOfRemoteNode('full-write-head-a', Floor.auditStore);
				const late = getIdOfRemoteNode('full-write-head-b', Floor.auditStore);
				const now = Date.now();
				await copiedDelete(Floor, 'copied', { version: now + 10 * DAY, nodeId: origin });
				await apply(Floor, 'copied', { name: 'newer' }, { version: now + 11 * DAY, nodeId: origin });
				raiseAuditFloor(Floor.auditStore, now + 2 * DAY);
				await apply(Floor, 'copied', { count: { __op__: 'add', value: 1 } }, { version: now, nodeId: late });
				assert.deepEqual({ ...Floor.primaryStore.getEntry('copied').value }, { id: 'copied', name: 'newer' });
			});

			it('orders an equal-version write from another origin by node name, as the source does', async function () {
				if (isLMDB) return this.skip();
				const id = newId();
				const version = Date.now() + DAY;
				const lowerName = getIdOfRemoteNode('full-write-head-0', T.auditStore);
				await copiedDelete(T, id, { version });
				await apply(T, id, { name: 'newer' }, { version: version + 2000 });
				await apply(T, id, { extra: 'tie' }, { version, nodeId: lowerName });
				assert.deepEqual({ ...T.primaryStore.getEntry(id).value }, { id, name: 'newer' });
			});

			it('keeps the boundary when out-of-order merges overflow the ref budget', async function () {
				if (isLMDB) return this.skip();
				const id = newId();
				const version = Date.now() + DAY;
				await copiedDelete(T, id, { version });
				await apply(T, id, { name: 'newer' }, { version: version + 2000 });
				for (let i = 1; i <= 30; i++)
					await apply(T, id, { count: { __op__: 'add', value: 1 } }, { version: version + i, nodeId: lateOrigin });
				const entry = T.primaryStore.getEntry(id);
				assert.ok(entry.additionalAuditRefs.length < 30, 'premise: the encoder trimmed refs');
				assert.deepEqual(entry.copiedDeleteBoundary, { version, nodeId: headOrigin });
				await apply(T, id, { extra: 'old' }, { version: version - 1000, nodeId: lateOrigin });
				assert.deepEqual({ ...T.primaryStore.getEntry(id).value }, { id, name: 'newer', count: 30 });
			});

			it('records a copied delete that arrives after a newer write, so older writes still lose', async function () {
				if (isLMDB) return this.skip();
				const id = newId();
				const version = Date.now() + DAY;
				await apply(T, id, { name: 'newer' }, { version: version + 2000 });
				await copiedDelete(T, id, { version });
				const head = T.primaryStore.getEntry(id);
				assert.equal(head.version, version + 2000, 'the newer write keeps the row');
				assert.equal(head.metadataFlags & VERSION_REUSED, 0, 'the unchanged value keeps its version');
				assert.deepEqual(head.copiedDeleteBoundary, { version, nodeId: headOrigin });
				await apply(T, id, { extra: 'old' }, { version: version - 1000, nodeId: lateOrigin });
				await apply(T, id, { extra: 'between' }, { version: version + 1000, nodeId: lateOrigin });
				assert.deepEqual({ ...T.primaryStore.getEntry(id).value }, { id, name: 'newer', extra: 'between' });
			});

			it('holds when an older publish moves the head below the delete', async function () {
				if (isLMDB) return this.skip();
				const id = newId();
				const version = Date.now() + DAY;
				await copiedDelete(T, id, { version });
				await publish(T, id, { version: version - 2000 });
				await apply(T, id, { extra: 'old' }, { version: version - 1000, nodeId: lateOrigin });
				assert.equal(T.primaryStore.getEntry(id).value, null);
			});

			describe('an invalidation or relocation under a head the delete is above', () => {
				const ELSEWHERE = 8;
				const writes = {
					'an invalidation': (id, { version, nodeId }) =>
						fromOrigin(
							T,
							id,
							(resource) =>
								resource._writeInvalidate(id, { name: 'projected' }, { isNotification: true, nodeId, version }),
							{ version }
						),
					'a relocation': (id, { version, nodeId }) =>
						fromOrigin(
							T,
							id,
							(resource) =>
								resource._writeRelocate(id, { isNotification: true, nodeId, version, residencyId: ELSEWHERE }),
							{ version }
						),
				};
				before(() => T.dbisDB.putSync([Symbol.for('residency_by_id'), ELSEWHERE], ['full-write-head-elsewhere']));
				async function tombstoneUnderPublish(version) {
					const id = newId();
					await copiedDelete(T, id, { version });
					await publish(T, id, { version: version - 2000 });
					return id;
				}

				for (const kind of Object.keys(writes)) {
					it(`${kind} older than the delete loses, from an origin on either side of the delete's`, async function () {
						if (isLMDB) return this.skip();
						const version = Date.now() + DAY;
						const lower = getIdOfRemoteNode('full-write-head-0', T.auditStore);
						for (const late of [
							{ version: version - 1000, nodeId: lateOrigin },
							{ version: version - 1000, nodeId: lower },
							{ version, nodeId: lower },
						]) {
							const id = await tombstoneUnderPublish(version);
							await writes[kind](id, late);
							const entry = T.primaryStore.getEntry(id);
							const label = `${kind} at ${late.version - version} from ${late.nodeId}`;
							assert.equal(entry.value, null, label);
							assert.equal(entry.version, version - 2000, `${label} must leave the head`);
							assert.equal(entry.metadataFlags & INVALIDATED, 0, label);
							assert.deepEqual(entry.copiedDeleteBoundary, { version, nodeId: headOrigin }, label);
						}
					});

					it(`${kind} the delete precedes lands and keeps the boundary`, async function () {
						if (isLMDB) return this.skip();
						const version = Date.now() + DAY;
						const id = await tombstoneUnderPublish(version);
						await writes[kind](id, { version, nodeId: lateOrigin });
						const entry = T.primaryStore.getEntry(id);
						assert.equal(entry.version, version);
						assert.ok(entry.metadataFlags & INVALIDATED);
						assert.deepEqual(entry.copiedDeleteBoundary, { version, nodeId: headOrigin });
						await apply(T, id, { extra: 'old' }, { version: version - 1000, nodeId: lateOrigin });
						assert.equal(T.primaryStore.getEntry(id).version, version, 'an older write still loses');
					});
				}
			});

			for (const kind of ['patch', 'add'])
				it(`an older ${kind} loses on an invalidated head too`, async function () {
					if (isLMDB) return this.skip();
					const id = newId();
					const version = Date.now() + DAY;
					await copiedDelete(T, id, { version });
					await apply(T, id, { name: 'newer' }, { version: version + 2000 });
					await fromOrigin(
						T,
						id,
						(resource) =>
							resource._writeInvalidate(id, undefined, {
								isNotification: true,
								nodeId: headOrigin,
								version: version + 3000,
							}),
						{ version: version + 3000 }
					);
					const stub = T.primaryStore.getEntry(id);
					assert.ok(stub.metadataFlags & INVALIDATED, 'premise: an invalidated head');
					assert.deepEqual(
						stub.copiedDeleteBoundary,
						{ version, nodeId: headOrigin },
						'premise: it keeps the boundary'
					);
					const before = { ...stub.value };
					await apply(T, id, kind === 'patch' ? { extra: 'old' } : { count: { __op__: 'add', value: 1 } }, {
						version: version - 1000,
						nodeId: lateOrigin,
					});
					assert.deepEqual(
						{ ...T.primaryStore.getEntry(id).value },
						before,
						`the older ${kind} must not fold into the stub`
					);
				});

			it('holds for an older write batched after a newer one in one transaction', async function () {
				if (isLMDB) return this.skip();
				const id = newId();
				const version = Date.now() + DAY;
				await copiedDelete(T, id, { version });
				await fromOrigin(
					T,
					id,
					async (resource) => {
						resource._writeUpdate(id, { name: 'newer' }, false, {
							isNotification: true,
							nodeId: headOrigin,
							version: version + 2000,
						});
						resource._writeUpdate(id, { extra: 'old' }, false, {
							isNotification: true,
							nodeId: lateOrigin,
							version: version - 1000,
						});
					},
					{ version: version + 2000 }
				);
				assert.deepEqual({ ...T.primaryStore.getEntry(id).value }, { id, name: 'newer' });
				assert.deepEqual(T.primaryStore.getEntry(id).copiedDeleteBoundary, { version, nodeId: headOrigin });
			});

			it('keeps the boundary under an older publish when a lower delete arrives', async function () {
				if (isLMDB) return this.skip();
				const audited = newId();
				const copied = newId();
				const version = Date.now() + DAY;
				for (const id of [audited, copied]) {
					await copiedDelete(T, id, { version });
					await publish(T, id, { version: version - 3000 });
				}
				await remove(T, audited, { version: version - 2000 });
				await copiedDelete(T, copied, { version: version - 2000 });
				for (const id of [audited, copied]) {
					assert.deepEqual(T.primaryStore.getEntry(id).copiedDeleteBoundary, { version, nodeId: headOrigin }, id);
					await apply(T, id, { extra: 'old' }, { version: version - 1000, nodeId: lateOrigin });
					assert.equal(T.primaryStore.getEntry(id).value, null, `${id}: the stronger delete still holds`);
				}
			});

			it('a lower delete loses after a newer write recreated the row and an older publish lowered its head', async function () {
				if (isLMDB) return this.skip();
				const audited = newId();
				const copied = newId();
				const version = Date.now() + DAY;
				for (const id of [audited, copied]) {
					await copiedDelete(T, id, { version });
					await apply(T, id, { name: 'newer' }, { version: version + 2000 });
					await publish(T, id, { version: version - 3000 });
					const head = T.primaryStore.getEntry(id);
					assert.equal(head.version, version - 3000, 'premise: the publish lowered the head');
					assert.deepEqual({ ...head.value }, { id, name: 'newer' }, 'premise: and kept the body');
				}
				await remove(T, audited, { version: version - 2000, nodeId: lateOrigin });
				await copiedDelete(T, copied, { version: version - 2000, nodeId: lateOrigin });
				for (const id of [audited, copied]) {
					assert.deepEqual({ ...T.primaryStore.getEntry(id).value }, { id, name: 'newer' }, id);
					assert.deepEqual(T.primaryStore.getEntry(id).copiedDeleteBoundary, { version, nodeId: headOrigin }, id);
				}
			});

			it('stamps an equal-version delete from an origin that orders after the stored one', async function () {
				if (isLMDB) return this.skip();
				const id = newId();
				const version = Date.now() + DAY;
				const lower = getIdOfRemoteNode('full-write-head-0', T.auditStore);
				await apply(T, id, { name: 'newer' }, { version: version + 2000 });
				await copiedDelete(T, id, { version, nodeId: lower });
				await copiedDelete(T, id, { version, nodeId: lateOrigin });
				assert.deepEqual(T.primaryStore.getEntry(id).copiedDeleteBoundary, { version, nodeId: lateOrigin });
				await copiedDelete(T, id, { version, nodeId: lower });
				assert.deepEqual(T.primaryStore.getEntry(id).copiedDeleteBoundary, { version, nodeId: lateOrigin });
			});

			it('a record-less write over a delete this node made keeps that delete as the boundary', async function () {
				if (isLMDB) return this.skip();
				const id = newId();
				await T.put(id, { id, name: 'gone' });
				await T.delete(id);
				const version = T.primaryStore.getEntry(id).version;
				await T.publish(id, { message: 'no record' });
				const head = T.primaryStore.getEntry(id);
				assert.equal(head.value, null);
				assert.equal(head.metadataFlags & FULL_WRITE_HEAD, 0);
				assert.deepEqual(head.copiedDeleteBoundary, { version, nodeId: 0 });
				await T.publish(id, { message: 'again' });
				assert.deepEqual(T.primaryStore.getEntry(id).copiedDeleteBoundary, { version, nodeId: 0 });
				await apply(T, id, { name: 'older' }, { version: version - 1000, fullUpdate: true });
				assert.equal(T.primaryStore.getEntry(id).value, null, 'a write the delete precedes loses');
			});

			it('an invalidation over a delete this node made keeps that delete as the boundary', async function () {
				if (isLMDB) return this.skip();
				const id = newId();
				await T.put(id, { id, name: 'gone' });
				await T.delete(id);
				const version = T.primaryStore.getEntry(id).version;
				await T.invalidate(id);
				assert.deepEqual(T.primaryStore.getEntry(id).copiedDeleteBoundary, { version, nodeId: 0 });
			});

			it('a record-less write over a delete keeps that delete, not an older copied one stamped on it', async function () {
				if (isLMDB) return this.skip();
				const id = newId();
				const version = Date.now() + DAY;
				await apply(T, id, { name: 'alive' }, { version: version - 5000 });
				await remove(T, id, { version: version + 2000 });
				await copiedDelete(T, id, { version });
				assert.deepEqual(T.primaryStore.getEntry(id).copiedDeleteBoundary, { version, nodeId: headOrigin }, 'premise');
				await publish(T, id, { version: version - 500 });
				assert.deepEqual(T.primaryStore.getEntry(id).copiedDeleteBoundary, {
					version: version + 2000,
					nodeId: headOrigin,
				});
				await apply(T, id, { name: 'between' }, { version: version + 1000, nodeId: lateOrigin });
				assert.equal(T.primaryStore.getEntry(id).value, null, 'a write the newer delete precedes still loses');
			});

			it('a copied put over a delete keeps that delete, not an older copied one stamped on it', async function () {
				if (isLMDB) return this.skip();
				const stamped = newId();
				const plain = newId();
				const version = Date.now() + DAY;
				for (const id of [stamped, plain]) {
					await apply(T, id, { name: 'alive' }, { version: version - 5000 });
					await remove(T, id, { version: version + 2000 });
				}
				await copiedDelete(T, stamped, { version });
				for (const id of [stamped, plain]) {
					await copiedPut(T, id, { id, name: 'copied' }, { version: version + 3000 });
					assert.deepEqual(T.primaryStore.getEntry(id).copiedDeleteBoundary, {
						version: version + 2000,
						nodeId: headOrigin,
					});
					await apply(T, id, { extra: 'between' }, { version: version + 1000, nodeId: lateOrigin });
					assert.deepEqual({ ...T.primaryStore.getEntry(id).value }, { id, name: 'copied' }, 'the delete precedes it');
				}
			});

			it('carries the boundary through a direct update that passes no metadata flags', async function () {
				if (isLMDB) return this.skip();
				const id = newId();
				const version = Date.now() + DAY;
				await copiedDelete(T, id, { version });
				await apply(T, id, { name: 'newer' }, { version: version + 2000 });
				const head = T.primaryStore.getEntry(id);
				recordUpdater(T.primaryStore, T.tableId, T.auditStore)(
					id,
					{ id, name: 'direct' },
					head,
					version + 3000,
					undefined,
					false,
					{
						nodeId: headOrigin,
					}
				);
				await T.primaryStore.committed;
				const entry = T.primaryStore.getEntry(id);
				assert.equal(entry.value.name, 'direct');
				assert.equal(entry.nodeId, headOrigin);
				assert.deepEqual(entry.copiedDeleteBoundary, { version, nodeId: headOrigin });
			});

			it('a relocation over a delete this node made keeps that delete as the boundary', async function () {
				if (isLMDB) return this.skip();
				const id = newId();
				await T.put(id, { id, name: 'gone' });
				await T.delete(id);
				const version = T.primaryStore.getEntry(id).version;
				T.dbisDB.putSync([Symbol.for('residency_by_id'), 8], ['full-write-head-elsewhere']);
				const context = {};
				await transaction(context, async () =>
					(await T.getResource(id, context, { ensureLoaded: false }))._writeRelocate(id, { residencyId: 8 })
				);
				const head = T.primaryStore.getEntry(id);
				assert.ok(head.metadataFlags & INVALIDATED, 'premise: relocated away');
				assert.deepEqual(head.copiedDeleteBoundary, { version, nodeId: 0 });
			});

			it('a publish over a head that is not a delete adds no boundary', async function () {
				if (isLMDB) return this.skip();
				const id = newId();
				await T.put(id, { id, name: 'alive' });
				await T.publish(id, { message: 'no record' });
				assert.equal(T.primaryStore.getEntry(id).copiedDeleteBoundary, undefined);
			});

			it('holds across writes in one transaction', async function () {
				if (isLMDB) return this.skip();
				const id = newId();
				const version = Date.now() + DAY;
				await copiedDelete(T, id, { version });
				await fromOrigin(
					T,
					id,
					async (resource) => {
						resource._writeUpdate(id, { name: 'newer' }, false, {
							isNotification: true,
							nodeId: headOrigin,
							version: version + 2000,
						});
						resource._writeUpdate(id, { count: 2 }, false, {
							isNotification: true,
							nodeId: headOrigin,
							version: version + 2000,
						});
					},
					{ version: version + 2000 }
				);
				assert.deepEqual(T.primaryStore.getEntry(id).copiedDeleteBoundary, { version, nodeId: headOrigin });
				await apply(T, id, { extra: 'old' }, { version: version - 1000, nodeId: lateOrigin });
				assert.deepEqual({ ...T.primaryStore.getEntry(id).value }, { id, name: 'newer', count: 2 });
			});

			it('a put onto the row ends the boundary: older writes lose to it through the walk', async function () {
				if (isLMDB) return this.skip();
				const id = newId();
				const version = Date.now() + DAY;
				await copiedDelete(T, id, { version });
				await apply(T, id, { name: 'newer' }, { version: version + 2000 });
				await apply(T, id, { id, name: 'put' }, { version: version + 3000, fullUpdate: true });
				await apply(T, id, { extra: 'old' }, { version: version - 1000, nodeId: lateOrigin });
				await apply(T, id, { extra: 'between' }, { version: version + 2500, nodeId: lateOrigin });
				assert.deepEqual({ ...T.primaryStore.getEntry(id).value }, { id, name: 'put' });
			});
		});
	});

	it('keeps the walk when the head’s own log entry is older than the floor, or the floor is unknown', async function () {
		if (isLMDB) return this.skip();
		const Floor = auditedTable();
		const origin = getIdOfRemoteNode('full-write-head-a', Floor.auditStore);
		const late = getIdOfRemoteNode('full-write-head-b', Floor.auditStore);
		const now = Date.now();
		// the put's log key sits below its record version (diverged clocks), so the floor can pass it alone
		await apply(
			Floor,
			'diverged',
			{ id: 'diverged', name: 'head' },
			{ version: now + 10 * DAY, logKey: now + DAY, nodeId: origin, fullUpdate: true }
		);
		assert.ok(flagged(Floor, 'diverged'), 'premise: a flagged put');
		raiseAuditFloor(Floor.auditStore, now + 2 * DAY);
		let counts = await lookupsDuring(Floor, () =>
			apply(Floor, 'diverged', { extra: 'late' }, { version: now + 5 * DAY, nodeId: late })
		);
		assert.ok(counts.lookups > 0, 'a head the floor may have purged is resolved by the walk');

		await apply(
			Floor,
			'unknown',
			{ id: 'unknown', name: 'head' },
			{ version: now + 20 * DAY, nodeId: origin, fullUpdate: true }
		);
		Floor.auditStore.rootStore.removeSync(AUDIT_FLOOR_KEY);
		await Floor.auditStore.remove(AUDIT_FLOOR_KEY);
		assert.equal(getAuditFloor(Floor.auditStore), Infinity, 'premise: the floor reads as unknown');
		counts = await lookupsDuring(Floor, () =>
			apply(Floor, 'unknown', { extra: 'late' }, { version: now + 15 * DAY, nodeId: late })
		);
		assert.ok(counts.lookups > 0, 'an unknown floor proves nothing retained');
	});
});
